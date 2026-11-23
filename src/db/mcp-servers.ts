import { ConflictError, InvalidInputError } from '../core/errors.ts';
import type { InstalledMcpServer } from '../core/types.ts';
import { appDb } from './client.ts';

/** Matches mcpToolName's server segment normalization so two servers never share or shadow a tool namespace. */
export const normalizeMcpServerName = (name: string) => name.replace(/[^\w]/g, '_');

const namespacesOverlap = (a: string, b: string) => {
	const prefixA = `${a}__`;
	const prefixB = `${b}__`;
	return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
};

type Row = Record<string, unknown>;

function toServer(row: Row): InstalledMcpServer {
	const headers = row.headers_json ? (JSON.parse(String(row.headers_json)) as Record<string, string>) : {};
	return {
		name: String(row.name),
		url: String(row.url),
		auth: row.auth == null ? null : String(row.auth),
		...(Object.keys(headers).length ? { headers } : {}),
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

/** Atomically checks name uniqueness, complete-prefix tool-namespace overlaps (including trailing __), and the server cap in a single SQL statement. */
export async function insertMcpServer(server: Omit<InstalledMcpServer, 'enabled' | 'addedAt'>, maxServers: number): Promise<void> {
	const db = await appDb();
	const normalized = normalizeMcpServerName(server.name);
	const prefix = `${normalized}__`;
	// Single statement executes atomically under SQLite's write lock on both file and :memory: databases.
	const existingPrefix = `(replace(replace(name, '-', '_'), ' ', '_') || '__')`;
	const inserted = await db.execute({
		sql: `INSERT INTO mcp_servers (name, url, auth, headers_json, tools_json, code_mode, enabled, added_at)
			SELECT ?, ?, ?, ?, ?, ?, 1, ?
			WHERE NOT EXISTS (
				SELECT 1 FROM mcp_servers
				WHERE name = ?
					OR substr(${existingPrefix}, 1, length(?)) = ?
					OR substr(?, 1, length(${existingPrefix})) = ${existingPrefix}
			)
			AND (SELECT COUNT(*) FROM mcp_servers) < ?`,
		args: [
			server.name,
			server.url,
			server.auth,
			JSON.stringify(server.headers ?? {}),
			JSON.stringify(server.tools),
			server.codeMode === false ? 0 : 1,
			new Date().toISOString(),
			server.name,
			prefix,
			prefix,
			prefix,
			maxServers,
		],
	});
	if (inserted.rowsAffected === 1) return;
	const names = (await db.execute('SELECT name FROM mcp_servers')).rows.map((row) => String(row.name));
	if (names.includes(server.name)) throw new ConflictError(`An MCP server is already named ${server.name}`);
	const colliding = names.find((existing) => namespacesOverlap(normalizeMcpServerName(existing), normalized));
	if (colliding) throw new ConflictError(`An MCP server named ${colliding} already uses an overlapping tool namespace (${normalized})`);
	throw new InvalidInputError(`Anton keeps up to ${maxServers} MCP servers`);
}

/** Update-only: never recreates a deleted server or overwrites a replacement inserted concurrently. */
export async function updateMcpServerRow(server: Omit<InstalledMcpServer, 'enabled' | 'addedAt'>, expectedAddedAt: string): Promise<boolean> {
	const db = await appDb();
	const updated = await db.execute({
		sql: `UPDATE mcp_servers SET url = ?, auth = ?, headers_json = ?, tools_json = ?, code_mode = ? WHERE name = ? AND added_at = ?`,
		args: [server.url, server.auth, JSON.stringify(server.headers ?? {}), JSON.stringify(server.tools), server.codeMode === false ? 0 : 1, server.name, expectedAddedAt],
	});
	return updated.rowsAffected === 1;
}

export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'UPDATE mcp_servers SET enabled = ? WHERE name = ?', args: [enabled ? 1 : 0, name] });
}

export async function deleteMcpServer(name: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM mcp_servers WHERE name = ?', args: [name] });
}

/** Never part of the server's view. */
export async function getMcpSignIn(name: string): Promise<unknown> {
	const db = await appDb();
	const row = (await db.execute({ sql: 'SELECT oauth_json FROM mcp_servers WHERE name = ?', args: [name] })).rows[0];
	return row?.oauth_json == null ? null : JSON.parse(String(row.oauth_json));
}

export async function setMcpSignIn(name: string, signIn: unknown): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'UPDATE mcp_servers SET oauth_json = ? WHERE name = ?', args: [signIn == null ? null : JSON.stringify(signIn), name] });
}
