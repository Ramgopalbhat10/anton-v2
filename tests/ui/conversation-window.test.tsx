import type { UseFlueAgentResult } from '@flue/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOlderTurns, WINDOW_TURNS, windowedFetch } from '@/lib/conversation-window';
import type { FlueClient } from '@flue/sdk';

type Message = UseFlueAgentResult['messages'][number];

const message = (id: string, role: 'user' | 'assistant' = id.startsWith('u') ? 'user' : 'assistant', parts: Message['parts'] = []) =>
	({ id, role, parts, display: 'visible' }) as unknown as Message;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const agentWith = (messages: Message[]) => ({ messages, status: 'ready', settlements: [] }) as unknown as UseFlueAgentResult;
const client = { attachmentUrl: (id: string) => `/files/${id}` } as unknown as FlueClient;

afterEach(() => vi.unstubAllGlobals());

describe('opening a conversation', () => {
	it('asks for the latest turns, then starts a read again at the same message', async () => {
		const asked: string[] = [];
		const base = vi.fn(async (input: RequestInfo | URL) => {
			asked.push(String(input));
			return json({ messages: [message('u5'), message('a5')], window: { before: 'u5', total: 12 } });
		});
		const fetcher = windowedFetch('/api/agents/coder/t1', base as typeof fetch);
		await fetcher('http://localhost/api/agents/coder/t1?view=history');
		await fetcher('http://localhost/api/agents/coder/t1?view=history');
		expect(asked[0]).toBe(`http://localhost/api/agents/coder/t1?view=history&turns=${WINDOW_TURNS}`);
		expect(asked[1]).toBe(`http://localhost/api/agents/coder/t1?view=history&turns=${WINDOW_TURNS}&from=u5`);
	});

	it('leaves the live updates, sends and other conversations alone', async () => {
		const base = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({}));
		const fetcher = windowedFetch('/api/agents/coder/t1', base as typeof fetch);
		await fetcher('http://localhost/api/agents/coder/t1?view=updates&offset=1');
		await fetcher('http://localhost/api/agents/coder/t1', { method: 'POST', body: '{}' });
		await fetcher('http://localhost/api/agents/coder/t2?view=history');
		expect(base.mock.calls.map(([input]) => String(input))).toEqual([
			'http://localhost/api/agents/coder/t1?view=updates&offset=1',
			'http://localhost/api/agents/coder/t1',
			'http://localhost/api/agents/coder/t2?view=history',
		]);
	});

	it('reads the whole history, as before, when the window fails on the server', async () => {
		const base = vi.fn(async (input: RequestInfo | URL) => (String(input).includes('turns=') ? json({ error: 'boom' }, 500) : json({ messages: [message('u0')] })));
		const response = await windowedFetch('/api/agents/coder/t3', base as typeof fetch)('http://localhost/api/agents/coder/t3?view=history');
		expect(base).toHaveBeenCalledTimes(2);
		expect(String(base.mock.calls[1][0])).toBe('http://localhost/api/agents/coder/t3?view=history');
		expect(((await response.json()) as { messages: Message[] }).messages[0].id).toBe('u0');
	});

	it('passes a refusal through for Flue to report', async () => {
		const response = await windowedFetch('/api/agents/coder/t4', (async () => json({ error: 'not found' }, 404)) as typeof fetch)('http://localhost/api/agents/coder/t4?view=history');
		expect(response.status).toBe(404);
	});
});

describe('scrolling up to older turns', () => {
	const open = async (path: string, live: Message[], before: string | null) => {
		await windowedFetch(path, (async () => json({ messages: live, window: { before, total: 40 } })) as typeof fetch)(`http://localhost${path}?view=history`);
		return renderHook(({ agent }) => useOlderTurns(path, client, agent), { initialProps: { agent: agentWith(live) } });
	};

	it('says there is more only when the opened window left turns out', async () => {
		const short = await open('/api/agents/coder/short', [message('u0'), message('a0')], null);
		expect(short.result.current.older?.more).toBe(false);
		const long = await open('/api/agents/coder/long', [message('u8'), message('a8')], 'u8');
		expect(long.result.current.older?.more).toBe(true);
	});

	it('puts each page in front, in order, with its files read through the conversation, and stops at the start', async () => {
		const path = '/api/agents/coder/pages';
		const pages: Record<string, unknown> = {
			u8: { messages: [message('u6'), message('a6', 'assistant', [{ type: 'file', id: 'f1', mediaType: 'image/png' }] as unknown as Message['parts'])], before: 'u6' },
			u6: { messages: [message('u4'), message('a4')], before: null },
		};
		const asked: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			asked.push(url);
			return json(pages[new URL(url, 'http://localhost').searchParams.get('before')!]);
		});
		const view = await open(path, [message('u8'), message('a8')], 'u8');
		act(() => view.result.current.older!.load());
		await waitFor(() => expect(view.result.current.messages.map((m) => m.id)).toEqual(['u6', 'a6', 'u8', 'a8']));
		expect((view.result.current.messages[1].parts[0] as { url?: string }).url).toBe('/files/f1');
		expect(view.result.current.older?.more).toBe(true);
		act(() => view.result.current.older!.load());
		await waitFor(() => expect(view.result.current.messages.map((m) => m.id)).toEqual(['u4', 'a4', 'u6', 'a6', 'u8', 'a8']));
		expect(view.result.current.older?.more).toBe(false);
		expect(asked).toEqual([`${path}/older?before=u8&turns=${WINDOW_TURNS}`, `${path}/older?before=u6&turns=${WINDOW_TURNS}`]);
	});

	it('keeps the pages while the conversation grows, and never shows a message twice', async () => {
		const path = '/api/agents/coder/grow';
		vi.stubGlobal('fetch', async () => json({ messages: [message('u6'), message('a6')], before: 'u6' }));
		const view = await open(path, [message('u8'), message('a8')], 'u8');
		act(() => view.result.current.older!.load());
		await waitFor(() => expect(view.result.current.messages).toHaveLength(4));
		view.rerender({ agent: agentWith([message('u8'), message('a8'), message('u9'), message('a9')]) });
		expect(view.result.current.messages.map((m) => m.id)).toEqual(['u6', 'a6', 'u8', 'a8', 'u9', 'a9']);
		view.rerender({ agent: agentWith([message('a6'), message('u8'), message('a8')]) });
		// Started elsewhere: the pages no longer join up, so only the live conversation shows.
		expect(view.result.current.messages.map((m) => m.id)).toEqual(['a6', 'u8', 'a8']);
		expect(view.result.current.older?.more).toBe(false);
	});

	it('stops when the conversation changed under the page, and offers a retry when a page fails', async () => {
		vi.stubGlobal('fetch', async () => json({ error: 'gone' }, 409));
		const gone = await open('/api/agents/coder/gone', [message('u8'), message('a8')], 'u8');
		act(() => gone.result.current.older!.load());
		await waitFor(() => expect(gone.result.current.older?.more).toBe(false));
		expect(gone.result.current.older?.failed).toBe(false);

		vi.stubGlobal('fetch', async () => json({ error: 'boom' }, 502));
		const broken = await open('/api/agents/coder/broken', [message('u8'), message('a8')], 'u8');
		act(() => broken.result.current.older!.load());
		await waitFor(() => expect(broken.result.current.older?.failed).toBe(true));
		expect(broken.result.current.older?.more).toBe(true);
		expect(broken.result.current.messages.map((m) => m.id)).toEqual(['u8', 'a8']);
	});
});
