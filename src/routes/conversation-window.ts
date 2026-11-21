import { Hono } from 'hono';
import { InvalidInputError } from '../core/errors.ts';
import { type HistorySnapshot, latestTurns, turnsBefore, turnsFrom, turnsParam, WINDOW_TURNS } from '../core/conversation-window.ts';

export type HistoryRouter = { request: (path: string) => Response | Promise<Response> };

const CONVERSATION = '/api/agents/:kind{coder|coordinator|incognito}/:id';

/**
 * `?view=history&turns=N`: Flue's history with only its latest turns, so a long conversation opens at the cost of a
 * short one; with `from=<id>` as well, from that message on (a read again keeps its start). Without `turns` the request
 * goes on to Flue's router untouched. `/older?before=<id>&turns=N`: the turns
 * before a message, as the page scrolls up; 409 when that message is gone (rewound or compacted since).
 */
export function conversationWindow(routerFor: (kind: string) => HistoryRouter): Hono {
	const app = new Hono();
	const history = (kind: string, id: string) => routerFor(kind).request(`/${encodeURIComponent(id)}?view=history`);
	app.get(CONVERSATION, async (c, next) => {
		const turns = turnsParam(c.req.query('turns'));
		if (c.req.query('view') !== 'history' || !turns) return next();
		const response = await history(c.req.param('kind'), c.req.param('id'));
		if (!response.ok) return response;
		const headers = new Headers(response.headers);
		headers.delete('content-length');
		// Flue's `no-store` would make the browser fetch the whole window on every open. The window is revalidated instead
		// (`conditionalJson` tags it), so a conversation unchanged since it was last opened costs an empty 304.
		headers.set('cache-control', 'private, no-cache');
		const snapshot = (await response.json()) as HistorySnapshot;
		const from = c.req.query('from');
		return new Response(JSON.stringify(from ? turnsFrom(snapshot, from, turns) : latestTurns(snapshot, turns)), { status: 200, headers });
	});
	app.get(`${CONVERSATION}/older`, async (c) => {
		const before = c.req.query('before');
		if (!before) throw new InvalidInputError('before is required');
		const response = await history(c.req.param('kind'), c.req.param('id'));
		if (!response.ok) return response;
		const page = turnsBefore((await response.json()) as HistorySnapshot, before, turnsParam(c.req.query('turns')) ?? WINDOW_TURNS);
		if (!page) return c.json({ error: 'That message is no longer in the conversation' }, 409);
		return c.json(page);
	});
	return app;
}
