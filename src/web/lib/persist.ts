import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Keeps a copy of the lists a page opens on (tasks, projects, spaces, notifications, the tasks opened last…) in
 * IndexedDB, so a reload or a new tab draws them at once instead of waiting on the server. What it draws is marked as
 * read when it was saved, so every page that shows it reads it again straight away; the copy only fills the wait.
 * A new build, or a copy from another schema, is thrown away. Secrets, connections, logs and the sandbox's files are
 * never kept.
 */

/** Bump when what is saved changes shape. */
const SCHEMA = 1;
const DB = 'anton-cache';
const STORE = 'queries';
const ENTRY = 'snapshot';
/** Saves are batched: at most one every this long, and one more as the page is hidden. */
export const SAVE_EVERY_MS = 2_000;
/** Opening the page waits at most this long for the copy, so a slow disk never holds it up. */
export const RESTORE_WAIT_MS = 250;
/** A copy older than this is not drawn: it would mislead more than it helps. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** How many tasks opened on their own are kept, newest first. */
export const KEEP_TASKS = 50;

/**
 * Root keys that are kept. Everything else (connections, secrets, setup, logs, files, GitHub data) is not, and nor is
 * anything read with `staleTime: Infinity` (the profile), which would never be read again. Models keep their own copy.
 */
export const PERSISTED: ReadonlySet<string> = new Set([
	'sessions',
	'session',
	'spaces',
	'space',
	'projects',
	'notifications',
	'artifacts',
	'budget',
	'usage',
	'general-settings',
	'health',
]);

export type Saved = { key: QueryKey; data: unknown; at: number };
type Snapshot = { schema: number; build: string; savedAt: number; queries: Saved[] };

/** The build this page runs: the hashed name of its script in production. */
export function currentBuild(): string {
	try {
		return new URL(import.meta.url).pathname;
	} catch {
		return 'dev';
	}
}

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error('cache blocked'));
	});
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await open();
	try {
		return await new Promise<T>((resolve, reject) => {
			const request = work(db.transaction(STORE, mode).objectStore(STORE));
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	} finally {
		db.close();
	}
}

/** The queries worth keeping now: the allowed ones that hold data, and only the newest `KEEP_TASKS` tasks. */
export function pick(queries: Pick<Query, 'queryKey' | 'state'>[]): Saved[] {
	const kept = queries.filter((query) => {
		const root = query.queryKey[0];
		return typeof root === 'string' && PERSISTED.has(root) && query.state.status === 'success' && query.state.data !== undefined && query.state.dataUpdatedAt > 0;
	});
	const tasks = kept.filter((query) => query.queryKey[0] === 'session').sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
	const dropped = new Set(tasks.slice(KEEP_TASKS));
	return kept.filter((query) => !dropped.has(query)).map((query) => ({ key: query.queryKey, data: query.state.data, at: query.state.dataUpdatedAt }));
}

/** The saved copy, if it is from this build and schema and not too old. */
export function usable(snapshot: unknown, build: string, now = Date.now()): Saved[] {
	const value = snapshot as Partial<Snapshot> | undefined;
	if (!value || value.schema !== SCHEMA || value.build !== build || !Array.isArray(value.queries)) return [];
	if (typeof value.savedAt !== 'number' || now - value.savedAt > MAX_AGE_MS) return [];
	return value.queries;
}

/**
 * Draws the saved copy into the cache, behind anything already read, marked stale whatever its age: a copy saved a
 * second ago may still miss a change made since, so the first page that shows it reads it again.
 */
export function fill(queryClient: QueryClient, saved: Saved[]) {
	for (const { key, data, at } of saved) {
		if (queryClient.getQueryState(key)?.dataUpdatedAt) continue;
		queryClient.setQueryData(key, data, { updatedAt: at });
		void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
	}
}

/**
 * Restores the saved copy (waiting at most `RESTORE_WAIT_MS`), then keeps it saved as the cache changes. Anything
 * that goes wrong with storage (a private window, a full disk, an old browser) leaves the page as it was without it.
 */
export async function persistQueries(queryClient: QueryClient, build = currentBuild()): Promise<void> {
	if (typeof indexedDB === 'undefined') return;
	const restore = run('readonly', (store) => store.get(ENTRY) as IDBRequest<Snapshot | undefined>)
		.then((snapshot) => {
			const saved = usable(snapshot, build);
			fill(queryClient, saved);
			if (!saved.length && snapshot) void run('readwrite', (store) => store.delete(ENTRY)).catch(() => undefined);
		})
		.catch(() => undefined);
	await Promise.race([restore, new Promise((resolve) => setTimeout(resolve, RESTORE_WAIT_MS))]);

	let timer: ReturnType<typeof setTimeout> | null = null;
	const save = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		const snapshot: Snapshot = { schema: SCHEMA, build, savedAt: Date.now(), queries: pick(queryClient.getQueryCache().getAll()) };
		void run('readwrite', (store) => store.put(snapshot, ENTRY)).catch(() => undefined);
	};
	queryClient.getQueryCache().subscribe((event) => {
		if (event.type !== 'updated' || event.action.type !== 'success') return;
		const root = event.query.queryKey[0];
		if (typeof root !== 'string' || !PERSISTED.has(root)) return;
		timer ??= setTimeout(save, SAVE_EVERY_MS);
	});
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden' && timer) save();
	});
}
