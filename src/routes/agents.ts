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
import { mobileApi } from './mobile.ts';
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

const app = new Hono();

// The task counts as working from the moment the message arrives; a refused message undoes that.
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
// Incognito chats live in memory only: no session record, no files, nothing on disk.
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
		// Answer at once; aborting the reply and purging its state run behind the response.
		void (async () => {
			try {
				await agents.request(`/${encodeURIComponent(id)}/abort`, { method: 'POST' });
			} catch {
				// Already gone.
			}
			releaseIncognito(id);
			forgetModelChoice(id);
			// Purged now, and again after the abort settles so its last writes go too.
			purgeIncognito(id);
			setTimeout(() => purgeIncognito(id), 2_000).unref();
		})().catch(() => undefined);
	}
	return c.json({ ok: true });
});
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
const coordinators = createAgentRouter(Coordinator);
app.route('/api/mobile', mobileApi(agents as never, coordinators as never));
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
