import { createClient, type Client } from '@libsql/client';
import { env } from './env.ts';

let client: Client | undefined;

export function appDb(): Client {
	if (!client) {
		client = createClient({
			url: env.tursoUrl,
			authToken: env.tursoToken || undefined,
		});
	}
	return client;
}

export async function migrateAppDb(db = appDb()): Promise<void> {
	await db.executeMultiple(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			github_id TEXT,
			login TEXT NOT NULL,
			avatar_url TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS oauth_tokens (
			user_id TEXT PRIMARY KEY,
			access_token TEXT NOT NULL,
			refresh_token TEXT,
			expires_at TEXT,
			needs_reconnect INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (user_id) REFERENCES users(id)
		);
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			repo_full_name TEXT NOT NULL,
			default_branch TEXT NOT NULL,
			snapshot_image_id TEXT,
			workspace_path TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (user_id) REFERENCES users(id)
		);
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			flue_conversation_id TEXT NOT NULL,
			sandbox_id TEXT,
			status TEXT NOT NULL,
			model TEXT NOT NULL,
			pr_url TEXT,
			error_message TEXT,
			title TEXT NOT NULL DEFAULT 'New chat',
			created_at TEXT NOT NULL,
			FOREIGN KEY (project_id) REFERENCES projects(id)
		);
		CREATE TABLE IF NOT EXISTS artifacts (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			tigris_key TEXT NOT NULL,
			kind TEXT NOT NULL,
			created_at TEXT NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);
	`);
	const columns = await db.execute('PRAGMA table_info(oauth_tokens)');
	const names = new Set(columns.rows.map((row) => String(row.name)));
	if (!names.has('needs_reconnect')) {
		await db.execute('ALTER TABLE oauth_tokens ADD COLUMN needs_reconnect INTEGER NOT NULL DEFAULT 0');
	}
}

export function resetAppDbForTests(): void {
	client = undefined;
}
