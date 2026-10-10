import { dispatch } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as v from 'valibot';
import { Coder } from './agents/coder.ts';
import { Reviewer } from './agents/reviewer.ts';
import { config } from './config.ts';
import { type Change, onChange } from './core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError, statusOf } from './core/errors.ts';
import { appDb } from './db/client.ts';
import { getSessionRecord } from './db/sessions.ts';
import { REASONING_LEVELS } from './core/ports.ts';
import { publishUpgradeHandler } from './core/upgrades.ts';
import { getProviders } from './providers/index.ts';
import { recordAgentEvent, setAgentAbort } from './services/activity.ts';
import { listModels, pinnedModels, setPinnedModels } from './services/models.ts';
import { changesView, fileTree, projectFiles, outputsView, readFile, readOutputFile } from './services/files.ts';
import { profileName } from './services/profile.ts';
import { addableRepos, addProject, branches, projects, rebuildPreparedImage, removeProject, updateSettings } from './services/projects.ts';
import { REGIONS, sandboxSettings, setSandboxSettings } from './services/sandbox-settings.ts';
import { defaultModel, generalSettings, setGeneralSettings } from './services/general.ts';
import { guardrails, secretsView, setGuardrails, setSharedEnv } from './services/secrets.ts';
import { reviewQueue } from './services/reviews.ts';
import { MAX_MEMORY, saveMemory } from './services/memory.ts';
import { commands, setCommands } from './services/commands.ts';
import {
	catalog,
	installPlugin,
	marketplaces,
	pluginFile,
	pluginsView,
	previewPlugin,
	removePlugin,
	searchGitHub,
	sessionSkills,
	setEnabled,
	setMarketplaces,
} from './services/plugins.ts';
import {
	createSession,
	getSession,
	listSessions,
	deleteSession,
	editSession,
	forkSession,
	resumeSession,
	stopSession,
} from './services/sessions.ts';
import { listCheckpoints, readCheckpointPatchAt } from './services/checkpoints.ts';
import { previewsView } from './services/previews.ts';
import { browserScreenshot, browserView, clearHighlight, closeBrowser, inspectAt, navigate, openBrowser } from './services/live-browser.ts';
import { isRestoring, restoreCheckpoint, revertFile } from './services/restore.ts';
import { recordTurnUsage, usageView } from './services/usage.ts';
import { countReplyCall } from './services/response-usage.ts';
import { recordSubagentEvent, subagentRuns } from './services/subagent-runs.ts';
import { recordReplyText } from './services/reply-check.ts';
import { backfillLatestInputs } from './services/latest-input.ts';
import { contextView, recordContext } from './services/context-usage.ts';
import { primeAgent, primeAllAgents, setAgentDelivery } from './services/agent-runner.ts';
import { resetFollowUps } from './services/follow-ups.ts';
import { scheduleHeadlessWork } from './services/headless.ts';
import { addAutomation, automations, removeAutomation, runAutomation, setAutomationEnabled } from './services/automations.ts';
import { assertWithinBudget, budget, setLimits, stopIfOverBudget } from './services/budget.ts';
import { cleanUpStorage, scheduleCleanup, storageView } from './services/storage.ts';
import { pullRequestView } from './services/pull-requests.ts';
import { requestReview } from './services/code-review.ts';
import { computeView, stopAllSandboxes } from './services/compute.ts';
import { connections } from './services/connections.ts';
import {
	recordPlanLimit,
	beginLogin,
	cancelLogin,
	disconnect,
	finishLogin,
	importLogin,
	refreshSubscriptionModels,
	setSubscriptionOptions,
	subscriptionsView,
} from './services/subscriptions.ts';
import { handleTerminalUpgrade } from './services/terminal.ts';
import { logProblem, logRuntimeEvent, recentProblems } from './services/log.ts';
import { observeRuntime } from './services/runtime-observer.ts';

const app = new Hono();

