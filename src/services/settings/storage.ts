import type { ObjectStore, StoredObject } from '../../core/ports.ts';
import { text } from '../../core/shell.ts';
import { deletedSessionIds, listSessionRecords } from '../../db/sessions.ts';
import { getSetting, setSetting } from '../../db/settings.ts';
import { getProviders } from '../../providers/index.ts';
import { type Checkpoint, whileNoCheckpointIsWritten } from '../git/checkpoints.ts';
import { logProblem } from '../../core/log.ts';

const KEEP_CHECKPOINTS = 50;
/** A blob this new may belong to a checkpoint still being written. */
const BLOB_GRACE_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type CleanupResult = { at: string; removed: number; freedBytes: number };
export type StorageView = { objects: number; bytes: number; lastCleanup: CleanupResult | null };

function sessionOf(key: string): string {
	return key.split('/')[1] ?? '';
}

/** A task's outputs may be JSON files too. */
function isManifest(key: string): boolean {
	const [, , name, entry] = key.split('/');
	return (name === 'checkpoint.json' && entry === undefined) || (name === 'checkpoints' && entry?.endsWith('.json') === true);
}

function surplusHistory(objects: StoredObject[]): StoredObject[] {
	const entries = objects.filter((object) => object.key.split('/')[2] === 'checkpoints');
	const times = [...new Set(entries.map((object) => object.key.replace(/\.(json|patch)$/, '')))].sort().reverse();
	const dropped = new Set(times.slice(KEEP_CHECKPOINTS));
	return entries.filter((object) => dropped.has(object.key.replace(/\.(json|patch)$/, '')));
}

/** A manifest that cannot be read keeps everything, as nothing is known to be unused. */
async function referencedBlobs(store: ObjectStore, manifests: StoredObject[]): Promise<Set<string> | null> {
	const used = new Set<string>();
	for (const manifest of manifests) {
		const bytes = await store.get(manifest.key);
		if (!bytes) continue;
		let checkpoint: Checkpoint;
		try {
			checkpoint = JSON.parse(text(bytes)) as Checkpoint;
		} catch {
			return null;
		}
		for (const file of checkpoint.files ?? []) if (file.blob) used.add(file.blob);
	}
	return used;
}

/** Read while no checkpoint is being written, so none is in use unseen. */
async function unusedBlobs(store: ObjectStore, dropped: Set<string>, now: number): Promise<StoredObject[]> {
	const manifests = (await store.list('sessions/')).filter((object) => isManifest(object.key) && !dropped.has(object.key));
	const used = await referencedBlobs(store, manifests);
	if (!used) return [];
	return (await store.list('blobs/')).filter((blob) => !used.has(blob.key) && now - blob.modifiedAt > BLOB_GRACE_MS);
}

/** A task this database does not know is never removed: the storage may be shared with another database. */
export async function cleanUpStorage(now = Date.now()): Promise<CleanupResult> {
	const { store } = getProviders();
	const [records, deleted] = await Promise.all([listSessionRecords(), deletedSessionIds()]);
	const live = new Set(records.map((session) => session.id));
	const sessionObjects = await store.list('sessions/');
	const orphaned = sessionObjects.filter((object) => deleted.has(sessionOf(object.key)) && !live.has(sessionOf(object.key)));
	const bySession = Map.groupBy(
		sessionObjects.filter((object) => live.has(sessionOf(object.key))),
		(object) => sessionOf(object.key),
	);
	const surplus = [...bySession.values()].flatMap(surplusHistory);
	const dropped = new Set([...orphaned, ...surplus].map((object) => object.key));
	for (const object of [...orphaned, ...surplus]) await store.remove(object.key);
	const unused = await whileNoCheckpointIsWritten(async () => {
		const found = await unusedBlobs(store, dropped, now);
		for (const blob of found) await store.remove(blob.key);
		return found;
	});
	const removing = [...orphaned, ...surplus, ...unused];
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

export function scheduleCleanup(): void {
	const run = async () => {
		const last = await getSetting<CleanupResult | null>('lastCleanup', null);
		if (last && Date.now() - Date.parse(last.at) < DAY_MS) return;
		await cleanUpStorage();
	};
	setTimeout(() => void run().catch((error: unknown) => logProblem('warn', 'Storage cleanup failed', error)), 60_000).unref();
	setInterval(() => void run().catch((error: unknown) => logProblem('warn', 'Storage cleanup failed', error)), 60 * 60_000).unref();
}
