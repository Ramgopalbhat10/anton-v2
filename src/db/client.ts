import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Client, createClient } from '@libsql/client';
import { config } from '../config.ts';
import { migrate } from './migrations.ts';

let client: Client | undefined;
let ready: Promise<Client> | undefined;

/** The app database, migrated once per process before first use. */
export function appDb(): Promise<Client> {
	ready ??= (async () => {
		// SQLite creates its file, but not its parent folder on a fresh installation.
		if (config.databaseUrl.startsWith('file:') && !config.databaseUrl.startsWith('file::memory:')) {
			const url = new URL(config.databaseUrl, pathToFileURL(`${process.cwd()}/`));
			mkdirSync(path.dirname(fileURLToPath(url)), { recursive: true });
		}
		client = createClient({ url: config.databaseUrl, authToken: config.databaseToken || undefined });
		// WAL lets Litestream stream every write to storage (scripts/start-with-backup.sh); it stays set in the file.
		if (config.databaseUrl.startsWith('file:')) await client.execute('PRAGMA journal_mode = WAL');
		await migrate(client);
		return client;
	})();
	return ready;
}

/** Points the app at another database (tests). */
export function useDatabase(next: Client): void {
	client = next;
	ready = migrate(next).then(() => next);
}