const REASONING = v.picklist(REASONING_LEVELS);
const AGENT_MODEL = v.nullable(v.object({ model: v.pipe(v.string(), v.minLength(1)), reasoning: v.nullable(REASONING) }));
/** Variables from the browser; null keeps a stored value. */
const ENV = v.pipe(
	v.record(v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Variable names use letters, digits and underscores')), v.nullable(v.string())),
	v.check((env) => Object.keys(env).length <= 100, 'At most 100 variables'),
);

publishUpgradeHandler(handleTerminalUpgrade);
observeRuntime((event) => {
	recordAgentEvent(event);
	// Before anything awaits, so a reply's last call is counted by the time the reply finishes.
	countReplyCall(event as Parameters<typeof countReplyCall>[0]);
	recordSubagentEvent(event as Parameters<typeof recordSubagentEvent>[0]);
	recordReplyText(event as Parameters<typeof recordReplyText>[0]);
	void recordContext(event as Parameters<typeof recordContext>[0]).catch((error: unknown) => logProblem('warn', 'Context usage not recorded', error));
	void recordPlanLimit(event as Parameters<typeof recordPlanLimit>[0]).catch((error: unknown) => logProblem('warn', 'Plan limit not recorded', error));
	logRuntimeEvent(event as Parameters<typeof logRuntimeEvent>[0]);
	void recordTurnUsage(event as Parameters<typeof recordTurnUsage>[0])
		.then((id) => (id ? stopIfOverBudget(id) : undefined))
		.catch((error: unknown) => logProblem('warn', 'Spending check failed', error));
});
// Migrate at boot, so a broken database shows in the log now rather than on the first request.
appDb()
	.then(() => backfillLatestInputs())
	.catch((error: unknown) => logProblem('error', 'Database migration failed', error));
scheduleCleanup();
setAgentDelivery(async (id, text) => void (await dispatch(Coder, { id, message: text })));
setAgentDelivery(async (id, text) => void (await dispatch(Reviewer, { id, message: text })), 'reviewer');
// Before the runtime resumes replies a restart cut off, so they run with their task's model and MCP servers.
await primeAllAgents().catch((error: unknown) => logProblem('warn', 'Could not load task models', error));
scheduleHeadlessWork();

function valid<T extends v.GenericSchema>(schema: T, value: unknown): v.InferOutput<T> {
	const result = v.safeParse(schema, value);
	if (!result.success) throw new InvalidInputError(result.issues.map((issue) => issue.message).join('; '));
	return result.output;
}

async function body<T extends v.GenericSchema>(c: Context, schema: T): Promise<v.InferOutput<T>> {
	return valid(schema, await c.req.json().catch(() => ({})));
}

/**
 * Images and PDFs render inline (the browser's PDF viewer keeps a PDF's scripts
 * away from this page); everything else downloads, so agent-written HTML never runs on this origin.
 */
const INLINE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	pdf: 'application/pdf',
};
const contentType = (path: string) => INLINE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

