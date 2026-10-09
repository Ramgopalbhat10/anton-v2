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
	// 6: model tokens and cost per task.
	[
		`ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0`,
	],
	// 7: every response's cost, for daily spending caps; and app-wide settings.
	[
		`CREATE TABLE IF NOT EXISTS usage_log (session_id TEXT NOT NULL, at TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS usage_log_at ON usage_log (at)`,
		`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
	],
	// 8: tasks that start themselves, follow-ups on the agent's pull requests, and MCP servers.
	[
		`ALTER TABLE projects ADD COLUMN follow_ups INTEGER NOT NULL DEFAULT 1`,
		`ALTER TABLE projects ADD COLUMN mcp_json TEXT`,
		`ALTER TABLE sessions ADD COLUMN follow_json TEXT`,
		`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT, every_hours INTEGER, prompt TEXT NOT NULL, model TEXT, reasoning TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, last_error TEXT, created_at TEXT NOT NULL)`,
		// One row per issue that has a task, so no issue starts two, whichever automation finds it.
		`CREATE TABLE IF NOT EXISTS issue_tasks (project_id TEXT NOT NULL, issue_number INTEGER NOT NULL, automation_id TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY (project_id, issue_number))`,
	],
	// 9: plan mode per task, and automations whose tasks plan first and wait for approval.
	[`ALTER TABLE sessions ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0`, `ALTER TABLE automations ADD COLUMN plan_first INTEGER NOT NULL DEFAULT 0`],
	// 10: notes about the repo that every task's agent reads, kept by the agent and the user.
	[`ALTER TABLE projects ADD COLUMN memory TEXT NOT NULL DEFAULT ''`],
	// 11: each response's repository and model, so spend can be broken down even after a task is deleted.
	[
		`ALTER TABLE usage_log ADD COLUMN project_id TEXT`,
		`ALTER TABLE usage_log ADD COLUMN model TEXT`,
		`UPDATE usage_log SET project_id = (SELECT project_id FROM sessions WHERE sessions.id = usage_log.session_id), model = (SELECT model FROM sessions WHERE sessions.id = usage_log.session_id)`,
	],
	// 12: installed plugins, each a set of skills every task's agent can use; kept whole, so a task never waits on GitHub for them.
	[
		`CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, source_json TEXT NOT NULL, sha TEXT NOT NULL, marketplace TEXT, skills_json TEXT NOT NULL, mcp_json TEXT NOT NULL, skipped_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, installed_at TEXT NOT NULL)`,
	],
	// 13: one durable usage entry per task/model call, even after retries or dev reloads.
	[
		`ALTER TABLE usage_log ADD COLUMN turn_id TEXT`,
		`CREATE UNIQUE INDEX usage_log_turn ON usage_log (session_id, turn_id) WHERE turn_id IS NOT NULL`,
	],
	// 14: tasks pinned to the top of the sidebar.
	[`ALTER TABLE sessions ADD COLUMN pinned_at TEXT`],
	// 15: what each plugin was installed from (a marketplace entry or an address), to show and update it from the same place.
	[`ALTER TABLE plugins ADD COLUMN pick_json TEXT`],
	// 16: the state and checks of each task's pull request, last read from the host, for the sidebar.
	[`ALTER TABLE sessions ADD COLUMN pr_json TEXT`],
	// 17: each task's latest input and when it came, for cards that show what the task was last asked.
	[`ALTER TABLE sessions ADD COLUMN last_input TEXT`, `ALTER TABLE sessions ADD COLUMN last_input_at TEXT`],
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
