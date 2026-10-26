import { dispatch } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as v from 'valibot';
import { Coder } from './agents/coder.ts';
import { Reviewer } from './agents/reviewer.ts';
import { Coordinator } from './agents/coordinator.ts';
import { config } from './config.ts';
import { type Change, onChange } from './core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError, statusOf } from './core/errors.ts';
import { appDb } from './db/client.ts';
import { getSessionRecord } from './db/sessions.ts';
import { getSpace } from './db/spaces.ts';
import { REASONING_LEVELS } from './core/ports.ts';
import { ROUTE_SORTS } from './core/model-route.ts';
import { FREQUENCIES } from './core/schedule.ts';
import { publishUpgradeHandler } from './core/upgrades.ts';
import { getProviders } from './providers/index.ts';
import { openRouterKey } from './providers/openrouter/key.ts';
import { noteSending, recordAgentEvent, setAgentAbort } from './services/activity.ts';
import { listModels, modelEndpoints, pinnedModels, setPinnedModels } from './services/models.ts';
import { listArtifacts } from './services/artifacts.ts';
import { pageFetch } from './services/page-fetch.ts';
import { PAGE_CSP, pageFrame, pageState, renderPage, savePageState } from './services/renders.ts';
import { changesView, fileTree, MAX_UPLOAD_BYTES, projectFiles, outputsView, readFile, readOutputFile, removeOutput, uploadOutput } from './services/files.ts';
import { profileName } from './services/profile.ts';
import { addableRepos, addProject, branches, projects, rebuildPreparedImage, removeProject, updateSettings } from './services/projects.ts';
import { REGIONS, sandboxSettings, setSandboxSettings } from './services/sandbox-settings.ts';
import { imageModels, imagesAvailable } from './services/images.ts';
import { COMPACT_AT, DEFAULT_COMPACT_AT, defaultModel, generalSettings, setGeneralSettings, VISUAL_REPLIES } from './services/general.ts';
import { guardrails, secretsView, setGuardrails, setSharedEnv } from './services/secrets.ts';
import { reviewQueue } from './services/reviews.ts';
import { reviewPullRequest } from './services/review-tasks.ts';
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
	listThreads,
	editSession,
	forkSession,
	resumeSession,
	stopSession,
} from './services/sessions.ts';
import { listCheckpoints, readCheckpointPatchAt } from './services/checkpoints.ts';
import { previewsView } from './services/previews.ts';
import { computerScreenshot, computerView, connectComputer, setComputerControl, startComputer, stopComputer } from './services/computer.ts';
import { browserScreenshot, browserView, clearHighlight, closeBrowser, inspectAt, navigate, openBrowser, watchBrowser } from './services/live-browser.ts';
import { isRestoring, restoreCheckpoint, revertFile } from './services/restore.ts';
import { recordTurnUsage, usageView } from './services/usage.ts';
import { countReplyCall } from './services/response-usage.ts';
import { recordTraceEvent } from './services/response-trace.ts';
import { getTrace } from './db/traces.ts';
import { noteRepliesStopping, recordSubagentEvent, stopSubagent, subagentRuns } from './services/subagent-runs.ts';
import { installSubagentStop } from './flue/subagent-stop.ts';
import { installToolResultCut } from './flue/tool-result-cut.ts';
import { scriptCalls } from './services/script-runs.ts';
import { todosFor } from './services/todos.ts';
import { joinsFor, recordJoinEvent } from './services/joins.ts';
import { agentNow, recordAgentNow } from './services/agent-now.ts';
import { recordReplyText } from './services/reply-check.ts';
import { backfillLatestInputs } from './services/latest-input.ts';
import { contextView, recordContext } from './services/context-usage.ts';
import { type DeliveredImage, primeAgent, primeAllAgents, setAgentDelivery } from './services/agent-runner.ts';
import { resetFollowUps } from './services/follow-ups.ts';
import { scheduleHeadlessWork } from './services/headless.ts';
import { scheduleIdleStops } from './services/idle-stop.ts';
import { addAutomation, automations, editAutomation, removeAutomation, runAutomation, setAutomationEnabled, spaceAutomations } from './services/automations.ts';
import { createSpace, deleteTask, editSpace, MAX_INSTRUCTIONS, MAX_SPACE_MEMORY, moveToSpace, nudgeThread, removeSpace, spaceUsage, spacesView, spaceView, startThread } from './services/spaces.ts';
import { threadStarted } from './services/thread-reports.ts';
import { primeCoordinator } from './services/coordinator.ts';
import { listSpaceFiles, readSpaceFile, removeSpaceFile, uploadSpaceFile } from './services/space-files.ts';
import { attachToProject, attachToTask } from './services/attachments.ts';
import { beginConnect, connectorsView, disconnectAccount, finishConnect, setAccountClient, setMailboxOptions } from './services/connectors.ts';
import { decideSend, mailApprovals } from './services/mail.ts';
import { addMcpServer, mcpServersView, mcpServerTools, removeMcpServer, toggleMcpServer, updateMcpServer } from './services/mcp-servers.ts';
import { beginMcpSignIn, finishMcpSignIn, signOutOfMcpServer } from './services/mcp-sign-in.ts';
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
	connectKey,
	disconnect,
	finishLogin,
	importLogin,
	loadGatewayKey,
	refreshSubscriptionModels,
	setSubscriptionOptions,
	subscriptionsView,
} from './services/subscriptions.ts';
import { handleTerminalUpgrade } from './services/terminal.ts';
import { logProblem, logRuntimeEvent, recentProblems } from './services/log.ts';
import { observeRuntime } from './services/runtime-observer.ts';
import { addDevice, notePresence, pushView, recordFailedReply, removeDevice, sendTest, setPushOptions } from './services/push.ts';

