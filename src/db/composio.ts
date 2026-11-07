import { appDb } from './client.ts';

type Row = Record<string, unknown>;

/** An app connected through Composio: the toolkit and its connected account's id and status, never its tokens. */
export type ComposioAccountRow = {
	toolkit: string;
	name: string;
	description: string;
	category: string;
	appUrl: string;
	/** The logo URL Composio hosts for the toolkit, '' when it has none. */
	logo: string;
	enabled: boolean;
	/** Composio's connected account id while a sign-in is pending or the account is live. */
	accountId: string | null;
	/** none (never connected), pending (a sign-in waits on the user), active, failed. */
	status: 'none' | 'pending' | 'active' | 'failed';
	statusReason: string | null;
	connectedAt: string | null;
	addedAt: string;
	updatedAt: string;
};

function toRow(row: Row): ComposioAccountRow {
	return {
		toolkit: String(row.toolkit),
		name: String(row.name),
		description: String(row.description ?? ''),
		category: String(row.category ?? ''),
		appUrl: String(row.app_url ?? ''),
		logo: String(row.logo ?? ''),
		enabled: Number(row.enabled) === 1,
		accountId: row.account_id == null ? null : String(row.account_id),
		status: String(row.status) as ComposioAccountRow['status'],
		statusReason: row.status_reason == null ? null : String(row.status_reason),
		connectedAt: row.connected_at == null ? null : String(row.connected_at),
		addedAt: String(row.added_at),
		updatedAt: String(row.updated_at),
	};
}

export async function listComposioAccounts(): Promise<ComposioAccountRow[]> {
	const db = await appDb();
	return (await db.execute('SELECT * FROM composio_accounts ORDER BY name')).rows.map(toRow);
}

export async function getComposioAccount(toolkit: string): Promise<ComposioAccountRow | null> {
	const db = await appDb();
	const row = (await db.execute({ sql: 'SELECT * FROM composio_accounts WHERE toolkit = ?', args: [toolkit] })).rows[0];
	return row ? toRow(row) : null;
}

/** Adds an app, or refreshes its shown details; its connection state is kept. */
export async function saveComposioAccount(account: Pick<ComposioAccountRow, 'toolkit' | 'name' | 'description' | 'category' | 'appUrl' | 'logo'>): Promise<void> {
	const db = await appDb();
	const now = new Date().toISOString();
	await db.execute({
		sql: `INSERT INTO composio_accounts (toolkit, name, description, category, app_url, logo, enabled, status, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'none', ?, ?)
			ON CONFLICT(toolkit) DO UPDATE SET name = excluded.name, description = excluded.description, category = excluded.category, app_url = excluded.app_url, logo = excluded.logo, updated_at = excluded.updated_at`,
		args: [account.toolkit, account.name, account.description, account.category, account.appUrl, account.logo, now, now],
	});
}

export async function setComposioEnabled(toolkit: string, enabled: boolean): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'UPDATE composio_accounts SET enabled = ?, updated_at = ? WHERE toolkit = ?', args: [enabled ? 1 : 0, new Date().toISOString(), toolkit] });
}

/** A sign-in started: the account it will make, while the user is on Composio's page. */
export async function markComposioPending(toolkit: string, accountId: string): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `UPDATE composio_accounts SET account_id = ?, status = 'pending', status_reason = NULL, connected_at = NULL, updated_at = ? WHERE toolkit = ?`,
		args: [accountId, new Date().toISOString(), toolkit],
	});
}

/** What Composio last said of the account; `accountId` and `connectedAt` are set only when given. */
export async function markComposioStatus(toolkit: string, status: ComposioAccountRow['status'], reason: string | null, accountId?: string, connectedAt?: string): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `UPDATE composio_accounts SET status = ?, status_reason = ?, account_id = COALESCE(?, account_id), connected_at = COALESCE(?, connected_at), updated_at = ? WHERE toolkit = ?`,
		args: [status, reason, accountId ?? null, connectedAt ?? null, new Date().toISOString(), toolkit],
	});
}

/** Forgets the connection entirely: disconnected, or the account is gone at Composio. */
export async function resetComposioConnection(toolkit: string): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `UPDATE composio_accounts SET account_id = NULL, status = 'none', status_reason = NULL, connected_at = NULL, updated_at = ? WHERE toolkit = ?`,
		args: [new Date().toISOString(), toolkit],
	});
}

export async function deleteComposioAccount(toolkit: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM composio_accounts WHERE toolkit = ?', args: [toolkit] });
}
