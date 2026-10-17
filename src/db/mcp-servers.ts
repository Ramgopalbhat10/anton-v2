import type { InstalledMcpServer } from '../core/types.ts';
import { appDb } from './client.ts';

type Row = Record<string, unknown>;

function toServer(row: Row): InstalledMcpServer {
	return {
		name: String(row.name),
		url: String(row.url),
		auth: row.auth == null ? null : String(row.auth),
		tools: JSON.parse(String(row.tools_json)) as string[],
		...(Number(row.code_mode) === 0 ? { codeMode: false } : {}),
		enabled: Number(row.enabled) === 1,
		addedAt: String(row.added_at),
	};
}

export async function listMcpServers(): Promise<InstalledMcpServer[]> {
	const db = await appDb();
	return (await db.execute('SELECT * FROM mcp_servers ORDER BY added_at, name')).rows.map(toServer);
}

export async function getMcpServer(name: string): Promise<InstalledMcpServer | null> {
	const db = await appDb();
	const row = (await db.execute({ sql: 'SELECT * FROM mcp_servers WHERE name = ?', args: [name] })).rows[0];
	return row ? toServer(row) : null;
}

/** Adds a server, or replaces the one of that name, keeping whether it is on and when it was added. */
export async function saveMcpServer(server: Omit<InstalledMcpServer, 'enabled' | 'addedAt'>): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO mcp_servers (name, url, auth, tools_json, code_mode, enabled, added_at) VALUES (?, ?, ?, ?, ?, 1, ?)
			ON CONFLICT(name) DO UPDATE SET url = excluded.url, auth = excluded.auth, tools_json = excluded.tools_json, code_mode = excluded.code_mode`,
		args: [server.name, server.url, server.auth, JSON.stringify(server.tools), server.codeMode === false ? 0 : 1, new Date().toISOString()],
	});
}

export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'UPDATE mcp_servers SET enabled = ? WHERE name = ?', args: [enabled ? 1 : 0, name] });
}

export async function deleteMcpServer(name: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM mcp_servers WHERE name = ?', args: [name] });
}