const app = new Hono();

const REASONING = v.picklist(REASONING_LEVELS);
/** A task's route: one provider first (by the gateway's slug), or a sort; null leaves it to the gateway. */
const ROUTE = v.nullable(
	v.union([v.object({ provider: v.pipe(v.string(), v.regex(/^[\w.\-/:]{1,80}$/)) }), v.object({ sort: v.picklist(ROUTE_SORTS) })]),
);
const AGENT_MODEL = v.nullable(v.object({ model: v.pipe(v.string(), v.minLength(1)), reasoning: v.nullable(REASONING) }));
/** Variables from the browser; null keeps a stored value. */
const ENV = v.pipe(
	v.record(v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Variable names use letters, digits and underscores')), v.nullable(v.string())),
	v.check((env) => Object.keys(env).length <= 100, 'At most 100 variables'),
);

publishUpgradeHandler(handleTerminalUpgrade);
installSubagentStop();
installToolResultCut();
observeRuntime((event) => {
	recordAgentEvent(event);
	// Before anything awaits, so a reply's last call is counted by the time the reply finishes.
	countReplyCall(event as Parameters<typeof countReplyCall>[0]);
	recordTraceEvent(event as Parameters<typeof recordTraceEvent>[0]);
	recordSubagentEvent(event as Parameters<typeof recordSubagentEvent>[0]);
	recordReplyText(event as Parameters<typeof recordReplyText>[0]);
	recordJoinEvent(event as Parameters<typeof recordJoinEvent>[0]);
	recordAgentNow(event as Parameters<typeof recordAgentNow>[0]);
	void recordContext(event as Parameters<typeof recordContext>[0]).catch((error: unknown) => logProblem('warn', 'Context usage not recorded', error));
	void recordPlanLimit(event as Parameters<typeof recordPlanLimit>[0]).catch((error: unknown) => logProblem('warn', 'Plan limit not recorded', error));
	logRuntimeEvent(event as Parameters<typeof logRuntimeEvent>[0]);
	recordFailedReply(event as Parameters<typeof recordFailedReply>[0]);
	void recordTurnUsage(event as Parameters<typeof recordTurnUsage>[0])
		.then((id) => (id ? stopIfOverBudget(id) : undefined))
		.catch((error: unknown) => logProblem('warn', 'Spending check failed', error));
});
// Migrate at boot, so a broken database shows in the log now rather than on the first request.
appDb()
	.then(() => backfillLatestInputs())
	.catch((error: unknown) => logProblem('error', 'Database migration failed', error));
scheduleCleanup();
// A message with pictures (a thread's brief with images attached) goes as a user message carrying them.
const delivered = (text: string, images?: DeliveredImage[]) => (images?.length ? { kind: 'user' as const, body: text, attachments: images } : text);
setAgentDelivery(async (id, text, images) => void (await dispatch(Coder, { id, message: delivered(text, images) })));
setAgentDelivery(async (id, text, images) => void (await dispatch(Reviewer, { id, message: delivered(text, images) })), 'reviewer');
setAgentDelivery(async (id, text, images) => void (await dispatch(Coordinator, { id, message: delivered(text, images) })), 'coordinator');
// The OpenRouter key pasted in Settings › Subscriptions, before anything calls OpenRouter.
await loadGatewayKey().catch((error: unknown) => logProblem('warn', 'Could not load the OpenRouter key', error));
// Before the runtime resumes replies a restart cut off, so they run with their task's model and MCP servers.
await primeAllAgents().catch((error: unknown) => logProblem('warn', 'Could not load task models', error));
scheduleHeadlessWork();
scheduleIdleStops();

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
	avif: 'image/avif',
	svg: 'image/svg+xml',
	pdf: 'application/pdf',
};
const contentType = (path: string) => INLINE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/**
 * An SVG is a document that can run script: opened on its own, it would run on Anton's origin.
 * Served sandboxed, it draws (as an <img> it never runs script anyway) and does nothing else.
 */