function bytes(c: Context, data: Uint8Array | null, type = 'application/octet-stream') {
	if (!data) return c.json({ error: 'Not found' }, 404);
	return c.body(data as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
}

app.onError((error, c) => {
	const status = statusOf(error);
	if (status >= 500) logProblem('error', `${c.req.method} ${c.req.path} failed`, error);
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
// The reviewer is never served over HTTP; its router only stops it.
const reviewers = createAgentRouter(Reviewer);
setAgentAbort(async (id) => {
	const path = `/${encodeURIComponent(id)}/abort`;
	await Promise.all([agents.request(path, { method: 'POST' }), reviewers.request(path, { method: 'POST' })]);
});

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
app.get('/api/usage', async (c) => c.json(await usageView()));
const cap = v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(100_000)));
app.put('/api/settings/limits', async (c) => {
	const next = await body(c, v.object({ dailyUsd: cap, taskUsd: cap }));
	await setLimits(next);
	return c.json(await budget());
});
app.get('/api/settings/commands', async (c) => c.json({ commands: await commands() }));
app.put('/api/settings/commands', async (c) => {
	const input = await body(
		c,
		v.object({
			commands: v.pipe(
				v.array(v.object({ name: v.pipe(v.string(), v.maxLength(40)), prompt: v.pipe(v.string(), v.maxLength(20_000)) })),
				v.maxLength(100),
			),
		}),
	);
	return c.json({ commands: await setCommands(input.commands) });
});
const sandboxView = async () => ({ settings: await sandboxSettings(), defaultBaseImage: config.modal.baseImage, provider: getProviders().sandbox.name });
app.get('/api/settings/sandbox', async (c) => c.json(await sandboxView()));
app.put('/api/settings/sandbox', async (c) => {
	const domain = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Allowed domains look like registry.npmjs.org or *.example.com'));
	const next = await body(
		c,
		v.object({
			cpu: v.pipe(v.number(), v.minValue(0.25), v.maxValue(64)),
			memoryMiB: v.pipe(v.number(), v.integer(), v.minValue(512), v.maxValue(262_144)),
			idleMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(24 * 60)),
			lifetimeHours: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(24)),
			region: v.nullable(v.picklist(REGIONS)),
			allowedDomains: v.pipe(v.array(domain), v.maxLength(100)),
			baseImage: v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300))),
			warmImageDays: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(90)),
		}),
	);
	await setSandboxSettings(next);
	return c.json(await sandboxView());
});
app.get('/api/settings/general', async (c) => c.json(await generalSettings()));
app.put('/api/settings/general', async (c) => {
	const next = await body(
		c,
		v.object({
			model: v.nullable(v.pipe(v.string(), v.minLength(1))),
			reasoning: v.nullable(REASONING),
			planMode: v.boolean(),
			reviewPullRequests: v.boolean(),
			codeMode: v.boolean(),
			agentModels: v.object({ explorer: AGENT_MODEL, tester: AGENT_MODEL, browser: v.optional(AGENT_MODEL, null), reviewer: AGENT_MODEL }),
		}),
	);
	return c.json(await setGeneralSettings(next));
});
app.get('/api/plugins', async (c) => c.json({ plugins: await pluginsView(), marketplaces: await marketplaces() }));
app.put('/api/settings/marketplaces', async (c) => {
	const input = await body(c, v.object({ marketplaces: v.pipe(v.array(v.pipe(v.string(), v.trim(), v.minLength(1))), v.maxLength(20)) }));
	return c.json({ marketplaces: await setMarketplaces(input.marketplaces) });
});
app.get('/api/marketplaces/catalog', async (c) => c.json({ entries: await catalog(c.req.query('repo') ?? '', c.req.query('bundle')) }));
const PLUGIN_PICK = v.union([
	v.object({ marketplace: v.pipe(v.string(), v.minLength(1)), name: v.pipe(v.string(), v.minLength(1)) }),
	v.object({ address: v.pipe(v.string(), v.trim(), v.minLength(1)) }),
	v.object({ plugin: v.pipe(v.string(), v.minLength(1)) }),
]);
app.post('/api/plugins', async (c) => {
	await installPlugin(await body(c, PLUGIN_PICK));
	return c.json({ plugins: await pluginsView() });
});
app.get('/api/plugins/preview', async (c) => c.json(await previewPlugin(valid(PLUGIN_PICK, c.req.query()))));
app.get('/api/plugins/file', async (c) => bytes(c, await pluginFile(c.req.query('repo') ?? '', c.req.query('sha') ?? '', c.req.query('path') ?? '')));
app.get('/api/skills/search', async (c) => c.json(await searchGitHub(c.req.query('q') ?? '')));
app.patch('/api/plugins/:id', async (c) => {
	const { enabled } = await body(c, v.object({ enabled: v.boolean() }));
	await setEnabled(c.req.param('id'), enabled);
	return c.json({ plugins: await pluginsView() });
});
app.delete('/api/plugins/:id', async (c) => {
	await removePlugin(c.req.param('id'));
	return c.json({ plugins: await pluginsView() });
});
app.get('/api/settings/guardrails', async (c) => c.json(await guardrails()));
app.put('/api/settings/guardrails', async (c) => c.json(await setGuardrails(await body(c, v.object({ hideSecrets: v.boolean() })))));
app.get('/api/secrets', async (c) => c.json(await secretsView()));
app.put('/api/secrets/shared', async (c) => {
	const { env } = await body(c, v.object({ env: ENV }));
	return c.json(await setSharedEnv(env));
});
app.post('/api/projects/:id/prepared-image/rebuild', async (c) => c.json(await rebuildPreparedImage(c.req.param('id'))));
app.get('/api/reviews', async (c) => c.json({ reviews: await reviewQueue() }));
app.get('/api/connections', async (c) => c.json({ connections: await connections() }));
app.get('/api/compute', async (c) => c.json(await computeView()));
app.post('/api/compute/stop-all', async (c) => c.json(await stopAllSandboxes()));
app.get('/api/logs', (c) => c.json({ logs: recentProblems() }));
app.get('/api/storage', async (c) => c.json(await storageView()));
app.post('/api/storage/cleanup', async (c) => c.json(await cleanUpStorage()));

app.get('/api/models', async (c) => c.json({ models: await listModels(), default: await defaultModel(), pinned: await pinnedModels() }));
app.put('/api/models/pinned', async (c) => {
	const { pinned } = await body(c, v.object({ pinned: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))), v.maxLength(100)) }));
	return c.json({ pinned: await setPinnedModels(pinned) });
});

