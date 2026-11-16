import { Hono } from 'hono';
import { createAgentRouter } from '@flue/runtime/routing';
import * as v from 'valibot';
import { Coder } from '../agents/coder/index.ts';
import { Reviewer } from '../agents/reviewer.ts';
import { Coordinator } from '../agents/coordinator.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import { purgeIncognito } from '../db/adapter.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getSpace } from '../db/spaces.ts';
import { isIncognitoId } from '../core/incognito.ts';
import { mobileApi } from '../api/mobile.ts';
import { noteSending, setAgentAbort } from '../services/tasks/activity.ts';
import { MAX_UPLOAD_BYTES } from '../services/artifacts/files.ts';
import { primeIncognitoModel, forgetModelChoice } from '../services/tasks/sessions.ts';
import { isRestoring } from '../services/git/restore.ts';
import { noteRepliesStopping } from '../services/tasks/subagent-runs.ts';
import { primeAgent, primeIncognito, releaseIncognito } from '../services/tasks/agent-runner.ts';
import { resetFollowUps } from '../services/git/follow-ups.ts';
import { primeCoordinator } from '../services/projects/coordinator.ts';
import { incognitoAttachment } from '../services/artifacts/attachments.ts';
import { assertWithinBudget } from '../services/models/budget.ts';
import { REASONING, ROUTE, body } from './shared.ts';

/** The agents' HTTP surface: Flue's routers for the Coder and each project's coordinator, with the checks that run before a message reaches them, incognito chats, and the Android app's read API. */
const app = new Hono();

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
// An incognito chat: a throwaway conversation the runtime keeps in memory only — no session record,
// no files, nothing on disk. Its model choice lives in memory too, set by the page before it writes.
app.post('/api/incognito/attach', async (c) => {
	const name = (c.req.query('name') ?? 'file').slice(0, 300);
	const bytes = new Uint8Array(await c.req.arrayBuffer());
	if (!bytes.length) throw new InvalidInputError('The file is empty');
	if (bytes.length > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be attached.');
	return c.json(await incognitoAttachment(name, bytes));
});
app.post('/api/incognito/:id', async (c) => {
	const id = c.req.param('id');
	if (!isIncognitoId(id)) throw new NotFoundError('Not found');
	const input = await body(c, v.object({ model: v.optional(v.string()), reasoning: v.optional(v.nullable(REASONING)), route: v.optional(ROUTE) }));
	await primeIncognitoModel(id, input);
	return c.json({ ok: true });
});
app.delete('/api/incognito/:id', (c) => {
	const id = c.req.param('id');
	if (isIncognitoId(id)) {
		// Answer at once; aborting the reply, releasing its state and purging its rows run behind
		// the response, so closing a chat never waits on any of it.
		void (async () => {
			try {
				await agents.request(`/${encodeURIComponent(id)}/abort`, { method: 'POST' });
			} catch {
				// Already gone.
			}
			releaseIncognito(id);
			forgetModelChoice(id);
			// Everything the chat wrote lives in the in-memory store; delete it now, and once more
			// after the abort's settlement lands so its last writes go too.
			purgeIncognito(id);
			setTimeout(() => purgeIncognito(id), 2_000).unref();
		})().catch(() => undefined);
	}
	return c.json({ ok: true });
});
// Its messages ride the same agent router as tasks, under their own path: the check is the incognito
// prefix rather than a session record, since there is none.
app.post('/api/agents/incognito/:id', async (c, next) => {
	const id = c.req.param('id');
	if (!isIncognitoId(id)) throw new NotFoundError('Session not found');
	await assertWithinBudget(id);
	await primeIncognito(id);
	await primeIncognitoModel(id);
	await next();
});
app.post('/api/agents/incognito/:id/abort', async (c, next) => {
	await next();
});
app.route('/api/agents/incognito', agents as never);
// The Android app's read surface: stable DTOs over the internal shapes, and a transcript
// normalized from the agent router instead of flue's wire protocol.
const coordinators = createAgentRouter(Coordinator);
app.route('/api/mobile', mobileApi(agents as never, coordinators as never));
// A project's coordinator, one conversation per project; like a prompt to a task, a message is checked
// against the daily cap, and the coordinator loads a fresh picture of its project before it renders.
app.post('/api/agents/coordinator/:id', async (c, next) => {
	const id = c.req.param('id');
	if (!(await getSpace(id))) throw new NotFoundError('Project not found');
	await assertWithinBudget(id);
	await primeCoordinator(id);
	await next();
});
app.route('/api/agents/coordinator', coordinators as never);
// The reviewer is never served over HTTP; its router only stops it.
const reviewers = createAgentRouter(Reviewer);
setAgentAbort(async (id) => {
	const path = `/${encodeURIComponent(id)}/abort`;
	const routers = id.startsWith('space_') ? [coordinators] : [agents, reviewers];
	await Promise.all(routers.map((router) => router.request(path, { method: 'POST' })));
});

export const agentRoutes = app;
