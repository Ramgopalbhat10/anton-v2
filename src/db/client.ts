import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { expandConfig, isInMemoryConfig } from '@libsql/core/config';
import { config } from '../config.ts';
import { migrate } from './migrations.ts';

let client: Client | undefined;
let ready: Promise<Client> | undefined;

/** The app database, migrated once per process before first use. */
export function appDb(): Promise<Client> {
	ready ??= (async () => {
		const options = { url: config.databaseUrl, authToken: config.databaseToken || undefined };
		// Match libSQL's decoding (including encoded separators), relative paths and memory URLs.
		const expanded = expandConfig(options, true);
		// SQLite creates its file, but not its parent folder on a fresh installation.
		if (expanded.scheme === 'file' && !isInMemoryConfig(expanded)) {
			mkdirSync(path.dirname(expanded.path), { recursive: true });
		}
		client = createClient(options);
		// WAL lets Litestream stream every write to storage (scripts/start-with-backup.sh); it stays set in the file.
		if (expanded.scheme === 'file') await client.execute('PRAGMA journal_mode = WAL');
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
