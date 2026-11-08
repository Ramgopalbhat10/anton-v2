import { appDb } from './client.ts';

type Row = Record<string, unknown>;

/** One row of the Notifications dialog, about one task (src/services/notifications.ts says which moments make one). */
export type NotificationRecord = {
	id: string;
	/** What the row stands for, such as a task's last reply; a newer row with the same key replaces it. */
	key: string;
	kind: string;
	sessionId: string | null;
	spaceId: string | null;
	title: string;
	body: string;
	url: string;
	createdAt: string;
	readAt: string | null;
};

const optional = (value: unknown) => (value == null ? null : String(value));

function toRecord(row: Row): NotificationRecord {
	return {
		id: String(row.id),
		key: String(row.key),
		kind: String(row.kind),
		sessionId: optional(row.session_id),
		spaceId: optional(row.space_id),
		title: String(row.title),
		body: String(row.body),
		url: String(row.url),
		createdAt: String(row.created_at),
		readAt: optional(row.read_at),
	};
}

/** Keeps the newest `keep` rows; a list of moments worth a look has no use for last month's. */
export async function insertNotification(record: Omit<NotificationRecord, 'readAt'>, keep: number): Promise<void> {
	const db = await appDb();
	await db.batch(
		[
			{ sql: 'DELETE FROM notifications WHERE key = ?', args: [record.key] },
			{
				sql: 'INSERT INTO notifications (id, key, kind, session_id, space_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
				args: [record.id, record.key, record.kind, record.sessionId, record.spaceId, record.title, record.body, record.url, record.createdAt],
			},
			{ sql: 'DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC LIMIT ?)', args: [keep] },
		],
		'write',
	);
}

export async function listNotificationRecords(limit: number): Promise<NotificationRecord[]> {
	const db = await appDb();
	return (await db.execute({ sql: 'SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?', args: [limit] })).rows.map(toRecord);
}

/** Marks rows read (or unread again): the ones named, a task's, or every one. Returns how many changed. */
export async function setNotificationsRead(which: { ids?: string[]; sessionId?: string; all?: boolean }, readAt: string | null): Promise<number> {
	const db = await appDb();
	const changed = readAt ? 'read_at IS NULL' : 'read_at IS NOT NULL';
	if (which.all) return (await db.execute({ sql: `UPDATE notifications SET read_at = ? WHERE ${changed}`, args: [readAt] })).rowsAffected;
	if (which.sessionId) return (await db.execute({ sql: `UPDATE notifications SET read_at = ? WHERE session_id = ? AND ${changed}`, args: [readAt, which.sessionId] })).rowsAffected;
	const ids = which.ids ?? [];
	if (ids.length === 0) return 0;
	return (await db.execute({ sql: `UPDATE notifications SET read_at = ? WHERE id IN (${ids.map(() => '?').join(', ')}) AND ${changed}`, args: [readAt, ...ids] })).rowsAffected;
}

export async function deleteNotificationsOf(sessionId: string): Promise<number> {
	const db = await appDb();
	return (await db.execute({ sql: 'DELETE FROM notifications WHERE session_id = ?', args: [sessionId] })).rowsAffected;
}