const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

function bytes(c: Context, data: Uint8Array | null, type = 'application/octet-stream') {
	if (!data) return c.json({ error: 'Not found' }, 404);
	return c.body(data as Uint8Array<ArrayBuffer>, 200, {
		'Content-Type': type,
		'X-Content-Type-Options': 'nosniff',
		...(type === 'image/svg+xml' ? { 'Content-Security-Policy': SVG_CSP } : {}),
	});
}

app.onError((error, c) => {
	const status = statusOf(error);
	if (status >= 500) logProblem('error', `${c.req.method} ${c.req.path} failed`, error);
	return c.json({ error: error.message }, status as 400);
});

// A prompt needs a task, waits while its files are being restored, and is checked against
// the spending caps; then the agent loads the task's model and MCP servers before it renders.
// A person writing also lets the agent follow up on its pull request again. The task counts as
// working from the moment the message arrives, so the task list moves it to Running at once.
app.post('/api/agents/coder/:id', async (c, next) => {
	const id = c.req.param('id');
	if (!(await getSessionRecord(id))) throw new NotFoundError('Session not found');
	const turnedAway = noteSending(id);
	try {
		if (isRestoring(id)) throw new ConflictError('Files are being restored; send the message once that finishes');
		await assertWithinBudget(id);
		await resetFollowUps(id);
		await primeAgent(id);
		await next();
	} catch (error) {
		turnedAway();
		throw error;
	}
	if (c.error || c.res.status >= 400) turnedAway();
});
// Stop: its running subagents end as stopped, not failed.
app.post('/api/agents/coder/:id/abort', async (c, next) => {
	noteRepliesStopping(c.req.param('id'));
	await next();
});
const agents = createAgentRouter(Coder);
app.route('/api/agents/coder', agents as never);
// A project's coordinator, one conversation per project; like a prompt to a task, a message is checked
// against the daily cap, and the coordinator loads a fresh picture of its project before it renders.
app.post('/api/agents/coordinator/:id', async (c, next) => {
	const id = c.req.param('id');
	if (!(await getSpace(id))) throw new NotFoundError('Project not found');
	await assertWithinBudget(id);
	await primeCoordinator(id);
	await next();
});
const coordinators = createAgentRouter(Coordinator);
app.route('/api/agents/coordinator', coordinators as never);
// The reviewer is never served over HTTP; its router only stops it.
const reviewers = createAgentRouter(Reviewer);
setAgentAbort(async (id) => {
	const path = `/${encodeURIComponent(id)}/abort`;
	const routers = id.startsWith('space_') ? [coordinators] : [agents, reviewers];
	await Promise.all(routers.map((router) => router.request(path, { method: 'POST' })));
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
		openRouter: openRouterKey() !== null,
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
			visualReplies: v.optional(v.picklist(VISUAL_REPLIES), 'some'),
			pageNetwork: v.optional(v.boolean(), true),
			imageModel: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1))), null),
			compactAt: v.optional(v.nullable(v.picklist(COMPACT_AT)), DEFAULT_COMPACT_AT),
			agentModels: v.object({ explorer: AGENT_MODEL, tester: AGENT_MODEL, browser: v.optional(AGENT_MODEL, null), computer: v.optional(AGENT_MODEL, null), reviewer: AGENT_MODEL }),
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
// Notifications on your phone and in closed browsers (Settings › Notifications).
const KEY = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Keys are base64url'), v.maxLength(200));
app.get('/api/push', async (c) => c.json(await pushView()));
app.post('/api/push/devices', async (c) => {
	const input = await body(
		c,
		v.object({
			endpoint: v.pipe(v.string(), v.url(), v.startsWith('https://', 'Push endpoints use https'), v.maxLength(2000)),
			keys: v.object({ p256dh: KEY, auth: KEY }),
			name: v.optional(v.pipe(v.string(), v.maxLength(100)), ''),
			/** The endpoint a renewed subscription takes over from, keeping its name. */
			replaces: v.optional(v.pipe(v.string(), v.maxLength(2000))),
		}),
	);
	return c.json(await addDevice({ endpoint: input.endpoint, keys: input.keys }, input.name, input.replaces));
});
app.delete('/api/push/devices/:id', async (c) => c.json(await removeDevice(c.req.param('id'))));
app.post('/api/push/test', async (c) => c.json(await sendTest((await body(c, v.object({ device: v.optional(v.string()) }))).device)));
app.put('/api/push/options', async (c) => c.json(await setPushOptions(await body(c, v.object({ finished: v.boolean() })))));
// Pages say while they are in front of you, so your phone stays quiet while you are at Anton.
app.post('/api/push/presence', async (c) => {
	notePresence((await body(c, v.object({ present: v.boolean() }))).present);
	return c.json({ ok: true });
});
app.get('/api/secrets', async (c) => c.json(await secretsView()));
app.put('/api/secrets/shared', async (c) => {
	const { env } = await body(c, v.object({ env: ENV }));
	return c.json(await setSharedEnv(env));
});
app.post('/api/projects/:id/prepared-image/rebuild', async (c) => c.json(await rebuildPreparedImage(c.req.param('id'))));
app.get('/api/reviews', async (c) => c.json({ reviews: await reviewQueue() }));
// Reviews any pull request by its link, in a task of its own unless Anton opened it.
app.post('/api/reviews', async (c) => {
	const { url } = await body(c, v.object({ url: v.pipe(v.string(), v.maxLength(500)) }));
	return c.json(await reviewPullRequest(url), 201);
});
app.get('/api/connections', async (c) => c.json({ connections: await connections() }));
app.get('/api/compute', async (c) => c.json(await computeView()));
app.post('/api/compute/stop-all', async (c) => c.json(await stopAllSandboxes()));
app.get('/api/logs', (c) => c.json({ logs: recentProblems() }));
app.get('/api/storage', async (c) => c.json(await storageView()));
app.post('/api/storage/cleanup', async (c) => c.json(await cleanUpStorage()));

