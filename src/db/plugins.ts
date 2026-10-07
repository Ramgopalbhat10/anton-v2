import type { ParsedSkill, PluginPick, PluginSource } from '../core/plugins.ts';
import { appDb } from './client.ts';

type Row = Record<string, unknown>;

export type InstalledPlugin = {
	id: string;
	name: string;
	description: string;
	source: PluginSource;
	/** The commit it was installed from. */
	sha: string;
	/** The marketplace it was picked from, or null when added by its address. */
	marketplace: string | null;
	/** What it was installed from, to show it and update it from the same place; null for plugins installed before it was kept. */
	pick: PluginPick | null;
	skills: ParsedSkill[];
	mcpServers: string[];
	skipped: string[];
	enabled: boolean;
	installedAt: string;
};

function toPlugin(row: Row): InstalledPlugin {
	return {
		id: String(row.id),
		name: String(row.name),
		description: String(row.description),
		source: JSON.parse(String(row.source_json)) as PluginSource,
		sha: String(row.sha),
		marketplace: row.marketplace == null ? null : String(row.marketplace),
		pick: row.pick_json == null ? null : (JSON.parse(String(row.pick_json)) as PluginPick),
		skills: JSON.parse(String(row.skills_json)) as ParsedSkill[],
		mcpServers: JSON.parse(String(row.mcp_json)) as string[],
		skipped: JSON.parse(String(row.skipped_json)) as string[],
		enabled: Number(row.enabled) === 1,
		installedAt: String(row.installed_at),
	};
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
	const db = await appDb();
	return (await db.execute('SELECT * FROM plugins ORDER BY installed_at')).rows.map(toPlugin);
}

export async function getPlugin(id: string): Promise<InstalledPlugin | null> {
	const db = await appDb();
	const row = (await db.execute({ sql: 'SELECT * FROM plugins WHERE id = ?', args: [id] })).rows[0];
	return row ? toPlugin(row) : null;
}

/** Saves a plugin; installing the same source again replaces it, keeping whether it is on. */
export async function savePlugin(plugin: Omit<InstalledPlugin, 'enabled' | 'installedAt'>): Promise<InstalledPlugin> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO plugins (id, name, description, source_json, sha, marketplace, pick_json, skills_json, mcp_json, skipped_json, enabled, installed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
			ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, source_json = excluded.source_json, sha = excluded.sha,
				marketplace = excluded.marketplace, pick_json = excluded.pick_json, skills_json = excluded.skills_json, mcp_json = excluded.mcp_json, skipped_json = excluded.skipped_json`,
		args: [
			plugin.id,
			plugin.name,
			plugin.description,
			JSON.stringify(plugin.source),
			plugin.sha,
			plugin.marketplace,
			plugin.pick && JSON.stringify(plugin.pick),
			JSON.stringify(plugin.skills),
			JSON.stringify(plugin.mcpServers),
			JSON.stringify(plugin.skipped),
			new Date().toISOString(),
		],
	});
	return (await getPlugin(plugin.id))!;
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'UPDATE plugins SET enabled = ? WHERE id = ?', args: [enabled ? 1 : 0, id] });
}

export async function deletePlugin(id: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'DELETE FROM plugins WHERE id = ?', args: [id] });
}
