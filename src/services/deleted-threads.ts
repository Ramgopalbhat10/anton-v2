import { getSetting, setSetting } from '../db/settings.ts';

/** A thread the user deleted, as its coordinator still hears of it: its words live on in the coordinator's history. */
export type DeletedThread = { id: string; title: string; lastReply: string | null; at: string };
const deletedKey = (spaceId: string) => `deleted-threads.${spaceId}`;
/** The latest few, for a week: long enough to catch a follow-up meant for one, short enough to keep the state block small. */
const DELETED_KEPT = 5;
const DELETED_DAYS = 7;

export async function deletedThreads(spaceId: string, now = Date.now()): Promise<DeletedThread[]> {
	const kept = await getSetting<DeletedThread[]>(deletedKey(spaceId), []);
	return kept.filter((thread) => now - Date.parse(thread.at) < DELETED_DAYS * 86_400_000);
}

export async function noteDeleted(spaceId: string, thread: DeletedThread): Promise<void> {
	const rest = (await deletedThreads(spaceId)).filter((entry) => entry.id !== thread.id);
	await setSetting(deletedKey(spaceId), [thread, ...rest].slice(0, DELETED_KEPT));
}
