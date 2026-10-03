import type { Client } from '@libsql/client';

/**
 * Append-only list of schema changes. Each runs once, in order, and is
 * recorded in `schema_migrations`. Never edit a shipped entry; add a new one.
 */
const migrations: string[][] = [
	// 1: the schema as it existed before versioning.
	[
		`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, github_id TEXT, login TEXT NOT NULL, avatar_url TEXT, created_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS oauth_tokens (user_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT, expires_at TEXT)`,
		`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, repo_full_name TEXT NOT NULL, default_branch TEXT NOT NULL, snapshot_image_id TEXT, workspace_path TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, flue_conversation_id TEXT NOT NULL, sandbox_id TEXT, status TEXT NOT NULL, model TEXT NOT NULL, pr_url TEXT, error_message TEXT, title TEXT NOT NULL DEFAULT 'New chat', created_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tigris_key TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL)`,
	],
	// 2: per-task branches and remote sandboxes; drop tables nothing uses.
	[
		`ALTER TABLE projects ADD COLUMN warmed_at TEXT`,
		`ALTER TABLE sessions ADD COLUMN branch TEXT`,
		`ALTER TABLE sessions ADD COLUMN base_branch TEXT`,
		`ALTER TABLE sessions ADD COLUMN base_sha TEXT`,
		`ALTER TABLE sessions ADD COLUMN machine_state TEXT`,
		`ALTER TABLE sessions ADD COLUMN checkpoint_at TEXT`,
		`CREATE UNIQUE INDEX IF NOT EXISTS projects_repo ON projects (repo_full_name)`,
		`DROP TABLE IF EXISTS oauth_tokens`,
		`DROP TABLE IF EXISTS artifacts`,
	],
	// 3: per-task reasoning level; null means the model's default.
	[`ALTER TABLE sessions ADD COLUMN reasoning TEXT`],
	// 4: tasks that exist now were set up before the setup marker, so their machines carry none.
	[`ALTER TABLE sessions ADD COLUMN legacy_setup INTEGER NOT NULL DEFAULT 0`, `UPDATE sessions SET legacy_setup = 1`],
	// 5: per-repo environment, setup script, preview ports and base image.
	[
		`ALTER TABLE projects ADD COLUMN env_json TEXT`,
		`ALTER TABLE projects ADD COLUMN setup_script TEXT`,
		`ALTER TABLE projects ADD COLUMN preview_ports TEXT`,
		`ALTER TABLE projects ADD COLUMN base_image TEXT`,
	],
];

export async function migrate(db: Client): Promise<void> {
	await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
	const applied = await db.execute('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
	const current = Number(applied.rows[0]?.version ?? 0);
	for (const [index, statements] of migrations.entries()) {
		const version = index + 1;
		if (version <= current) continue;
		await db.batch(
			[...statements, { sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', args: [version, new Date().toISOString()] }],
			'write',
		);
	}
}