// Plans you already pay for, signed in to with the vendor's own flow; see services/subscriptions.ts.
app.get('/api/subscriptions', async (c) => c.json({ subscriptions: await subscriptionsView() }));
app.put('/api/subscriptions/:id', async (c) => {
	const options = await body(c, v.object({ enabled: v.boolean(), countAtApiPrices: v.boolean() }));
	return c.json(await setSubscriptionOptions(c.req.param('id'), options));
});
app.delete('/api/subscriptions/:id', async (c) => c.json(await disconnect(c.req.param('id'))));
app.post('/api/subscriptions/:id/login', async (c) => c.json(await beginLogin(c.req.param('id'))));
app.delete('/api/subscriptions/:id/login', async (c) => c.json(await cancelLogin(c.req.param('id'))));
app.post('/api/subscriptions/:id/login/complete', async (c) => {
	const { callbackUrl } = await body(c, v.object({ callbackUrl: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)) }));
	return c.json(await finishLogin(c.req.param('id'), callbackUrl));
});
app.post('/api/subscriptions/:id/import', async (c) => {
	const { credential } = await body(c, v.object({ credential: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50_000)) }));
	return c.json(await importLogin(c.req.param('id'), credential));
});
app.post('/api/subscriptions/:id/models/refresh', async (c) => c.json(await refreshSubscriptionModels(c.req.param('id'))));

app.get('/api/profile', async (c) => c.json({ name: await profileName() }));
app.get('/api/projects', async (c) => c.json({ projects: await projects() }));
app.get('/api/repos', async (c) => c.json({ repos: await addableRepos() }));
app.post('/api/projects', async (c) => {
	const { repo } = await body(c, v.object({ repo: v.pipe(v.string(), v.trim(), v.minLength(3)) }));
	return c.json(await addProject(repo));
});
app.delete('/api/projects/:id', async (c) => {
	await removeProject(c.req.param('id'));
	return c.json({ ok: true });
});
app.put('/api/projects/:id/memory', async (c) => {
	const { memory } = await body(c, v.object({ memory: v.pipe(v.string(), v.maxLength(MAX_MEMORY)) }));
	await saveMemory(c.req.param('id'), memory);
	return c.json({ memory: memory.trim() });
});
app.put('/api/projects/:id/settings', async (c) => {
	const change = await body(
		c,
		v.object({
			env: ENV,
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
app.get('/api/projects/:id/files', async (c) => c.json({ paths: await projectFiles(c.req.param('id'), c.req.query('branch')) }));

app.get('/api/sessions', async (c) => c.json({ sessions: await listSessions() }));
app.get('/api/sessions/:id/skills', async (c) => c.json({ skills: await sessionSkills(c.req.param('id')) }));
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
			pinned: v.optional(v.boolean()),
		}),
	);
	return c.json(await editSession(c.req.param('id'), change));
});
app.post('/api/sessions/:id/fork', async (c) => c.json(await forkSession(c.req.param('id'))));
app.delete('/api/sessions/:id', async (c) => {
	await deleteSession(c.req.param('id'));
	return c.body(null, 204);
});
app.post('/api/sessions/:id/review', async (c) => c.json({ started: await requestReview(c.req.param('id'), { automatic: false }) }));
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
app.post('/api/sessions/:id/revert', async (c) => {
	const { path } = await body(c, v.object({ path: v.pipe(v.string(), v.minLength(1)) }));
	await revertFile(c.req.param('id'), path);
	return c.json({ ok: true });
});
app.get('/api/sessions/:id/previews', async (c) => c.json(await previewsView(c.req.param('id'))));
// The Browser panel: a hosted browser per task, seen through its live view and driven for the address bar, picking and drawing.
app.get('/api/sessions/:id/browser', async (c) => c.json(await browserView(c.req.param('id'))));
app.post('/api/sessions/:id/browser', async (c) => {
	const { url } = await body(c, v.object({ url: v.optional(v.pipe(v.string(), v.maxLength(4000))) }));
	return c.json(await openBrowser(c.req.param('id'), url));
});
app.delete('/api/sessions/:id/browser', async (c) => {
	await closeBrowser(c.req.param('id'));
	return c.json({ ok: true });
});
app.post('/api/sessions/:id/browser/navigate', async (c) => {
	const input = await body(c, v.union([v.object({ url: v.pipe(v.string(), v.maxLength(4000)) }), v.object({ action: v.picklist(['back', 'forward', 'reload']) })]));
	return c.json(await navigate(c.req.param('id'), input));
});
app.post('/api/sessions/:id/browser/inspect', async (c) => {
	const point = await body(c, v.object({ x: v.number(), y: v.number(), pick: v.optional(v.boolean(), false) }));
	return c.json({ element: await inspectAt(c.req.param('id'), point) });
});
app.post('/api/sessions/:id/browser/highlight/clear', async (c) => {
	await clearHighlight(c.req.param('id'));
	return c.json({ ok: true });
});
app.post('/api/sessions/:id/browser/screenshot', async (c) => c.json(await browserScreenshot(c.req.param('id'))));
app.get('/api/sessions/:id/subagents', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ runs: await subagentRuns(id) });
});
app.get('/api/sessions/:id/context', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json(await contextView(id));
});
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
