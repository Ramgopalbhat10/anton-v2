import { randomUUID } from 'node:crypto';
import type { Project } from '../core/types.ts';
import { appDb } from './client.ts';

type Row = Record<string, unknown>;
const optional = (value: unknown) => (value == null ? null : String(value));

function toProject(row: Row): Project {
	return {
		id: String(row.id),
		repoFullName: String(row.repo_full_name),
		defaultBranch: String(row.default_branch),
		warmImage: optional(row.snapshot_image_id),
		warmedAt: optional(row.warmed_at),
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

export async function setWarmImage(id: string, image: string): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: 'UPDATE projects SET snapshot_image_id = ?, warmed_at = ? WHERE id = ?',
		args: [image, new Date().toISOString(), id],
	});
}
