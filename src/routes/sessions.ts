import { Hono } from 'hono';
import * as v from 'valibot';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import { isIncognitoId } from '../core/incognito.ts';
import { pageFetch } from '../services/browser/page-fetch.ts';
import { PAGE_CSP, pageFrame, pageState, renderPage, savePageState } from '../services/artifacts/renders.ts';
import { changesView, fileTree, MAX_UPLOAD_BYTES, outputsView, readFile, readOutputFile, removeOutput, uploadOutput } from '../services/artifacts/files.ts';
import { wakeMachine } from '../services/sandbox/workspace.ts';
import { sessionSkills } from '../services/settings/plugins.ts';
import { createSession, getSession, listSessions, editSession, fallbackModel, switchToFallbackModel, forkSession, resumeSession, stopSession } from '../services/tasks/sessions.ts';
import { listCheckpoints, readCheckpointPatchAt } from '../services/git/checkpoints.ts';
import { previewsView } from '../services/browser/previews.ts';
import { computerScreenshot, computerView, connectBrowser, connectComputer, setComputerControl, startComputer, stopComputer } from '../services/browser/computer.ts';
import { browserScreenshot, browserView, clearHighlight, closeBrowser, inspectAt, navigate, openBrowser, watchBrowser } from '../services/browser/live-browser.ts';
import { restoreCheckpoint, revertFile } from '../services/git/restore.ts';
import { getSettledTrace, getTrace } from '../db/traces.ts';
import { stopSubagent, subagentRuns } from '../services/tasks/subagent-runs.ts';
import { scriptCalls } from '../services/tasks/script-runs.ts';
import { todosFor } from '../services/replies/todos.ts';
import { joinsFor } from '../services/tasks/joins.ts';
import { answerWithin } from '../services/tasks/answer-within.ts';
import { waitingMessages } from '../services/tasks/waiting.ts';
import { agentNow } from '../services/tasks/agent-now.ts';
import { contextView } from '../services/context/context-usage.ts';
import { deleteTask, moveToSpace } from '../services/projects/spaces.ts';
import { attachToTask } from '../services/artifacts/attachments.ts';
import { decideSend, mailApprovals } from '../services/connectors/mail.ts';
import { decideToolApproval, toolApprovals } from '../services/connectors/tool-approvals.ts';
import { mergePullRequest, pullRequestDetail, pullRequestMetadata, pullRequestDiff, pullRequestsOf, pullRequestView } from '../services/git/pull-requests.ts';
import { requestReview } from '../services/git/code-review.ts';
import { REASONING, ROUTE, body, contentType, bytes } from './shared.ts';

const app = new Hono();

const RUN_ON = v.picklist(['sandbox', 'host']);

