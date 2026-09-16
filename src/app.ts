import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Coder } from './agents/coder.ts';
import { migrateAppDb } from './lib/db-app.ts';
import { hasOpenRouter } from './lib/env.ts';
import { OPENROUTER_MODELS } from './lib/models.ts';
import {
	createSession,
	ensureDevProject,
	getProject,
	getSession,
	listSessions,
	stopSession,
	updateSessionModel,
} from './lib/sessions.ts';
import { gitStatus, listPaths, readWorkspaceFile } from './lib/vm-proxy.ts';

const app = new Hono();

let ready: Promise<void> | null = null;
function ensureReady() {
	ready ??= (async () => {
		await migrateAppDb();
		await ensureDevProject();
	})();
	return ready;
}

app.use(
	'*',
	cors({
		origin: ['http://127.0.0.1:43127', 'http://localhost:43127'],
		allowHeaders: ['Content-Type', 'Authorization'],
		allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
	}),
);

app.use('*', async (c, next) => {
	await ensureReady();
	return next();
});

app.route('/api/agents/coder', createAgentRouter(Coder) as never);

app.get('/api/health', (c) =>
	c.json({
		ok: true,
		name: 'anton-v2',
		openRouter: hasOpenRouter(),
	}),
);

app.get('/api/models', (c) => c.json({ models: OPENROUTER_MODELS }));

app.get('/api/sessions', async (c) => {
	const sessions = await listSessions();
	const project = await ensureDevProject();
	return c.json({ sessions, project });
});

app.post('/api/sessions', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const session = await createSession({
		projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
		model: typeof body.model === 'string' ? body.model : undefined,
		title: typeof body.title === 'string' ? body.title : undefined,
	});
	return c.json(session);
});

app.get('/api/sessions/:id', async (c) => {
	const session = await getSession(c.req.param('id'));
	if (!session) return c.json({ error: 'Session not found' }, 404);
	const project = await getProject(session.projectId);
	return c.json({ session, project });
});

app.patch('/api/sessions/:id', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	if (typeof body.model === 'string') {
		const session = await updateSessionModel(c.req.param('id'), body.model);
		return c.json(session);
	}
	return c.json({ error: 'Nothing to update' }, 400);
});

app.post('/api/sessions/:id/stop', async (c) => {
	const session = await stopSession(c.req.param('id'));
	return c.json(session);
});

app.get('/api/vm/:id/git', async (c) => {
	const session = await getSession(c.req.param('id'));
	if (!session) return c.json({ error: 'Session not found' }, 404);
	const project = await getProject(session.projectId);
	if (!project) return c.json({ error: 'Project not found' }, 404);
	if (session.status !== 'running') return c.json({ error: 'VM unavailable' }, 409);
	const git = await gitStatus(project.workspacePath);
	return c.json({
		repo: project.repoFullName,
		...git,
	});
});

app.get('/api/vm/:id/fs', async (c) => {
	const session = await getSession(c.req.param('id'));
	if (!session) return c.json({ error: 'Session not found' }, 404);
	const project = await getProject(session.projectId);
	if (!project) return c.json({ error: 'Project not found' }, 404);
	if (session.status !== 'running') return c.json({ error: 'VM unavailable' }, 409);
	const paths = await listPaths(project.workspacePath);
	return c.json({ cwd: project.workspacePath, paths });
});

app.get('/api/vm/:id/file', async (c) => {
	const session = await getSession(c.req.param('id'));
	if (!session) return c.json({ error: 'Session not found' }, 404);
	const project = await getProject(session.projectId);
	if (!project) return c.json({ error: 'Project not found' }, 404);
	const rel = c.req.query('path');
	if (!rel) return c.json({ error: 'path required' }, 400);
	const contents = await readWorkspaceFile(project.workspacePath, rel);
	return c.json({ path: rel, contents });
});

export default app;