app.get('/api/models', async (c) => c.json({ models: await listModels(), default: await defaultModel(), pinned: await pinnedModels() }));
// The providers a gateway can send one model's calls to, for a task's route; empty for a model on a plan.
app.get('/api/models/endpoints', async (c) => {
	const model = c.req.query('model') ?? '';
	if (!model) throw new InvalidInputError('Name a model.');
	return c.json({ endpoints: await modelEndpoints(model) });
});
// What generate_image can draw with, for Settings › General; empty without an OpenRouter key.
app.get('/api/image-models', async (c) => c.json({ models: await imageModels(), default: config.imageModel, available: imagesAvailable() }));
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
// Plans used with a key from the vendor's dashboard (OpenCode Go, Cursor), and OpenRouter's key: the key is checked with the vendor before it is kept.
app.put('/api/subscriptions/:id/key', async (c) => {
	const { key } = await body(c, v.object({ key: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)) }));
	return c.json(await connectKey(c.req.param('id'), key));
});
app.post('/api/subscriptions/:id/models/refresh', async (c) => c.json(await refreshSubscriptionModels(c.req.param('id'))));

// Connectors: MCP servers every task gets, and accounts such as Gmail signed in to on your own OAuth client; see services/connectors.ts.
app.get('/api/connectors', async (c) => c.json({ ...(await connectorsView()), mcpServers: await mcpServersView() }));
app.put('/api/connectors/accounts/:id/client', async (c) => {
	const input = await body(
		c,
		v.object({ clientId: v.pipe(v.string(), v.trim(), v.maxLength(300)), clientSecret: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(300)))) }),
	);
	return c.json(await setAccountClient(c.req.param('id'), input));
});
app.delete('/api/connectors/accounts/:id', async (c) => c.json(await disconnectAccount(c.req.param('id'))));
app.post('/api/connectors/mailboxes/:id/connect', async (c) => {
	const { origin, access } = await body(c, v.object({ origin: v.pipe(v.string(), v.maxLength(300)), access: v.picklist(['read', 'draft']) }));
	return c.json(await beginConnect(c.req.param('id'), origin, access));
});
app.put('/api/connectors/mailboxes/:id', async (c) => {
	const options = await body(c, v.object({ enabled: v.boolean(), draft: v.boolean(), send: v.boolean() }));
	return c.json(await setMailboxOptions(c.req.param('id'), options));
});
// Google sends the browser back here; it goes on to Settings › Connectors, which says how it went.
app.get('/api/connectors/:account/callback', async (c) => {
	const query = new URL(c.req.url).search;
	const back = new URLSearchParams();
	try {
		const { mailbox } = await finishConnect(c.req.param('account'), query);
		back.set('c', `mail:${mailbox}`);
		back.set('connected', mailbox);
	} catch (error) {
		back.set('add', 'gmail');
		back.set('problem', error instanceof Error ? error.message : String(error));
	}
	// The connector's own page, which says how it went.
	return c.redirect(`/settings/connectors/view?${back}`);
});
const MCP_SERVER = v.object({
	url: v.pipe(v.string(), v.trim(), v.url(), v.startsWith('https://', 'MCP servers need an https URL'), v.maxLength(500)),
	auth: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(4000)))),
	tools: v.pipe(v.array(v.pipe(v.string(), v.maxLength(100))), v.maxLength(50)),
	codeMode: v.optional(v.boolean()),
});
const SERVER_NAME = v.pipe(v.string(), v.regex(/^[a-z0-9_-]{1,32}$/, 'Server names use lowercase letters, digits, - and _'));
app.post('/api/mcp-servers', async (c) => {
	const input = await body(c, v.object({ ...MCP_SERVER.entries, name: SERVER_NAME }));
	return c.json({ mcpServers: await addMcpServer(input) });
});
app.put('/api/mcp-servers/:name', async (c) => c.json({ mcpServers: await updateMcpServer(c.req.param('name'), await body(c, MCP_SERVER)) }));
app.patch('/api/mcp-servers/:name', async (c) => {
	const { enabled } = await body(c, v.object({ enabled: v.boolean() }));
	return c.json({ mcpServers: await toggleMcpServer(c.req.param('name'), enabled) });
});
app.delete('/api/mcp-servers/:name', async (c) => c.json({ mcpServers: await removeMcpServer(c.req.param('name')) }));
app.get('/api/mcp-servers/:name/tools', async (c) => c.json({ tools: await mcpServerTools(c.req.param('name')) }));
app.post('/api/mcp-servers/:name/sign-in', async (c) => {
	const { origin, client } = await body(
		c,
		v.object({
			origin: v.pipe(v.string(), v.maxLength(300)),
			client: v.optional(v.nullable(v.object({ clientId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)), clientSecret: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))) }))),
		}),
	);
	const { url } = await beginMcpSignIn(c.req.param('name'), origin, client);
	return c.json({ url, mcpServers: await mcpServersView() });
});
app.delete('/api/mcp-servers/:name/sign-in', async (c) => {
	await signOutOfMcpServer(c.req.param('name'));
	return c.json({ mcpServers: await mcpServersView() });
});
// A server's sign-in sends the browser back here; it goes on to Settings › Connectors, which says how it went.
app.get('/api/mcp-servers/callback', async (c) => {
	const back = new URLSearchParams();
	try {
		const name = await finishMcpSignIn(new URL(c.req.url).searchParams);
		back.set('c', `mcp:${name}`);
		back.set('connected', name);
	} catch (error) {
		// No server is known when the sign-in is not, so Connectors itself says what went wrong.
		back.set('problem', error instanceof Error ? error.message : String(error));
		return c.redirect(`/settings/connectors?${back}`);
	}
	return c.redirect(`/settings/connectors/view?${back}`);
});

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
			fullVm: v.optional(v.boolean()),
			followUps: v.optional(v.boolean()),
			reviewOthers: v.optional(v.boolean()),
		}),
	);
	return c.json(await updateSettings(c.req.param('id'), change));
});
/** When a routine runs; fields left out take their defaults, and `scheduleProblem` checks the whole. */
const SCHEDULE = v.object({
	frequency: v.picklist(FREQUENCIES),
	time: v.optional(v.pipe(v.string(), v.regex(/^\d{2}:\d{2}$/))),
	everyHours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12))),
	days: v.optional(v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6))), v.maxLength(7))),
	dayOfMonth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(28))),
	cron: v.optional(v.pipe(v.string(), v.maxLength(200))),
	timeZone: v.optional(v.pipe(v.string(), v.maxLength(64))),
});
app.get('/api/projects/:id/automations', async (c) => c.json({ automations: await automations(c.req.param('id')) }));
app.post('/api/projects/:id/automations', async (c) => {
	const input = await body(
		c,
		v.object({
			kind: v.picklist(['issues', 'schedule']),
			label: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(50)))),
			schedule: v.optional(v.nullable(SCHEDULE)),
			prompt: v.pipe(v.string(), v.maxLength(20_000)),
			model: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
			reasoning: v.optional(v.nullable(REASONING)),
			planFirst: v.optional(v.boolean()),
			spaceId: v.optional(v.nullable(v.string())),
		}),
	);
	return c.json(await addAutomation(c.req.param('id'), input));
});
app.patch('/api/automations/:id', async (c) => {
	const { enabled } = await body(c, v.object({ enabled: v.boolean() }));
	return c.json(await setAutomationEnabled(c.req.param('id'), enabled));
});
app.put('/api/automations/:id', async (c) => {
	const input = await body(
		c,
		v.object({
			projectId: v.optional(v.nullable(v.string())),
			kind: v.picklist(['issues', 'schedule']),
			label: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(50)))),
			schedule: v.optional(v.nullable(SCHEDULE)),
			prompt: v.pipe(v.string(), v.maxLength(20_000)),
			model: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
			reasoning: v.optional(v.nullable(REASONING)),
			planFirst: v.optional(v.boolean()),
		}),
	);
	return c.json(await editAutomation(c.req.param('id'), input));
});
app.post('/api/automations/:id/run', async (c) => c.json(await runAutomation(c.req.param('id'), { force: true })));
app.delete('/api/automations/:id', async (c) => {
	await removeAutomation(c.req.param('id'));
	return c.json({ ok: true });
});
app.get('/api/projects/:id/branches', async (c) => c.json({ branches: await branches(c.req.param('id')) }));
app.get('/api/projects/:id/files', async (c) => c.json({ paths: await projectFiles(c.req.param('id'), c.req.query('branch')) }));