app.get('/api/sessions', async (c) => c.json({ sessions: await listSessions() }));
app.get('/api/sessions/:id/skills', async (c) => c.json({ skills: await sessionSkills(c.req.param('id')) }));
app.post('/api/sessions', async (c) => {
	const input = await body(
		c,
		v.object({
			// Chosen by the page, so it can open the task while it is made.
			id: v.optional(v.pipe(v.string(), v.uuid())),
			projectId: v.optional(v.string()),
			branch: v.optional(v.string()),
			model: v.optional(v.string()),
			reasoning: v.optional(REASONING),
			route: v.optional(ROUTE),
			title: v.optional(v.pipe(v.string(), v.maxLength(200))),
			titleFrom: v.optional(v.pipe(v.string(), v.maxLength(40_000))),
			planMode: v.optional(v.boolean()),
			runOn: v.optional(RUN_ON),
		}),
	);
	return c.json(await createSession(input));
});
// An incognito chat has no session record: its session lookups get empty views rather than a 404 on every poll.
const INCOGNITO_SESSION_VIEWS: Record<string, unknown> = {
	'': null,
	'/waiting': { messages: [] },
	'/joins': { joins: [] },
	'/files': { paths: [] },
	'/now': { now: null },
	'/subagents': { runs: [] },
	'/outputs': { source: null, at: null, outputs: [], deleted: [] },
};
app.use('/api/sessions/*', async (c, next) => {
	if (c.req.method === 'GET') {
		const rest = c.req.path.slice('/api/sessions/'.length);
		const slash = rest.indexOf('/');
		const id = slash === -1 ? rest : rest.slice(0, slash);
		const sub = slash === -1 ? '' : rest.slice(slash);
		if (isIncognitoId(id) && Object.hasOwn(INCOGNITO_SESSION_VIEWS, sub)) return c.json(INCOGNITO_SESSION_VIEWS[sub]);
	}
	await next();
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
			runOn: v.optional(RUN_ON),
		}),
	);
	const { spaceId, ...rest } = change;
	if (spaceId !== undefined) await moveToSpace(c.req.param('id'), spaceId);
	return c.json(await editSession(c.req.param('id'), rest));
});
app.get('/api/sessions/:id/fallback', async (c) => c.json({ fallback: await fallbackModel(c.req.param('id')) }));
app.post('/api/sessions/:id/fallback', async (c) => c.json(await switchToFallbackModel(c.req.param('id'))));
app.post('/api/sessions/:id/fork', async (c) => c.json(await forkSession(c.req.param('id'))));
// Saving a task's files and stopping its sandbox can outlast the proxy's 100 seconds: past ANSWER_MS the
// page hears it is under way and the work carries on.
app.delete('/api/sessions/:id', async (c) => {
	const id = c.req.param('id');
	return c.json(await answerWithin(deleteTask(id), () => ({ kept: [], pending: true }), 'Deleting the task', id));
});
app.post('/api/sessions/:id/review', async (c) => c.json({ started: await requestReview(c.req.param('id'), { automatic: false }) }));
app.post('/api/sessions/:id/stop', async (c) => {
	const id = c.req.param('id');
	return c.json(await answerWithin(stopSession(id), () => getSession(id), 'Stopping the sandbox', id));
});
app.post('/api/sessions/:id/wake', async (c) => c.json(await wakeMachine(c.req.param('id'))));
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
	const { path, to } = await body(c, v.object({ path: v.pipe(v.string(), v.minLength(1)), to: v.optional(v.picklist(['base', 'pushed'])) }));
	await revertFile(c.req.param('id'), path, to);
	return c.json({ ok: true });
});
app.get('/api/sessions/:id/previews', async (c) => c.json(await previewsView(c.req.param('id'))));
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
app.post('/api/sessions/:id/browser/watch', async (c) => c.json(await watchBrowser(c.req.param('id'))));
// Viewing never starts the computer; Start computer does.
app.get('/api/sessions/:id/computer', async (c) => c.json(await computerView(c.req.param('id'))));
app.post('/api/sessions/:id/computer', async (c) => c.json(await startComputer(c.req.param('id'))));
app.post('/api/sessions/:id/computer/stop', async (c) => c.json(await stopComputer(c.req.param('id'))));
app.post('/api/sessions/:id/computer/connect', async (c) => c.json(await connectComputer(c.req.param('id'))));
app.post('/api/sessions/:id/computer/browser', async (c) => c.json(await connectBrowser(c.req.param('id'))));
app.post('/api/sessions/:id/computer/control', async (c) => {
	const { driver } = await body(c, v.object({ driver: v.picklist(['user', 'agent']) }));
	return c.json(await setComputerControl(c.req.param('id'), driver));
});
app.post('/api/sessions/:id/computer/screenshot', async (c) => c.json(await computerScreenshot(c.req.param('id'))));
// What a failed or stopped reply's finish hook would have put on its message.
app.get('/api/sessions/:id/settled/:submission', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	const trace = await getSettledTrace(id, c.req.param('submission'));
	return c.json({ metadata: trace?.settled?.metadata ?? null });
});
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
app.post('/api/sessions/:id/subagents/:run/stop', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	if (!(await stopSubagent(id, c.req.param('run')))) throw new ConflictError('That agent is not running, or cannot be stopped on its own; use Stop to stop the whole reply');
	return c.json({ ok: true });
});
app.get('/api/sessions/:id/scripts', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ scripts: await scriptCalls(id) });
});
// Only your Send here sends one.
app.get('/api/sessions/:id/mail', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ approvals: await mailApprovals(id) });
});
app.post('/api/sessions/:id/mail/:approval', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	const { send } = await body(c, v.object({ send: v.boolean() }));
	return c.json(await decideSend(id, c.req.param('approval'), send));
});
// Only your Run here runs one.
app.get('/api/sessions/:id/tool-approvals', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ approvals: await toolApprovals(id) });
});
app.post('/api/sessions/:id/tool-approvals/:approval', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	const { run } = await body(c, v.object({ run: v.boolean() }));
	return c.json(await decideToolApproval(id, c.req.param('approval'), run));
});
app.get('/api/sessions/:id/todos', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ list: await todosFor(id) });
});
app.get('/api/sessions/:id/joins', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ joins: await joinsFor(id) });
});
app.get('/api/sessions/:id/waiting', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ messages: await waitingMessages(id) });
});
app.get('/api/sessions/:id/now', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json({ now: agentNow(id) });
});
app.get('/api/sessions/:id/context', async (c) => {
	const { id } = await getSession(c.req.param('id'));
	return c.json(await contextView(id));
});
app.get('/api/sessions/:id/pull-request', async (c) => c.json(await pullRequestView(c.req.param('id'))));
app.get('/api/sessions/:id/pulls', async (c) => c.json({ pulls: await pullRequestsOf(c.req.param('id')) }));
const pullNumber = (c: { req: { param: (name: 'number') => string } }) => {
	const number = Number(c.req.param('number'));
	if (!Number.isInteger(number) || number <= 0) throw new InvalidInputError('Not a pull request number');
	return number;
};
app.get('/api/sessions/:id/pulls/:number', async (c) => c.json(await pullRequestDetail(c.req.param('id'), pullNumber(c))));
app.get('/api/sessions/:id/pulls/:number/metadata', async (c) => c.json(await pullRequestMetadata(c.req.param('id'), pullNumber(c))));
app.get('/api/sessions/:id/pulls/:number/diff', async (c) => c.json({ patch: await pullRequestDiff(c.req.param('id'), pullNumber(c)) }));
app.post('/api/sessions/:id/pulls/:number/merge', async (c) => {
	const input = await body(c, v.object({ method: v.optional(v.picklist(['squash', 'merge', 'rebase'])), sha: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))) }));
	return c.json(await mergePullRequest(c.req.param('id'), pullNumber(c), input));
});

