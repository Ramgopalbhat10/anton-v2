import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/api/sessions';
import { AWAY_REFETCH_MS, refetcher, refetchOnReturn, rowsFor, staleFor } from '@/lib/live-updates';
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