// Projects: a coordinator conversation over parallel threads, each a task on one of the project's repositories, or a chat when it has none.
const SPACE_FIELDS = {
	name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80))),
	// A drawn icon and optional tint, like "rocket" or "rocket:violet"; never an emoji.
	icon: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(40), v.regex(/^[a-z0-9-]+(:[a-z0-9-]+)?$/, 'Pick an icon from the list')))),
	goal: v.optional(v.pipe(v.string(), v.maxLength(300))),
	instructions: v.optional(v.pipe(v.string(), v.maxLength(MAX_INSTRUCTIONS))),
	autonomy: v.optional(v.picklist(['start', 'propose'])),
	maxParallel: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10))),
};
app.get('/api/spaces', async (c) => c.json({ spaces: await spacesView() }));
app.post('/api/spaces', async (c) => {
	const input = await body(
		c,
		v.object({ ...SPACE_FIELDS, name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)), repoIds: v.optional(v.pipe(v.array(v.string()), v.maxLength(20)), []) }),
	);
	return c.json(await createSpace(input));
});
app.get('/api/spaces/:id', async (c) => c.json(await spaceView(c.req.param('id'))));
app.patch('/api/spaces/:id', async (c) => {
	const change = await body(
		c,
		v.object({
			...SPACE_FIELDS,
			memory: v.optional(v.pipe(v.string(), v.maxLength(MAX_SPACE_MEMORY))),
			coordinatorModel: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
			coordinatorReasoning: v.optional(v.nullable(REASONING)),
			threadModel: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
			threadReasoning: v.optional(v.nullable(REASONING)),
			state: v.optional(v.picklist(['active', 'paused', 'archived'])),
			repoIds: v.optional(v.pipe(v.array(v.string()), v.maxLength(20))),
		}),
	);
	return c.json(await editSpace(c.req.param('id'), change));
});
app.delete('/api/spaces/:id', async (c) => {
	await removeSpace(c.req.param('id'));
	return c.json({ ok: true });
});
app.get('/api/spaces/:id/threads', async (c) => {
	const space = await spaceView(c.req.param('id'));
	return c.json({ threads: await listThreads(space.id) });
});
app.post('/api/spaces/:id/threads', async (c) => {
	const input = await body(
		c,
		v.object({
			title: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
			brief: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40_000)),
			// null starts a thread with no repository, a chat.
			projectId: v.optional(v.nullable(v.string())),
			repo: v.optional(v.string()),
			model: v.optional(v.string()),
			reasoning: v.optional(REASONING),
			planMode: v.optional(v.boolean()),
		}),
	);
	const thread = await startThread(c.req.param('id'), input);
	// You started it, not the coordinator: it hears of it, and its feed shows it as it starts.
	await threadStarted(thread.id, { by: 'you', brief: input.brief });
	return c.json(thread);
});
app.post('/api/spaces/:id/threads/:threadId/nudge', async (c) => {
	const { text } = await body(c, v.object({ text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(20_000)) }));
	return c.json(await nudgeThread(c.req.param('id'), c.req.param('threadId'), text));
});
app.get('/api/spaces/:id/usage', async (c) => c.json(await spaceUsage(c.req.param('id'))));
app.get('/api/spaces/:id/automations', async (c) => c.json({ automations: await spaceAutomations(c.req.param('id')) }));
app.post('/api/spaces/:id/automations', async (c) => {
	const { projectId, ...input } = await body(
		c,
		v.object({
			projectId: v.nullable(v.string()),
			kind: v.picklist(['issues', 'schedule']),
			label: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(50)))),
			schedule: v.optional(v.nullable(SCHEDULE)),
			prompt: v.pipe(v.string(), v.maxLength(20_000)),
			model: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
			reasoning: v.optional(v.nullable(REASONING)),
			planFirst: v.optional(v.boolean()),
		}),
	);
	return c.json(await addAutomation(projectId || null, { ...input, spaceId: c.req.param('id') }));
});
app.get('/api/spaces/:id/files', async (c) => c.json({ files: await listSpaceFiles(c.req.param('id')) }));
app.get('/api/spaces/:id/file', async (c) => {
	const path = c.req.query('path') ?? '';
	return bytes(c, await readSpaceFile(c.req.param('id'), path), contentType(path));
});
app.post('/api/spaces/:id/files', async (c) => {
	const name = c.req.query('name') ?? '';
	if (!name) throw new InvalidInputError('Name the file');
	if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be added to the Library.');
	return c.json(await uploadSpaceFile(c.req.param('id'), name, new Uint8Array(await c.req.arrayBuffer()), c.req.header('content-type') || undefined));
});
// A file attached to a message to the coordinator or a new thread's brief: saved to the project's Library, which every thread reads.
app.post('/api/spaces/:id/attachments', async (c) => {
	const name = c.req.query('name') ?? '';
	if (!name) throw new InvalidInputError('Name the file');
	if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be attached.');
	return c.json(await attachToProject(c.req.param('id'), name, new Uint8Array(await c.req.arrayBuffer()), c.req.header('content-type') || undefined));
});
app.delete('/api/spaces/:id/file', async (c) => {
	await removeSpaceFile(c.req.param('id'), c.req.query('path') ?? '');
	return c.json({ ok: true });
});

