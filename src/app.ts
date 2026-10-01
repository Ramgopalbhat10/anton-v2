import { createAgentRouter } from '@flue/runtime/routing';
import { type Context, Hono } from 'hono';
import * as v from 'valibot';
import { Coder } from './agents/coder.ts';
import { config } from './config.ts';
import { MODELS } from './lib/models.ts';
import { getProviders } from './providers/index.ts';
import { changesView, fileTree, outputsView, readFile, readOutputFile } from './services/files.ts';
import { addProject, branches, projects } from './services/projects.ts';
import {
	NotFoundError,
	createSession,
	getSession,
	listSessions,
	primeModel,
	resumeSession,
	setModel,
	stopSession,
} from './services/sessions.ts';

const app = new Hono();

async function body<T extends v.GenericSchema>(c: Context, schema: T): Promise<v.InferOutput<T>> {
	const result = v.safeParse(schema, await c.req.json().catch(() => ({})));
	if (!result.success) throw new BadRequest(result.issues.map((issue) => issue.message).join('; '));
	return result.output;
}

class BadRequest extends Error {}

function bytes(c: Context, data: Uint8Array | null) {
	if (!data) return c.json({ error: 'Not found' }, 404);
	return c.body(data as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'application/octet-stream' });
}

app.onError((error, c) => {
	const status = error instanceof NotFoundError ? 404 : error instanceof BadRequest ? 400 : 500;
	if (status === 500) console.error('[anton]', error);
	return c.json({ error: error.message }, status);
});

// Each prompt reads the session's current model before the agent renders.
app.post('/api/agents/coder/:id', async (c, next) => {
	await primeModel(c.req.param('id'));
	await next();
});
app.route('/api/agents/coder', createAgentRouter(Coder) as never);

app.get('/api/health', (c) =>
	c.json({
		ok: true,
		openRouter: config.hasOpenRouter(),
		providers: { sandbox: getProviders().sandbox.name, store: getProviders().store.name, git: getProviders().git.name },
	}),
);

app.get('/api/models', (c) => c.json({ models: MODELS }));

app.get('/api/projects', async (c) => c.json({ projects: await projects() }));
app.post('/api/projects', async (c) => {
	const { repo } = await body(c, v.object({ repo: v.pipe(v.string(), v.trim(), v.minLength(3)) }));
	return c.json(await addProject(repo));
});
app.get('/api/projects/:id/branches', async (c) => c.json({ branches: await branches(c.req.param('id')) }));

app.get('/api/sessions', async (c) => c.json({ sessions: await listSessions() }));
app.post('/api/sessions', async (c) => {
	const input = await body(
		c,
		v.object({
			projectId: v.string(),
			branch: v.optional(v.string()),
			model: v.optional(v.string()),
			title: v.optional(v.pipe(v.string(), v.maxLength(200))),
		}),
	);
	return c.json(await createSession(input));
});
app.get('/api/sessions/:id', async (c) => c.json(await getSession(c.req.param('id'))));
app.patch('/api/sessions/:id', async (c) => {
	const { model } = await body(c, v.object({ model: v.string() }));
	return c.json(await setModel(c.req.param('id'), model));
});
app.post('/api/sessions/:id/stop', async (c) => c.json(await stopSession(c.req.param('id'))));
app.post('/api/sessions/:id/resume', async (c) => c.json(await resumeSession(c.req.param('id'))));

app.get('/api/sessions/:id/changes', async (c) => c.json(await changesView(c.req.param('id'))));
app.get('/api/sessions/:id/files', async (c) => c.json(await fileTree(c.req.param('id'))));
app.get('/api/sessions/:id/file', async (c) => bytes(c, await readFile(c.req.param('id'), c.req.query('path') ?? '')));
app.get('/api/sessions/:id/outputs', async (c) => c.json(await outputsView(c.req.param('id'))));
app.get('/api/sessions/:id/output', async (c) => bytes(c, await readOutputFile(c.req.param('id'), c.req.query('path') ?? '')));

export default app;
