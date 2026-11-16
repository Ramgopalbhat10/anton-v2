import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import * as v from 'valibot';
import { getProviders } from '../providers/index.ts';
import { openRouterKey } from '../providers/openrouter/key.ts';
import { hostRunnerAvailable } from '../services/tasks/runners.ts';
import { reviewQueue } from '../services/git/reviews.ts';
import { reviewPullRequest } from '../services/git/review-tasks.ts';
import { streamChanges } from '../services/tasks/change-stream.ts';
import { recentProblems } from '../core/log.ts';
import { body } from './shared.ts';

/** Server-wide routes: the change stream, health, where commands run, recent problems, and the review queue. */
const app = new Hono();

// Open pages learn what changed from here and refetch just that, instead of polling.
app.get('/api/events', (c) => streamSSE(c, (stream) => streamChanges(stream)));

app.get('/api/health', (c) =>
	c.json({
		ok: true,
		openRouter: openRouterKey() !== null,
		providers: { sandbox: getProviders().sandbox.name, store: getProviders().store.name, git: getProviders().git.name },
	}),
);

// Where a task's commands can run, for the composer's Run on menu: its sandbox, and this server when that is another place.
app.get('/api/runners', (c) => c.json({ sandbox: getProviders().sandbox.name, host: hostRunnerAvailable() }));

app.get('/api/logs', (c) => c.json({ logs: recentProblems() }));

app.get('/api/reviews', async (c) => c.json({ reviews: await reviewQueue() }));
// Reviews any pull request by its link, in a task of its own unless Anton opened it.
app.post('/api/reviews', async (c) => {
	const { url } = await body(c, v.object({ url: v.pipe(v.string(), v.maxLength(500)) }));
	return c.json(await reviewPullRequest(url), 201);
});

export const miscRoutes = app;
