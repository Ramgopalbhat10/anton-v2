import { appDb } from './client.ts';

/*
 * Pages the agent drew with render_html, and HTML files in a Library: each
 * one's title, and the state every open copy of it shares (in the thread, in
 * a tab of its own, in the Library), with a version that goes up on each save.
 */

/**
 * What a page keeps: its own value, set through `window.anton.setState`, its
 * form fields' values when it keeps none, and what it put in localStorage.
 */
export type PageState = { state: unknown; fields: Record<string, string | boolean>; storage: Record<string, string>; version: number };

export type PageRow = { sessionId: string; path: string; title: string; updatedAt: string };

const EMPTY = { state: null, fields: {}, storage: {} };

export async function getPageState(sessionId: string, path: string): Promise<PageState> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT state_json, version FROM pages WHERE session_id = ? AND path = ?', args: [sessionId, path] });
	const row = result.rows[0];
	if (!row) return { ...EMPTY, version: 0 };
	const saved = row.state_json ? (JSON.parse(String(row.state_json)) as Omit<PageState, 'version'>) : EMPTY;
	return { state: saved.state ?? null, fields: saved.fields ?? {}, storage: saved.storage ?? {}, version: Number(row.version) };
}

export async function getPageTitle(sessionId: string, path: string): Promise<string | null> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT title FROM pages WHERE session_id = ? AND path = ?', args: [sessionId, path] });
	return result.rows[0] ? String(result.rows[0].title) : null;
}

/** Records a page's title when the agent draws it; drawing it again under the same path keeps its state. */
export async function notePage(sessionId: string, path: string, title: string): Promise<void> {
	const db = await appDb();
	const now = new Date().toISOString();
	await db.execute({
		sql: `INSERT INTO pages (session_id, path, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(session_id, path) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
		args: [sessionId, path, title, now, now],
	});
}

/** Saves what changed (the page's value, its fields, its storage) and returns the new version. */
export async function putPageState(
	sessionId: string,
	path: string,
	change: { state?: unknown; fields?: Record<string, string | boolean>; storage?: Record<string, string> },
	title: string,
): Promise<number> {
	const db = await appDb();
	const tx = await db.transaction('write');
	try {
		const current = await tx.execute({ sql: 'SELECT state_json FROM pages WHERE session_id = ? AND path = ?', args: [sessionId, path] });
		const saved = current.rows[0]?.state_json ? (JSON.parse(String(current.rows[0].state_json)) as Omit<PageState, 'version'>) : EMPTY;
		const next = { state: change.state === undefined ? (saved.state ?? null) : change.state, fields: change.fields ?? saved.fields ?? {}, storage: change.storage ?? saved.storage ?? {} };
		const now = new Date().toISOString();
		const result = await tx.execute({
			sql: `INSERT INTO pages (session_id, path, title, state_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
				ON CONFLICT(session_id, path) DO UPDATE SET state_json = excluded.state_json, version = pages.version + 1, updated_at = excluded.updated_at
				RETURNING version`,
			args: [sessionId, path, title, JSON.stringify(next), now, now],
		});
		await tx.commit();
		return Number(result.rows[0]?.version ?? 1);
	} finally {
		tx.close();
	}
}

export async function deletePage(sessionId: string, path: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM pages WHERE session_id = ? AND path = ?', args: [sessionId, path] });
}

/** Every page's title, for the Artifacts page. */
export async function listPages(): Promise<PageRow[]> {
	const db = await appDb();
	const result = await db.execute('SELECT session_id, path, title, updated_at FROM pages');
	return result.rows.map((row) => ({ sessionId: String(row.session_id), path: String(row.path), title: String(row.title), updatedAt: String(row.updated_at) }));
}

/* Each task's Library as last listed, so the Artifacts page reads one table rather than every task's storage. */

export type IndexedOutput = { path: string; size: number; mtimeMs: number };

export async function readOutputIndex(): Promise<Map<string, IndexedOutput[]>> {
	const db = await appDb();
	const result = await db.execute('SELECT session_id, outputs_json FROM output_index');
	return new Map(result.rows.map((row) => [String(row.session_id), JSON.parse(String(row.outputs_json)) as IndexedOutput[]]));
}

/** Bumped each time a task's Library changes, so a listing read before the change never lands after it. */
const generations = new Map<string, number>();

export const outputIndexGeneration = (sessionId: string) => generations.get(sessionId) ?? 0;

/** Keeps the task's listing, unless its Library changed since `generation` was read. */
export async function writeOutputIndex(sessionId: string, outputs: IndexedOutput[], generation: number): Promise<void> {
	if (outputIndexGeneration(sessionId) !== generation) return;
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO output_index (session_id, outputs_json, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET outputs_json = excluded.outputs_json, updated_at = excluded.updated_at`,
		args: [sessionId, JSON.stringify(outputs), new Date().toISOString()],
	});
}

export async function forgetOutputIndex(sessionId: string): Promise<void> {
	generations.set(sessionId, outputIndexGeneration(sessionId) + 1);
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM output_index WHERE session_id = ?', args: [sessionId] });
}

/* Files you deleted from a task's Library, so its replies show them as deleted rather than broken. */

export async function noteDeletedOutput(sessionId: string, path: string): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: 'INSERT OR REPLACE INTO deleted_outputs (session_id, path, deleted_at) VALUES (?, ?, ?)',
		args: [sessionId, path, new Date().toISOString()],
	});
}

export async function deletedOutputs(sessionId: string): Promise<string[]> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT path FROM deleted_outputs WHERE session_id = ?', args: [sessionId] });
	return result.rows.map((row) => String(row.path));
}
