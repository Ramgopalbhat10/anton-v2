import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/api/sessions';
import { AWAY_REFETCH_MS, LIVE_FRESH_MS, LIVE_KEYS, refetcher, refetchOnReturn, rowsFor, setStreamForTest, staleFor } from '@/lib/live-updates';
import { MOUNT_FRESH_MS } from '@/lib/task-sync';
import { appQueryClient } from '@/lib/task-sync';
import { session } from './render';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('a model turn in another task', () => {
	it('reads that task alone instead of the whole list', () => {
		const change = { kind: 'task', id: 's1', what: 'usage' } as const;
		expect(staleFor(change)).not.toContainEqual(['sessions']);
		expect(rowsFor(change)).toEqual(['s1']);
	});

	it('still reads the whole list when a reply starts or ends', () => {
		const change = { kind: 'task', id: 's1', what: 'state' } as const;
		expect(staleFor(change)).toContainEqual(['sessions']);
		expect(rowsFor(change)).toEqual([]);
	});

	it('writes the task read alone into the list, and leaves the list itself unread', async () => {
		vi.useFakeTimers();
		const queryClient = appQueryClient();
		queryClient.setQueryData(['sessions'], { sessions: [session({ id: 's1', title: 'one' }), session({ id: 's2', title: 'two' })] });
		const fetched: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			fetched.push(url);
			return new Response(JSON.stringify(session({ id: 's1', title: 'one', usage: { cost: 1.25 } as Session['usage'] })), { headers: { 'content-type': 'application/json' } });
		});
		const refetch = refetcher(queryClient);
		refetch(staleFor({ kind: 'task', id: 's1', what: 'usage' }), ['s1']);
		refetch(staleFor({ kind: 'task', id: 's1', what: 'usage' }), ['s1']);
		await vi.advanceTimersByTimeAsync(400);
		await vi.waitFor(() => expect(queryClient.getQueryData<{ sessions: Session[] }>(['sessions'])!.sessions[0].usage.cost).toBe(1.25));
		expect(fetched).toEqual(['/api/sessions/s1']);
		expect(queryClient.getQueryData<{ sessions: Session[] }>(['sessions'])!.sessions[1].title).toBe('two');
	});

	it('reads nothing for a task the list does not hold', async () => {
		vi.useFakeTimers();
		const queryClient = appQueryClient();
		queryClient.setQueryData(['sessions'], { sessions: [session({ id: 's2' })] });
		const fetched: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			fetched.push(url);
			return new Response('{}');
		});
		refetcher(queryClient)([], ['s1']);
		await vi.advanceTimersByTimeAsync(400);
		expect(fetched).toEqual([]);
	});
});

describe('coming back to the tab', () => {
	it('refetches only when the stream is down or the tab was away a while', () => {
		expect(refetchOnReturn(5_000, true)).toBe(false);
		expect(refetchOnReturn(5_000, false)).toBe(true);
		expect(refetchOnReturn(AWAY_REFETCH_MS, true)).toBe(true);
	});
});

describe('readers that mount together', () => {
	it('share one read, while a server event still marks it stale at once', async () => {
		const queryClient = appQueryClient();
		let reads = 0;
		const options = { queryKey: ['spaces'], queryFn: async () => ++reads };
		await queryClient.fetchQuery(options);
		await queryClient.fetchQuery(options);
		expect(reads).toBe(1);
		await queryClient.invalidateQueries({ queryKey: ['spaces'] });
		expect(queryClient.getQueryState(['spaces'])!.isInvalidated).toBe(true);
		await queryClient.fetchQuery(options);
		expect(reads).toBe(2);
	});
});

describe('changing pages while the event stream is up', () => {
	afterEach(() => setStreamForTest(false, 0));

	const kinds = [
		{ kind: 'sessions' },
		{ kind: 'subscriptions' },
		{ kind: 'setup' },
		{ kind: 'connectors' },
		{ kind: 'spaces' },
		{ kind: 'automations' },
		{ kind: 'notifications' },
		{ kind: 'projects' },
		{ kind: 'general' },
		{ kind: 'page', id: 'p', path: 'a', version: 1, from: 'x' },
		...(['threads', 'files', 'settings'] as const).map((what) => ({ kind: 'space', id: 'sp', what })),
		...(['state', 'usage', 'files', 'browser', 'computer', 'subagents', 'todos', 'scripts', 'joins', 'mail', 'approvals', 'pr-metadata', 'settled'] as const).map((what) => ({ kind: 'task', id: 't', what })),
	] as Parameters<typeof staleFor>[0][];

	it('keeps only reads that some server event marks stale', () => {
		const marked = new Set(kinds.flatMap((change) => staleFor(change).map((key) => String(key[0]))));
		for (const key of LIVE_KEYS) expect(marked, key).toContain(key);
	});

	it('reads the copy here, until an event or the safety net says otherwise', async () => {
		vi.useFakeTimers();
		const queryClient = appQueryClient();
		setStreamForTest(true, Date.now());
		let reads = 0;
		const options = { queryKey: ['sessions'], queryFn: async () => ++reads };
		await queryClient.fetchQuery(options);
		vi.advanceTimersByTime(MOUNT_FRESH_MS * 10);
		await queryClient.fetchQuery(options);
		expect(reads).toBe(1);
		await queryClient.invalidateQueries({ queryKey: ['sessions'] });
		await queryClient.fetchQuery(options);
		expect(reads).toBe(2);
		vi.advanceTimersByTime(LIVE_FRESH_MS);
		await queryClient.fetchQuery(options);
		expect(reads).toBe(3);
	});

	it('reads again as before when the stream is down, or the read predates it, or no event covers it', async () => {
		vi.useFakeTimers();
		const queryClient = appQueryClient();
		let reads = 0;
		const read = (key: string) => queryClient.fetchQuery({ queryKey: [key], queryFn: async () => ++reads });
		await read('sessions');
		setStreamForTest(true, Date.now() + 1);
		vi.advanceTimersByTime(MOUNT_FRESH_MS + 1);
		await read('sessions');
		expect(reads).toBe(2);
		setStreamForTest(false);
		vi.advanceTimersByTime(MOUNT_FRESH_MS + 1);
		await read('sessions');
		expect(reads).toBe(3);
		setStreamForTest(true, Date.now());
		await read('pulls');
		vi.advanceTimersByTime(MOUNT_FRESH_MS + 1);
		await read('pulls');
		expect(reads).toBe(5);
	});
});
