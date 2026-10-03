import { randomUUID } from 'node:crypto';
import type { Project, ProjectSettings } from '../core/types.ts';
import { appDb } from './client.ts';

type Row = Record<string, unknown>;
const optional = (value: unknown) => (value == null ? null : String(value));
const parsed = <T>(value: unknown, fallback: T): T => (value == null ? fallback : (JSON.parse(String(value)) as T));

/** Ports most dev servers use: Next and CRA, Vite, Astro, and the usual generic one. */
export const DEFAULT_PREVIEW_PORTS = [3000, 5173, 4321, 8080];

function toProject(row: Row): Project {
	return {
		id: String(row.id),
		repoFullName: String(row.repo_full_name),
		defaultBranch: String(row.default_branch),
		warmImage: optional(row.snapshot_image_id),
		warmedAt: optional(row.warmed_at),
		env: parsed<Record<string, string>>(row.env_json, {}),
		setupScript: String(row.setup_script ?? ''),
		previewPorts: parsed<number[]>(row.preview_ports, DEFAULT_PREVIEW_PORTS),
		baseImage: optional(row.base_image),
		followUps: row.follow_ups == null ? true : Number(row.follow_ups) === 1,
		mcpServers: parsed(row.mcp_json, []),
		memory: String(row.memory ?? ''),
	};
}

export async function listProjects(): Promise<Project[]> {
	const db = await appDb();
	const result = await db.execute(`SELECT * FROM projects WHERE repo_full_name NOT LIKE 'local/%' ORDER BY updated_at DESC`);
	return result.rows.map((row) => toProject(row as Row));
}

export async function getProject(id: string): Promise<Project | null> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT * FROM projects WHERE id = ?', args: [id] });
	return result.rows[0] ? toProject(result.rows[0] as Row) : null;
}

/** Inserts the repo once; later calls refresh its default branch. */
export async function upsertProject(repoFullName: string, defaultBranch: string): Promise<Project> {
	const db = await appDb();
	const now = new Date().toISOString();
	await db.execute({ sql: `INSERT OR IGNORE INTO users (id, login, created_at) VALUES ('user_dev', 'anton', ?)`, args: [now] });
	await db.execute({
		sql: `INSERT INTO projects (id, user_id, repo_full_name, default_branch, workspace_path, updated_at)
			VALUES (?, 'user_dev', ?, ?, '', ?)
			ON CONFLICT (repo_full_name) DO UPDATE SET default_branch = excluded.default_branch, updated_at = excluded.updated_at`,
		args: [`proj_${randomUUID()}`, repoFullName, defaultBranch, now],
	});
	const result = await db.execute({ sql: 'SELECT * FROM projects WHERE repo_full_name = ?', args: [repoFullName] });
	return toProject(result.rows[0] as Row);
}

/**
 * Saves a warm image built on `baseImage`; skipped when the base image changed
 * while the snapshot was being taken, since the image is built on the old one.
 */
export async function setWarmImage(id: string, image: string, baseImage: string | null = null): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: 'UPDATE projects SET snapshot_image_id = ?, warmed_at = ? WHERE id = ? AND base_image IS ?',
		args: [image, new Date().toISOString(), id, baseImage],
	});
}

/** Drops the prepared images of repos on the default base image, after the default changes. */
export async function retireDefaultWarmImages(): Promise<void> {
	const db = await appDb();
	await db.execute('UPDATE projects SET snapshot_image_id = NULL, warmed_at = NULL WHERE base_image IS NULL');
}

/** Drops one repo's prepared image, so its next task builds a fresh one. */
export async function clearWarmImage(id: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'UPDATE projects SET snapshot_image_id = NULL, warmed_at = NULL WHERE id = ?', args: [id] });
}

/** Saves the settings; a new base image also drops the warm image, which was built from the old one. */
export async function setProjectSettings(id: string, settings: ProjectSettings): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `UPDATE projects SET env_json = ?, setup_script = ?, preview_ports = ?, follow_ups = ?, mcp_json = ?,
			snapshot_image_id = CASE WHEN base_image IS ? THEN snapshot_image_id END,
			warmed_at = CASE WHEN base_image IS ? THEN warmed_at END,
			base_image = ?, updated_at = ? WHERE id = ?`,
		args: [
			JSON.stringify(settings.env),
			settings.setupScript,
			JSON.stringify(settings.previewPorts),
			settings.followUps ? 1 : 0,
			JSON.stringify(settings.mcpServers),
			settings.baseImage,
			settings.baseImage,
			settings.baseImage,
			new Date().toISOString(),
			id,
		],
	});
}

/** The repo's notes as the user wrote them. */
export async function setProjectMemory(id: string, memory: string): Promise<void> {
	const db = await appDb();
	await db.execute({ sql: 'UPDATE projects SET memory = ? WHERE id = ?', args: [memory, id] });
}

/** Adds a line to the repo's notes in one statement, so a note never overwrites another; false when it would not fit. */
export async function appendProjectMemory(id: string, line: string, maxLength: number): Promise<boolean> {
	const db = await appDb();
	const result = await db.execute({
		sql: `UPDATE projects SET memory = CASE WHEN memory = '' THEN ? ELSE memory || char(10) || ? END
			WHERE id = ? AND length(memory) + length(?) + 1 <= ?`,
		args: [line, line, id, line, maxLength],
	});
	return result.rowsAffected === 1;
}

/** Ids of every task on the repo, finished setting up or not. */
export async function projectSessionIds(id: string): Promise<string[]> {
	const db = await appDb();
	const result = await db.execute({ sql: 'SELECT id FROM sessions WHERE project_id = ?', args: [id] });
	return result.rows.map((row) => String(row.id));
}

/** Removes the repo with its automations and issue claims, and any task rows its caller has not already deleted. */
export async function deleteProjectRecord(id: string): Promise<void> {
	const db = await appDb();
	const tables = ['automations', 'issue_tasks', 'sessions'];
	const statements = tables.map((table) => ({ sql: `DELETE FROM ${table} WHERE project_id = ?`, args: [id] }));
	await db.batch([...statements, { sql: 'DELETE FROM projects WHERE id = ?', args: [id] }], 'write');
}