app.get('/api/sessions/:id/changes', async (c) => c.json(await changesView(c.req.param('id'), c.req.query('scope') === 'branch' ? 'branch' : 'unpushed')));
app.get('/api/sessions/:id/files', async (c) => c.json(await fileTree(c.req.param('id'))));
app.get('/api/sessions/:id/file', async (c) => bytes(c, await readFile(c.req.param('id'), c.req.query('path') ?? '')));
app.get('/api/sessions/:id/outputs', async (c) => c.json(await outputsView(c.req.param('id'))));
app.get('/api/sessions/:id/output', async (c) => {
	const path = c.req.query('path') ?? '';
	return bytes(c, await readOutputFile(c.req.param('id'), path), contentType(path));
});
app.get('/api/sessions/:id/render-frame', async (c) => {
	const { html, csp } = await pageFrame(c.req.param('id'), c.req.query('path') ?? '');
	return c.html(html, 200, { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
});
app.get('/api/sessions/:id/render', async (c) => {
	const html = await renderPage(c.req.param('id'), c.req.query('path') ?? '');
	return c.html(html, 200, { 'Content-Security-Policy': PAGE_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
});
app.get('/api/sessions/:id/page-state', async (c) => c.json(await pageState(c.req.param('id'), c.req.query('path') ?? ''), 200, { 'Cache-Control': 'no-store' }));
app.put('/api/sessions/:id/page-state', async (c) => c.json(await savePageState(c.req.param('id'), c.req.query('path') ?? '', await c.req.json().catch(() => null))));
app.post('/api/sessions/:id/page-fetch', async (c) => c.json(await pageFetch(c.req.param('id'), c.req.query('path') ?? '', await c.req.json().catch(() => null)), 200, { 'Cache-Control': 'no-store' }));

app.post('/api/sessions/:id/outputs', async (c) => {
	const name = c.req.query('name') ?? '';
	if (!name) throw new InvalidInputError('Name the file');
	if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be added to the Library.');
	const body = new Uint8Array(await c.req.arrayBuffer());
	return c.json({ path: await uploadOutput(c.req.param('id'), name, body, c.req.header('content-type') || undefined) });
});
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

export const sessionRoutes = app;
