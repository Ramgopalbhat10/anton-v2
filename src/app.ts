import { dispatch, observe } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as v from 'valibot';
import { Coder } from './agents/coder.ts';
import { config } from './config.ts';
import { type Change, onChange } from './core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError, statusOf } from './core/errors.ts';
import { appDb } from './db/client.ts';
import { getSessionRecord } from './db/sessions.ts';
import { REASONING_LEVELS } from './core/ports.ts';
import { publishUpgradeHandler } from './core/upgrades.ts';
import { getProviders } from './providers/index.ts';
import { recordAgentEvent, setAgentAbort } from './services/activity.ts';
import { listModels } from './services/models.ts';
import { changesView, fileTree, outputsView, readFile, readOutputFile } from './services/files.ts';
import { addProject, branches, projects, updateSettings } from './services/projects.ts';
import {
	createSession,
	getSession,
	listSessions,
	deleteSession,
	editSession,
	resumeSession,
	stopSession,
} from './services/sessions.ts';
import { listCheckpoints, readCheckpointPatchAt } from './services/checkpoints.ts';
import { previewsView } from './services/previews.ts';
import { isRestoring, restoreCheckpoint } from './services/restore.ts';
import { recordTurnUsage } from './services/usage.ts';
import { primeAgent, primeAllAgents, setAgentDelivery } from './services/agent-runner.ts';
import { resetFollowUps } from './services/follow-ups.ts';
import { scheduleHeadlessWork } from './services/headless.ts';
import { addAutomation, automations, removeAutomation, runAutomation, setAutomationEnabled } from './services/automations.ts';
import { assertWithinBudget, budget, setLimits, stopIfOverBudget } from './services/budget.ts';
import { cleanUpStorage, scheduleCleanup, storageView } from './services/storage.ts';
import { pullRequestView } from './services/pull-requests.ts';
import { handleTerminalUpgrade } from './services/terminal.ts';

const app = new Hono();

const REASONING = v.picklist(REASONING_LEVELS);

publishUpgradeHandler(handleTerminalUpgrade);
observe((event) => {
	recordAgentEvent(event);
	void recordTurnUsage(event as Parameters<typeof recordTurnUsage>[0])
		.then((id) => (id ? stopIfOverBudget(id) : undefined))
		.catch((error: unknown) => console.warn('[anton] spending check failed', error));
});
// Migrate at boot, so a broken database shows in the log now rather than on the first request.
appDb().catch((error: unknown) => console.error('[anton] database migration failed', error));
scheduleCleanup();
setAgentDelivery(async (id, text) => void (await dispatch(Coder, { id, message: text })));
// Before the runtime resumes replies a restart cut off, so they run with their task's model and MCP servers.
await primeAllAgents().catch((error: unknown) => console.warn('[anton] could not load task models', error));
scheduleHeadlessWork();

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

// A prompt needs a task, waits while its files are being restored, and is checked against
// the spending caps; then the agent loads the task's model and MCP servers before it renders.
// A person writing also lets the agent follow up on its pull request again.
app.post('/api/agents/coder/:id', async (c, next) => {
	const id = c.req.param('id');
	if (!(await getSessionRecord(id))) throw new NotFoundError('Session not found');
	if (isRestoring(id)) throw new ConflictError('Files are being restored; send the message once that finishes');
	await assertWithinBudget(id);
	await resetFollowUps(id);
	await primeAgent(id);
	await next();
});
const agents = createAgentRouter(Coder);
app.route('/api/agents/coder', agents as never);
setAgentAbort(async (id) => void (await agents.request(`/${encodeURIComponent(id)}/abort`, { method: 'POST' })));

/** A comment line often enough that proxies (Cloudflare closes idle streams at 100 s) keep the stream open. */
const HEARTBEAT_MS = 25_000;

// Open pages learn what changed from here and refetch just that, instead of polling.
app.get('/api/events', (c) =>
	streamSSE(c, async (stream) => {
		const queue: Change[] = [];
		let wake = () => {};
		const stop = onChange((change) => {
			queue.push(change);
			wake();
		});
		stream.onAbort(stop);
		while (!stream.aborted) {
			for (const change of queue.splice(0)) await stream.writeSSE({ data: JSON.stringify(change) });
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, HEARTBEAT_MS);
				wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			if (queue.length === 0 && !stream.aborted) await stream.write(': ping\n\n');
		}
		stop();
	}),
);

app.get('/api/health', (c) =>
	c.json({
		ok: true,
		openRouter: config.hasOpenRouter(),
		providers: { sandbox: getProviders().sandbox.name, store: getProviders().store.name, git: getProviders().git.name },
	}),
);

app.get('/api/budget', async (c) => c.json(await budget(c.req.query('session') || undefined)));
const cap = v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(100_000)));
app.put('/api/settings/limits', async (c) => {
	const next = await body(c, v.object({ dailyUsd: cap, taskUsd: cap }));
	await setLimits(next);
	return c.json(await budget());
});
app.get('/api/storage', async (c) => c.json(await storageView()));
app.post('/api/storage/cleanup', async (c) => c.json(await cleanUpStorage()));

app.get('/api/models', async (c) => c.json({ models: await listModels(), default: config.model }));

