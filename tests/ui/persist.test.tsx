import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStreamForTest } from '@/lib/live-updates';
import { fill, KEEP_TASKS, MAX_AGE_MS, persistQueries, pick, type Saved, usable } from '@/lib/persist';
import { appQueryClient } from '@/lib/task-sync';

const query = (key: unknown[], data: unknown, at: number, status = 'success') => ({ queryKey: key, state: { data, dataUpdatedAt: at, status } }) as never;

afterEach(() => {
	setStreamForTest(false, 0);
	vi.useRealTimers();
});

describe('what is kept', () => {
	it('keeps the allowed lists and never secrets, connections, setup, files or the profile', () => {
		const kept = pick([
			query(['sessions'], { sessions: [] }, 1),
			query(['projects'], { projects: [] }, 1),
			query(['notifications'], { items: [] }, 1),
			query(['sealed-secrets'], { secrets: ['x'] }, 1),
			query(['connections'], {}, 1),
			query(['setup'], {}, 1),
			query(['files', 't1'], [], 1),
			query(['profile'], {}, 1),
			query(['spaces'], undefined, 1),
			query(['budget'], {}, 1, 'error'),
		]);
		expect(kept.map((saved) => saved.key[0])).toEqual(['sessions', 'projects', 'notifications']);
	});

	it('keeps only the tasks opened most recently', () => {
		const tasks = Array.from({ length: KEEP_TASKS + 5 }, (_, index) => query(['session', `t${index}`], { id: `t${index}` }, index + 1));
		const kept = pick(tasks);
		expect(kept).toHaveLength(KEEP_TASKS);
		expect(kept.map((saved) => saved.key[1])).not.toContain('t0');
		expect(kept.map((saved) => saved.key[1])).toContain(`t${KEEP_TASKS + 4}`);
	});
});

describe('what is drawn', () => {
	const saved: Saved[] = [{ key: ['sessions'], data: { sessions: ['old'] }, at: 1_000 }];
	const snapshot = (over: object = {}) => ({ schema: 1, build: '/assets/index-a.js', savedAt: 10_000, queries: saved, ...over });

	it('only a copy from this build and schema, and not too old', () => {
		expect(usable(snapshot(), '/assets/index-a.js', 20_000)).toEqual(saved);
		expect(usable(snapshot(), '/assets/index-b.js', 20_000)).toEqual([]);
		expect(usable(snapshot({ schema: 0 }), '/assets/index-a.js', 20_000)).toEqual([]);
		expect(usable(snapshot(), '/assets/index-a.js', 10_000 + MAX_AGE_MS + 1)).toEqual([]);
		expect(usable(undefined, '/assets/index-a.js')).toEqual([]);
		expect(usable({ nonsense: true }, '/assets/index-a.js')).toEqual([]);
	});

	it('is stale at once, so a page that shows it reads it again, even with the stream up', async () => {
		const queryClient = appQueryClient();
		setStreamForTest(true, Date.now());
		// Saved a moment ago: still read again, since a change may have landed since.
		fill(queryClient, [{ key: ['sessions'], data: { sessions: ['old'] }, at: Date.now() - 1 }]);
		expect(queryClient.getQueryData(['sessions'])).toEqual({ sessions: ['old'] });
		let reads = 0;
		await queryClient.fetchQuery({ queryKey: ['sessions'], queryFn: async () => (++reads, { sessions: ['new'] }) });
		expect(reads).toBe(1);
		expect(queryClient.getQueryData(['sessions'])).toEqual({ sessions: ['new'] });
	});

	it('never covers what this page already read', () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['sessions'], { sessions: ['fresh'] });
		fill(queryClient, saved);
		expect(queryClient.getQueryData(['sessions'])).toEqual({ sessions: ['fresh'] });
	});

	it('leaves the page as it was where the browser has no IndexedDB', async () => {
		vi.stubGlobal('indexedDB', undefined);
		const queryClient = new QueryClient();
		await persistQueries(queryClient, 'b');
		expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
		vi.unstubAllGlobals();
	});
});
