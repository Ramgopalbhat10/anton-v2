import { type Client, createClient } from '@libsql/client';
import { config } from '../config.ts';
import { migrate } from './migrations.ts';

let client: Client | undefined;
let ready: Promise<Client> | undefined;

/** The app database, migrated once per process before first use. */
export function appDb(): Promise<Client> {
	ready ??= (async () => {
		client = createClient({ url: config.databaseUrl, authToken: config.databaseToken || undefined });
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