app.get('/api/sessions', async (c) => c.json({ sessions: await listSessions() }));
app.get('/api/sessions/:id/skills', async (c) => c.json({ skills: await sessionSkills(c.req.param('id')) }));
app.post('/api/sessions', async (c) => {
	const input = await body(
		c,
		v.object({
			// Left out for a chat, which has no repository.
			projectId: v.optional(v.string()),
			branch: v.optional(v.string()),
			model: v.optional(v.string()),
			reasoning: v.optional(REASONING),
			route: v.optional(ROUTE),
			title: v.optional(v.pipe(v.string(), v.maxLength(200))),
			// The first message, which a fast model names the task from.
			titleFrom: v.optional(v.pipe(v.string(), v.maxLength(40_000))),
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
			route: v.optional(ROUTE),
			planMode: v.optional(v.boolean()),
			pinned: v.optional(v.boolean()),
			resolved: v.optional(v.boolean()),
			spaceId: v.optional(v.nullable(v.string())),
		}),
	);
	const { spaceId, ...rest } = change;
	if (spaceId !== undefined) await moveToSpace(c.req.param('id'), spaceId);
	return c.json(await editSession(c.req.param('id'), rest));
});
app.post('/api/sessions/:id/fork', async (c) => c.json(await forkSession(c.req.param('id'))));
// A project's thread keeps the files it saved, as project files; the answer says where.
app.delete('/api/sessions/:id', async (c) => c.json(await deleteTask(c.req.param('id'))));
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
// The panel's live view is on screen: keep following its page for a while.
app.post('/api/sessions/:id/browser/watch', async (c) => c.json(await watchBrowser(c.req.param('id'))));
// The Computer panel: the desktop inside the task's sandbox. Viewing never starts it; Start computer does.
app.get('/api/sessions/:id/computer', async (c) => c.json(await computerView(c.req.param('id'))));
app.post('/api/sessions/:id/computer', async (c) => c.json(await startComputer(c.req.param('id'))));
app.post('/api/sessions/:id/computer/stop', async (c) => c.json(await stopComputer(c.req.param('id'))));
app.post('/api/sessions/:id/computer/connect', async (c) => c.json(await connectComputer(c.req.param('id'))));
app.post('/api/sessions/:id/computer/control', async (c) => {
	const { driver } = await body(c, v.object({ driver: v.picklist(['user', 'agent']) }));
	return c.json(await setComputerControl(c.req.param('id'), driver));
});
app.post('/api/sessions/:id/computer/screenshot', async (c) => c.json(await computerScreenshot(c.req.param('id'))));
// A reply's trace: its model and tool calls on one clock, what went into each call's context, and the cache.
app.get('/api/sessions/:id/traces/:trace', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	const trace = await getTrace(id, c.req.param('trace'));
	if (!trace) throw new NotFoundError('That reply has no trace kept');
	return c.json(trace);
});
app.get('/api/sessions/:id/subagents', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ runs: await subagentRuns(id) });
});
// One subagent stopped on its own: the agent gets what it had done and carries on.
app.post('/api/sessions/:id/subagents/:run/stop', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	if (!(await stopSubagent(id, c.req.param('run')))) throw new ConflictError('That agent is not running, or cannot be stopped on its own; use Stop to stop the whole reply');
	return c.json({ ok: true });
});
app.get('/api/sessions/:id/scripts', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ scripts: await scriptCalls(id) });
});
// Emails the agent asked to send; only your Send here sends one (services/mail.ts).
app.get('/api/sessions/:id/mail', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ approvals: await mailApprovals(id) });
});
app.post('/api/sessions/:id/mail/:approval', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	const { send } = await body(c, v.object({ send: v.boolean() }));
	return c.json(await decideSend(id, c.req.param('approval'), send));
});
app.get('/api/sessions/:id/todos', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ list: await todosFor(id) });
});
// Where the agent read each message sent while it worked, for the thread to show it there.
app.get('/api/sessions/:id/joins', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ joins: await joinsFor(id) });
});
// What the agent is doing this moment; later changes come whole over /api/events.
app.get('/api/sessions/:id/now', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ now: agentNow(id) });
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
// A page the agent wrote with render_html: the frame page the thread shows, and the page inside it (src/services/renders.ts).
app.get('/api/sessions/:id/render-frame', async (c) => {
	const { html, csp } = await pageFrame(c.req.param('id'), c.req.query('path') ?? '');
	return c.html(html, 200, { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
});
app.get('/api/sessions/:id/render', async (c) => {
	const html = await renderPage(c.req.param('id'), c.req.query('path') ?? '');
	// Served with its state as it stands, so never from a cache.
	return c.html(html, 200, { 'Content-Security-Policy': PAGE_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
});
// The state every open copy of a page shares: its frame page reads it after a change elsewhere, and saves the page's own changes.
app.get('/api/sessions/:id/page-state', async (c) => c.json(await pageState(c.req.param('id'), c.req.query('path') ?? ''), 200, { 'Cache-Control': 'no-store' }));
app.put('/api/sessions/:id/page-state', async (c) => c.json(await savePageState(c.req.param('id'), c.req.query('path') ?? '', await c.req.json().catch(() => null))));
// A request the page makes, which its frame page hands to Anton to make for it (src/services/page-fetch.ts).
app.post('/api/sessions/:id/page-fetch', async (c) => c.json(await pageFetch(c.req.param('id'), c.req.query('path') ?? '', await c.req.json().catch(() => null)), 200, { 'Cache-Control': 'no-store' }));
// Everything the agent made in every task, for the Artifacts page.
app.get('/api/artifacts', async (c) => c.json({ artifacts: await listArtifacts() }));
// Adding a file to the Library: the body is the file, its name in the query.
app.post('/api/sessions/:id/outputs', async (c) => {
	const name = c.req.query('name') ?? '';
	if (!name) throw new InvalidInputError('Name the file');
	if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be added to the Library.');
	const body = new Uint8Array(await c.req.arrayBuffer());
	return c.json({ path: await uploadOutput(c.req.param('id'), name, body, c.req.header('content-type') || undefined) });
});
// A file attached to a message: saved to the task's Library and read as text for the message (src/services/attachments.ts).
app.post('/api/sessions/:id/attachments', async (c) => {
	const name = c.req.query('name') ?? '';
	if (!name) throw new InvalidInputError('Name the file');
	if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be attached.');
	return c.json(await attachToTask(c.req.param('id'), name, new Uint8Array(await c.req.arrayBuffer()), c.req.header('content-type') || undefined));
});
app.delete('/api/sessions/:id/output', async (c) => {
	await removeOutput(c.req.param('id'), c.req.query('path') ?? '');
	return c.json({ ok: true });
});

export default app;
