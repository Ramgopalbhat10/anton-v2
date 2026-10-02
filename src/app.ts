import { createAgentRouter } from '@flue/runtime/routing';
import { type Context, Hono } from 'hono';
import * as v from 'valibot';
import { Coder } from './agents/coder.ts';
import { config } from './config.ts';
import { InvalidInputError, statusOf } from './core/errors.ts';
import { REASONING_LEVELS } from './core/ports.ts';
import { publishUpgradeHandler } from './core/upgrades.ts';
import { getProviders } from './providers/index.ts';
import { listModels } from './services/models.ts';
import { changesView, fileTree, outputsView, readFile, readOutputFile } from './services/files.ts';
import { addProject, branches, projects } from './services/projects.ts';
import {
	createSession,
	getSession,
	listSessions,
	primeModel,
	resumeSession,
	setModel,
	stopSession,
} from './services/sessions.ts';
import { handleTerminalUpgrade } from './services/terminal.ts';

const app = new Hono();

const REASONING = v.picklist(REASONING_LEVELS);

publishUpgradeHandler(handleTerminalUpgrade);

async function body<T extends v.GenericSchema>(c: Context, schema: T): Promise<v.InferOutput<T>> {
	const result = v.safeParse(schema, await c.req.json().catch(() => ({})));
	if (!result.success) throw new InvalidInputError(result.issues.map((issue) => issue.message).join('; '));
	return result.output;
}

/** Images render inline; everything else downloads, so agent-written HTML never runs on this origin. */
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const contentType = (path: string) => IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

function bytes(c: Context, data: Uint8Array | null, type = 'application/octet-stream') {
	if (!data) return c.json({ error: 'Not found' }, 404);
	return c.body(data as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
}

app.onError((error, c) => {
	const status = statusOf(error);
	if (status >= 500) console.error('[anton]', error);
	return c.json({ error: error.message }, status as 400);
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

app.get('/api/models', async (c) => c.json({ models: await listModels(), default: config.model }));

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
			reasoning: v.optional(REASONING),
			title: v.optional(v.pipe(v.string(), v.maxLength(200))),
		}),
	);
	return c.json(await createSession(input));
});
app.get('/api/sessions/:id', async (c) => c.json(await getSession(c.req.param('id'))));
app.patch('/api/sessions/:id', async (c) => {
	const change = await body(c, v.object({ model: v.optional(v.string()), reasoning: v.optional(v.nullable(REASONING)) }));
	return c.json(await setModel(c.req.param('id'), change));
});
app.post('/api/sessions/:id/stop', async (c) => c.json(await stopSession(c.req.param('id'))));
app.post('/api/sessions/:id/resume', async (c) => c.json(await resumeSession(c.req.param('id'))));

app.get('/api/sessions/:id/changes', async (c) => c.json(await changesView(c.req.param('id'))));
app.get('/api/sessions/:id/files', async (c) => c.json(await fileTree(c.req.param('id'))));
app.get('/api/sessions/:id/file', async (c) => bytes(c, await readFile(c.req.param('id'), c.req.query('path') ?? '')));
app.get('/api/sessions/:id/outputs', async (c) => c.json(await outputsView(c.req.param('id'))));
app.get('/api/sessions/:id/output', async (c) => {
	const path = c.req.query('path') ?? '';
	return bytes(c, await readOutputFile(c.req.param('id'), path), contentType(path));
});

export default app;