app.get('/api/projects', async (c) => c.json({ projects: await projects() }));
app.post('/api/projects', async (c) => {
	const { repo } = await body(c, v.object({ repo: v.pipe(v.string(), v.trim(), v.minLength(3)) }));
	return c.json(await addProject(repo));
});
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
app.put('/api/projects/:id/settings', async (c) => {
	const change = await body(
		c,
		v.object({
			env: v.pipe(
				v.record(v.pipe(v.string(), v.regex(ENV_NAME, 'Variable names use letters, digits and underscores')), v.nullable(v.string())),
				v.check((env) => Object.keys(env).length <= 100, 'At most 100 variables'),
			),
			setupScript: v.pipe(v.string(), v.maxLength(20_000)),
			previewPorts: v.pipe(
				v.array(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535))),
				v.maxLength(8),
				v.check((ports) => new Set(ports).size === ports.length, 'List each preview port once'),
			),
			baseImage: v.nullable(v.pipe(v.string(), v.maxLength(300))),
			followUps: v.optional(v.boolean()),
			mcpServers: v.optional(
				v.pipe(
					v.array(
						v.object({
							name: v.pipe(v.string(), v.regex(/^[a-z0-9_-]{1,32}$/, 'Server names use lowercase letters, digits, - and _')),
							url: v.pipe(v.string(), v.url(), v.startsWith('https://', 'MCP servers need an https URL'), v.maxLength(500)),
							auth: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(4000)))),
							tools: v.pipe(v.array(v.pipe(v.string(), v.maxLength(100))), v.maxLength(50)),
						}),
					),
					v.maxLength(10),
					v.check((servers) => new Set(servers.map((server) => server.name)).size === servers.length, 'Each server needs its own name'),
				),
			),
		}),
	);
	return c.json(await updateSettings(c.req.param('id'), change));
});
app.get('/api/projects/:id/automations', async (c) => c.json({ automations: await automations(c.req.param('id')) }));
app.post('/api/projects/:id/automations', async (c) => {
	const input = await body(
		c,
		v.object({
			kind: v.picklist(['issues', 'schedule']),
			label: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(50)))),
			everyHours: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(168)))),
			prompt: v.pipe(v.string(), v.maxLength(20_000)),
			model: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
			reasoning: v.optional(v.nullable(REASONING)),
			planFirst: v.optional(v.boolean()),
		}),
	);
	return c.json(await addAutomation(c.req.param('id'), input));
});
app.patch('/api/automations/:id', async (c) => {
	const { enabled } = await body(c, v.object({ enabled: v.boolean() }));
	return c.json(await setAutomationEnabled(c.req.param('id'), enabled));
});
app.post('/api/automations/:id/run', async (c) => c.json(await runAutomation(c.req.param('id'), { force: true })));
app.delete('/api/automations/:id', async (c) => {
	await removeAutomation(c.req.param('id'));
	return c.json({ ok: true });
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
			planMode: v.optional(v.boolean()),
		}),
	);
	return c.json(await createSession(input));
});
app.get('/api/sessions/:id', async (c) => c.json(await getSession(c.req.param('id'))));
app.patch('/api/sessions/:id', async (c) => {
	const change = await body(
		c,
		v.object({
			title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
			model: v.optional(v.string()),
			reasoning: v.optional(v.nullable(REASONING)),
			planMode: v.optional(v.boolean()),
		}),
	);
	return c.json(await editSession(c.req.param('id'), change));
});
app.delete('/api/sessions/:id', async (c) => {
	await deleteSession(c.req.param('id'));
	return c.body(null, 204);
});
app.post('/api/sessions/:id/stop', async (c) => c.json(await stopSession(c.req.param('id'))));
app.post('/api/sessions/:id/resume', async (c) => c.json(await resumeSession(c.req.param('id'))));
app.get('/api/sessions/:id/checkpoints', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ checkpoints: await listCheckpoints(id) });
});
app.get('/api/sessions/:id/checkpoints/:at', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	const patch = await readCheckpointPatchAt(id, c.req.param('at'));
	return c.json({ at: c.req.param('at'), patch });
});
app.post('/api/sessions/:id/checkpoints/:at/restore', async (c) => c.json(await restoreCheckpoint(c.req.param('id'), c.req.param('at'))));
app.get('/api/sessions/:id/previews', async (c) => c.json(await previewsView(c.req.param('id'))));
app.get('/api/sessions/:id/pull-request', async (c) => c.json(await pullRequestView(c.req.param('id'))));

app.get('/api/sessions/:id/changes', async (c) => c.json(await changesView(c.req.param('id'))));
app.get('/api/sessions/:id/files', async (c) => c.json(await fileTree(c.req.param('id'))));
app.get('/api/sessions/:id/file', async (c) => bytes(c, await readFile(c.req.param('id'), c.req.query('path') ?? '')));
app.get('/api/sessions/:id/outputs', async (c) => c.json(await outputsView(c.req.param('id'))));
app.get('/api/sessions/:id/output', async (c) => {
	const path = c.req.query('path') ?? '';
	return bytes(c, await readOutputFile(c.req.param('id'), path), contentType(path));
});

export default app;
