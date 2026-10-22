import type { Client } from '@libsql/client';

/**
 * Append-only list of schema changes. Each runs once, in order, and is
 * recorded in `schema_migrations`. Never edit a shipped entry; add a new one.
 */
export const migrations: string[][] = [
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
	// 18: input tokens the provider read from its cache, part of input_tokens and priced lower, per call and per task.
	[`ALTER TABLE usage_log ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0`, `ALTER TABLE sessions ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0`],
	// 19: what the agent's last reply asks the user, until they answer, so the task shows it waits on them.
	[`ALTER TABLE sessions ADD COLUMN asking TEXT`],
	// 20: projects (spaces in code, since `projects` means a repository): a coordinator conversation over parallel threads, each a task.
	[
		`CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, goal TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', memory TEXT NOT NULL DEFAULT '', coordinator_model TEXT, coordinator_reasoning TEXT, thread_model TEXT, thread_reasoning TEXT, max_parallel INTEGER NOT NULL DEFAULT 3, autonomy TEXT NOT NULL DEFAULT 'start', state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS space_repos (space_id TEXT NOT NULL, project_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (space_id, project_id))`,
		`ALTER TABLE sessions ADD COLUMN space_id TEXT`,
		`ALTER TABLE sessions ADD COLUMN resolved_at TEXT`,
		// The state the coordinator was last told about, so a thread reports each change once.
		`ALTER TABLE sessions ADD COLUMN reported_state TEXT`,
		// The coordinator's brief, held while the thread waits for a free slot.
		`ALTER TABLE sessions ADD COLUMN brief TEXT`,
		// The thread's latest reply, for the coordinator's reports and the thread's card.
		`ALTER TABLE sessions ADD COLUMN last_reply TEXT`,
		`CREATE INDEX IF NOT EXISTS sessions_space ON sessions (space_id)`,
		// Coordinator turns have no task, so their spend is kept by project.
		`ALTER TABLE usage_log ADD COLUMN space_id TEXT`,
		// Routines scoped to a project start their tasks as its threads.
		`ALTER TABLE automations ADD COLUMN space_id TEXT`,
	],
	// 21: the agent's latest todo list for the task, shown as the progress pill above the composer.
	[`ALTER TABLE sessions ADD COLUMN todos_json TEXT`],
	// 22: a repository's sandboxes can run as full VMs (Docker, FUSE) instead of containers.
	[`ALTER TABLE projects ADD COLUMN full_vm INTEGER NOT NULL DEFAULT 0`],
	// 23: code mode is on by default now; settings saved while it was off by default are turned on once.
	[`UPDATE settings SET value = json_set(value, '$.codeMode', json('true')) WHERE key = 'general' AND json_valid(value)`],
	// 24: the plan the latest reply proposed in plan mode, waiting for approval; null when none waits.
	[`ALTER TABLE sessions ADD COLUMN plan TEXT`],
	// 25: tasks that review someone else's pull request, and repos whose pull requests Anton reviews from when it was turned on.
	[`ALTER TABLE sessions ADD COLUMN review_json TEXT`, `ALTER TABLE projects ADD COLUMN review_others_at TEXT`],
	// 26: pages the agent drew (their titles, and the state every open copy of one shares), and each task's Library as listed last, for the Artifacts page.
	[
		`CREATE TABLE IF NOT EXISTS pages (session_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, state_json TEXT, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (session_id, path))`,
		`CREATE TABLE IF NOT EXISTS output_index (session_id TEXT PRIMARY KEY, outputs_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,
	],
	// 27: tasks this database deleted, the only ones whose stored files cleanup may remove: storage can be shared with another database.
	[`CREATE TABLE IF NOT EXISTS deleted_sessions (session_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)`],
	// 28: where in a reply the agent read each message sent while it worked, so the thread shows it there.
	[`ALTER TABLE sessions ADD COLUMN joins_json TEXT`],
	// 29: MCP servers are added once for every task, as skills are, rather than per repository; each repository's are moved over, the first of a name kept.
	[
		`CREATE TABLE IF NOT EXISTS mcp_servers (name TEXT PRIMARY KEY, url TEXT NOT NULL, auth TEXT, tools_json TEXT NOT NULL, code_mode INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, added_at TEXT NOT NULL)`,
		`INSERT OR IGNORE INTO mcp_servers (name, url, auth, tools_json, code_mode, enabled, added_at)
			SELECT json_extract(server.value, '$.name'), json_extract(server.value, '$.url'), json_extract(server.value, '$.auth'),
				COALESCE(json_extract(server.value, '$.tools'), '[]'), CASE WHEN json_extract(server.value, '$.codeMode') = 0 THEN 0 ELSE 1 END, 1,
				strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			FROM projects, json_each(projects.mcp_json) AS server
			WHERE projects.mcp_json IS NOT NULL AND json_valid(projects.mcp_json) AND json_extract(server.value, '$.name') IS NOT NULL AND json_extract(server.value, '$.url') IS NOT NULL
			ORDER BY projects.updated_at`,
	],
	// 30: emails the agent asked to send, each waiting for your Send in the thread; the draft's digest makes sure what you approved is what goes.
	[
		`CREATE TABLE IF NOT EXISTS mail_approvals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, connector TEXT NOT NULL, draft_id TEXT NOT NULL, draft_json TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, sent_id TEXT)`,
		`CREATE INDEX IF NOT EXISTS mail_approvals_session ON mail_approvals (session_id)`,
	],
	// 31: an MCP server's sign-in (OAuth): its registered client, where it signs in, and its tokens, kept apart from the server's view.
	[`ALTER TABLE mcp_servers ADD COLUMN oauth_json TEXT`],
	// 32: the routine that started a task, whose runs are done once they reply without asking you; and a routine's short name, its threads' title.
	// A schedule's runs so far are found by the title they were given (the first line of its instructions, cut at 80), and those left idle are done.
	[
		`ALTER TABLE sessions ADD COLUMN automation_id TEXT`,
		`ALTER TABLE automations ADD COLUMN title TEXT`,
		`UPDATE sessions SET automation_id = (
			SELECT a.id FROM automations a
			WHERE a.kind = 'schedule' AND a.space_id = sessions.space_id
				AND substr(CASE WHEN instr(a.prompt, char(10)) > 0 THEN substr(a.prompt, 1, instr(a.prompt, char(10)) - 1) ELSE a.prompt END, 1, 80) = sessions.title
			ORDER BY a.created_at LIMIT 1)
		WHERE space_id IS NOT NULL AND automation_id IS NULL`,
		`UPDATE sessions SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE automation_id IS NOT NULL AND resolved_at IS NULL AND asking IS NULL AND plan IS NULL AND brief IS NULL AND pr_url IS NULL AND status != 'error' AND last_reply IS NOT NULL`,
	],
	// 33: files you deleted from a task's Library or from Artifacts, so a reply that showed one says it was deleted rather than drawing it broken.
	[`CREATE TABLE IF NOT EXISTS deleted_outputs (session_id TEXT NOT NULL, path TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY (session_id, path))`],
	// 34: a routine runs on a schedule kept on a time zone's clock (`src/core/schedule.ts`), and keeps when it runs next.
	// Each "every N hours" routine moves to the nearest schedule on the UTC clock, at the time it last ran (else was added):
	// hours dividing a day stay hourly (others round down to one that does), a day is daily, whole days are a cron
	// expression, and a week or more is weekly on that weekday. Its next run is worked out from its last, as before.
	[
		`ALTER TABLE automations ADD COLUMN schedule_json TEXT`,
		`ALTER TABLE automations ADD COLUMN next_run_at TEXT`,
		`UPDATE automations SET schedule_json = (
			SELECT json_object(
				'frequency', CASE WHEN hours < 24 THEN 'hourly' WHEN hours = 24 THEN 'daily' WHEN hours >= 168 THEN 'weekly' WHEN hours % 24 = 0 THEN 'cron' ELSE 'daily' END,
				'time', strftime('%H:%M', anchor),
				'everyHours', CASE WHEN hours >= 12 THEN 12 WHEN hours >= 8 THEN 8 WHEN hours >= 6 THEN 6 WHEN hours >= 4 THEN 4 ELSE hours END,
				'days', json_array(CAST(strftime('%w', anchor) AS INTEGER)),
				'dayOfMonth', 1,
				'cron', CASE WHEN hours > 24 AND hours < 168 AND hours % 24 = 0
					THEN CAST(strftime('%M', anchor) AS INTEGER) || ' ' || CAST(strftime('%H', anchor) AS INTEGER) || ' */' || (hours / 24) || ' * *'
					ELSE '' END,
				'timeZone', 'UTC')
			FROM (SELECT MAX(1, COALESCE(automations.every_hours, 24)) AS hours, COALESCE(automations.last_run_at, automations.created_at) AS anchor))
		WHERE kind = 'schedule'`,
	],
	// 35: where a gateway sends a task's model calls (`src/core/model-route.ts`): one provider first, or a sort; null leaves it to the gateway.
	[`ALTER TABLE sessions ADD COLUMN route_json TEXT`],
];

/** Brings the database up to the latest version, or to `upTo` (for tests of one migration). */
export async function migrate(db: Client, upTo = migrations.length): Promise<void> {
	await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
	const applied = await db.execute('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
	const current = Number(applied.rows[0]?.version ?? 0);
	for (const [index, statements] of migrations.entries()) {
		const version = index + 1;
		if (version <= current || version > upTo) continue;
		await db.batch(
			[...statements, { sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', args: [version, new Date().toISOString()] }],
			'write',
		);
	}
}
