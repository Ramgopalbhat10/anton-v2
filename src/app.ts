import { dispatch } from '@flue/runtime';
import { Hono } from 'hono';
import { Coder } from './agents/coder/index.ts';
import { Reviewer } from './agents/reviewer.ts';
import { Coordinator } from './agents/coordinator.ts';
import { statusOf } from './core/errors.ts';
import { appDb } from './db/client.ts';
import { publishUpgradeHandler } from './core/upgrades.ts';
import { recordAgentEvent } from './services/tasks/activity.ts';
import { noteReplyOutcome } from './services/projects/thread-reports.ts';
import { generalSettings } from './services/models/general.ts';
import { recordTurnUsage } from './services/models/usage.ts';
import { countReplyCall } from './services/models/response-usage.ts';
import { recordTraceEvent } from './services/context/response-trace.ts';
import { noteCompaction } from './services/replies/compaction-pin.ts';
import { recordSubagentEvent } from './services/tasks/subagent-runs.ts';
import { installSubagentStop } from './flue/subagent-stop.ts';
import { installToolResultCut } from './flue/tool-result-cut.ts';
import { noteTodoStep } from './services/replies/todos.ts';
import { noteRepoCheckEvent } from './services/sandbox/repo-check.ts';
import { recordJoinEvent } from './services/tasks/joins.ts';
import { recordAgentNow } from './services/tasks/agent-now.ts';
import { recordReplyText } from './services/replies/reply-check.ts';
import { backfillLatestInputs } from './services/tasks/latest-input.ts';
import { recordContext } from './services/context/context-usage.ts';
import { type DeliveredImage, primeAllAgents, setAgentDelivery } from './services/tasks/agent-runner.ts';
import { scheduleHeadlessWork } from './services/automations/headless.ts';
import { scheduleIdleStops } from './services/tasks/idle-stop.ts';
import { loadComposioKey } from './services/connectors/composio.ts';
import { stopIfOverBudget } from './services/models/budget.ts';
import { scheduleCleanup } from './services/settings/storage.ts';
import { recordPlanLimit, loadGatewayKey } from './services/models/subscriptions.ts';
import { handleTerminalUpgrade } from './services/tasks/terminal.ts';
import { logProblem, logRuntimeEvent } from './core/log.ts';
import { observeRuntime } from './services/tasks/runtime-observer.ts';
import { recordWebCall } from './services/context/web-digest.ts';
import { notifyFailedReply } from './services/notify/notifications.ts';
import { recordFailedReply } from './services/notify/push.ts';
import { keepSettledReply } from './services/replies/settled-reply.ts';
import { agentRoutes } from './routes/agents.ts';
import { miscRoutes } from './routes/misc.ts';
import { settingsRoutes } from './routes/settings.ts';
import { modelRoutes } from './routes/models.ts';
import { pluginRoutes } from './routes/plugins.ts';
import { notifyRoutes } from './routes/notify.ts';
import { connectorRoutes } from './routes/connectors.ts';
import { projectRoutes } from './routes/projects.ts';
import { automationRoutes } from './routes/automations.ts';
import { spaceRoutes } from './routes/spaces.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { artifactRoutes } from './routes/artifacts.ts';

const app = new Hono();

publishUpgradeHandler(handleTerminalUpgrade);
installSubagentStop();
installToolResultCut();
observeRuntime((event) => {
	recordAgentEvent(event);
	// Before anything awaits, so a reply's last call is counted by the time the reply finishes.
	countReplyCall(event as Parameters<typeof countReplyCall>[0]);
	// Before the step's tools run, so a todo update knows whether it was the step's only call.
	noteTodoStep(event as Parameters<typeof noteTodoStep>[0]);
	// A compaction of a task's conversation is noted before the end-of-reply hook that follows it, which pins the request and todo list.
	noteCompaction(event as Parameters<typeof noteCompaction>[0]);
	noteRepoCheckEvent(event as Parameters<typeof noteRepoCheckEvent>[0]);
	recordTraceEvent(event as Parameters<typeof recordTraceEvent>[0]);
	keepSettledReply(event as Parameters<typeof keepSettledReply>[0]);
	recordSubagentEvent(event as Parameters<typeof recordSubagentEvent>[0]);
	recordWebCall(event as Parameters<typeof recordWebCall>[0]);
	recordReplyText(event as Parameters<typeof recordReplyText>[0]);
	recordJoinEvent(event as Parameters<typeof recordJoinEvent>[0]);
	recordAgentNow(event as Parameters<typeof recordAgentNow>[0]);
	void recordContext(event as Parameters<typeof recordContext>[0]).catch((error: unknown) => logProblem('warn', 'Context usage not recorded', error));
	void recordPlanLimit(event as Parameters<typeof recordPlanLimit>[0]).catch((error: unknown) => logProblem('warn', 'Plan limit not recorded', error));
	logRuntimeEvent(event as Parameters<typeof logRuntimeEvent>[0]);
	recordFailedReply(event as Parameters<typeof recordFailedReply>[0]);
	noteReplyOutcome(event as Parameters<typeof noteReplyOutcome>[0]);
	notifyFailedReply(event as Parameters<typeof notifyFailedReply>[0]);
	void recordTurnUsage(event as Parameters<typeof recordTurnUsage>[0])
		.then((id) => (id ? stopIfOverBudget(id) : undefined))
		.catch((error: unknown) => logProblem('warn', 'Spending check failed', error));
});
// Migrate at boot, so a broken database shows in the log now rather than on the first request.
appDb()
	.then(() => backfillLatestInputs())
	// Background work (titles, web digests, compaction) reads Settings › General's models without waiting on the database.
	.then(() => generalSettings())
	.catch((error: unknown) => logProblem('error', 'Database migration failed', error));
scheduleCleanup();
const delivered = (text: string, images?: DeliveredImage[]) => (images?.length ? { kind: 'user' as const, body: text, attachments: images } : text);
setAgentDelivery(async (id, text, images) => void (await dispatch(Coder, { id, message: delivered(text, images) })));
setAgentDelivery(async (id, text, images) => void (await dispatch(Reviewer, { id, message: delivered(text, images) })), 'reviewer');
setAgentDelivery(async (id, text, images) => void (await dispatch(Coordinator, { id, message: delivered(text, images) })), 'coordinator');
// Before anything calls OpenRouter.
await loadGatewayKey().catch((error: unknown) => logProblem('warn', 'Could not load the OpenRouter key', error));
await loadComposioKey().catch((error: unknown) => logProblem('warn', 'Could not load the Composio key', error));
// Before the runtime resumes replies a restart cut off, so they run with their task's model and MCP servers.
await primeAllAgents().catch((error: unknown) => logProblem('warn', 'Could not load task models', error));
scheduleHeadlessWork();
scheduleIdleStops();

app.onError((error, c) => {
	const status = statusOf(error);
	if (status >= 500) logProblem('error', `${c.req.method} ${c.req.path} failed`, error);
	return c.json({ error: error.message }, status as 400);
});

// Hono copies a module's routes in when it is mounted, so mounting order is registration order:
// a module's checks (in front of the agent routers, the incognito views) stay in front of the routes they guard.
app.route('/', agentRoutes);
app.route('/', miscRoutes);
app.route('/', settingsRoutes);
app.route('/', modelRoutes);
app.route('/', pluginRoutes);
app.route('/', notifyRoutes);
app.route('/', connectorRoutes);
app.route('/', projectRoutes);
app.route('/', automationRoutes);
app.route('/', spaceRoutes);
app.route('/', sessionRoutes);
app.route('/', artifactRoutes);

export default app;
