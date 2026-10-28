import type { PullRequestState } from '../core/ports.ts';
import { appDb } from './client.ts';

/** A pull request a task opened (or reviews), kept after a newer one takes its place as the task's current one. */
export type PullRequestRecord = {
	url: string;
	sessionId: string;
	repo: string;
	number: number;
	title: string;
	head: string;
	base: string;
	/** As last read from the host; null when it was never read. */
	state: PullRequestState | null;
	openedAt: string;
	mergedAt: string | null;
};

type Row = Record<string, unknown>;

function toRecord(row: Row): PullRequestRecord {
	return {
		url: String(row.url),
		sessionId: String(row.session_id),
		repo: String(row.repo),
		number: Number(row.number),
		title: String(row.title),
		head: String(row.head),
		base: String(row.base),
		state: row.state == null ? null : (String(row.state) as PullRequestState),
		openedAt: String(row.opened_at),
		mergedAt: row.merged_at == null ? null : String(row.merged_at),
	};
}

/** Keeps a pull request the first time it is opened; a later push to it keeps when it was opened and takes its new title. */
export async function recordPullRequest(record: Omit<PullRequestRecord, 'mergedAt' | 'openedAt'> & { openedAt?: string }): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO pull_requests (url, session_id, repo, number, title, head, base, state, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (url) DO UPDATE SET title = excluded.title, state = excluded.state`,
		args: [record.url, record.sessionId, record.repo, record.number, record.title, record.head, record.base, record.state, record.openedAt ?? new Date().toISOString()],
	});
}

/** Saves a pull request's state as last read; `mergedAt` once it merged. */
export async function setPullRequestState(url: string, state: PullRequestState, mergedAt: string | null = null): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'UPDATE pull_requests SET state = ?, merged_at = COALESCE(?, merged_at) WHERE url = ?', args: [state, mergedAt, url] });
}

/** A task's pull requests, newest first. */
export async function listPullRequestRecords(sessionId: string): Promise<PullRequestRecord[]> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT * FROM pull_requests WHERE session_id = ? ORDER BY opened_at DESC, number DESC', args: [sessionId] });
	return result.rows.map((row) => toRecord(row as Row));
}

export async function getPullRequestRecord(sessionId: string, number: number): Promise<PullRequestRecord | null> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT * FROM pull_requests WHERE session_id = ? AND number = ? ORDER BY opened_at DESC LIMIT 1', args: [sessionId, number] });
	return result.rows[0] ? toRecord(result.rows[0] as Row) : null;
}
