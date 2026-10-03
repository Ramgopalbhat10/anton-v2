import { appDb } from './client.ts';

/** An app-wide setting stored as JSON; `fallback` when it was never saved. */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
	const value = result.rows[0]?.value;
	return value == null ? fallback : (JSON.parse(String(value)) as T);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		args: [key, JSON.stringify(value), new Date().toISOString()],
	});
}
