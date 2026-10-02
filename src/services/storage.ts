import type { ObjectStore, StoredObject } from '../core/ports.ts';
import { text } from '../core/shell.ts';
import { listSessionRecords } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import type { Checkpoint } from './checkpoints.ts';

/** The timeline shows this many entries, so older ones only take space. */
const KEEP_CHECKPOINTS = 50;
/** A blob this new may belong to a checkpoint still being written. */
const BLOB_GRACE_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type CleanupResult = { at: string; removed: number; freedBytes: number };
export type StorageView = { objects: number; bytes: number; lastCleanup: CleanupResult | null };

/** The task id in a key under `sessions/`. */
function sessionOf(key: string): string {
	return key.split('/')[1] ?? '';
}

/** History entries beyond the newest ones kept: each manifest and its diff. */
function surplusHistory(objects: StoredObject[]): StoredObject[] {
	const entries = objects.filter((object) => object.key.split('/')[2] === 'checkpoints');
	const times = [...new Set(entries.map((object) => object.key.replace(/\.(json|patch)$/, '')))].sort().reverse();
	const dropped = new Set(times.slice(KEEP_CHECKPOINTS));
	return entries.filter((object) => dropped.has(object.key.replace(/\.(json|patch)$/, '')));
}

async function referencedBlobs(store: ObjectStore, manifests: StoredObject[]): Promise<Set<string>> {
	const used = new Set<string>();
	for (const manifest of manifests) {
		const bytes = await store.get(manifest.key);
		const checkpoint = bytes ? (JSON.parse(text(bytes)) as Checkpoint) : null;
		for (const file of checkpoint?.files ?? []) if (file.blob) used.add(file.blob);
	}
	return used;
}

/**
 * Removes what nothing can show any more: objects of deleted tasks, history
 * beyond the newest entries, and file contents no remaining checkpoint uses.
 */
export async function cleanUpStorage(now = Date.now()): Promise<CleanupResult> {
	const { store } = getProviders();
	const live = new Set((await listSessionRecords()).map((session) => session.id));
	const sessionObjects = await store.list('sessions/');
	const orphaned = sessionObjects.filter((object) => !live.has(sessionOf(object.key)));
	const bySession = Map.groupBy(
		sessionObjects.filter((object) => live.has(sessionOf(object.key))),
		(object) => sessionOf(object.key),
	);
	const surplus = [...bySession.values()].flatMap(surplusHistory);
	const dropped = new Set([...orphaned, ...surplus].map((object) => object.key));
	const manifests = sessionObjects.filter((object) => !dropped.has(object.key) && object.key.endsWith('.json'));
	const used = await referencedBlobs(store, manifests);
	const unused = (await store.list('blobs/')).filter((blob) => !used.has(blob.key) && now - blob.modifiedAt > BLOB_GRACE_MS);
	const removing = [...orphaned, ...surplus, ...unused];
	for (const object of removing) await store.remove(object.key);
	const result = { at: new Date(now).toISOString(), removed: removing.length, freedBytes: removing.reduce((sum, object) => sum + object.size, 0) };
	await setSetting('lastCleanup', result);
	return result;
}

export async function storageView(): Promise<StorageView> {
	const { store } = getProviders();
	const [sessions, blobs, lastCleanup] = await Promise.all([store.list('sessions/'), store.list('blobs/'), getSetting<CleanupResult | null>('lastCleanup', null)]);
	const all = [...sessions, ...blobs];
	return { objects: all.length, bytes: all.reduce((sum, object) => sum + object.size, 0), lastCleanup };
}

/** Runs the cleanup once a day, starting a minute after boot. */
export function scheduleCleanup(): void {
	const run = async () => {
		const last = await getSetting<CleanupResult | null>('lastCleanup', null);
		if (last && Date.now() - Date.parse(last.at) < DAY_MS) return;
		await cleanUpStorage();
	};
	setTimeout(() => void run().catch((error: unknown) => console.warn('[anton] storage cleanup failed', error)), 60_000).unref();
	setInterval(() => void run().catch((error: unknown) => console.warn('[anton] storage cleanup failed', error)), 60 * 60_000).unref();
}
