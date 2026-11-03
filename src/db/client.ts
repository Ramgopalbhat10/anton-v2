import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { expandConfig, isInMemoryConfig } from '@libsql/core/config';
import { config } from '../config.ts';
import { logProblem } from '../services/log.ts';
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
		client = waitWhenBusy(createClient(options));
		// WAL lets Litestream stream every write to storage (scripts/start-with-backup.sh); it stays set in the file.
		if (expanded.scheme === 'file') await client.execute('PRAGMA journal_mode = WAL');
		await migrate(client);
		return client;
	})();
	return ready;
}

/** How long a statement waits for another writer (Litestream's checkpoint, say) before it fails. */
const BUSY_WAIT_MS = 5_000;

export const isBusy = (error: unknown): boolean =>
	error instanceof Error && (/^SQLITE_BUSY/.test(String((error as { code?: unknown }).code ?? '')) || /database is locked/i.test(error.message));

/** A lock held this long is no checkpoint: something holds the database and every write fails until it lets go. */
const STUCK_MS = 30_000;
/** Since when statements have given up on a locked database, with none getting through; null while they do. */
let lockedSince: number | null = null;
let toldAt = 0;

/** Says so, once a minute, when the database has refused every write for a while: Settings › Recent problems shows it, as does the console. */
function noteGaveUp(now = Date.now()): void {
	lockedSince ??= now;
	if (now - lockedSince < STUCK_MS || now - toldAt < 60_000) return;
	toldAt = now;
	logProblem(
		'error',
		`The database has been locked for ${Math.round((now - lockedSince) / 1000)}s and nothing is being saved: replies, traces and usage are lost until it is freed. ` +
			'Litestream (npm run start:backup) may be stuck holding it; restarting Anton frees it.',
	);
}

/** Runs `work` again while the database is locked by another writer, for up to `waitMs`; a busy statement did nothing, so trying it again is safe. */
export async function whenFree<T>(work: () => Promise<T>, waitMs = BUSY_WAIT_MS): Promise<T> {
	const until = Date.now() + waitMs;
	for (let pause = 10; ; pause = Math.min(pause * 2, 250)) {
		try {
			const result = await work();
			lockedSince = null;
			return result;
		} catch (error) {
			if (!isBusy(error)) throw error;
			if (Date.now() + pause > until) {
				noteGaveUp();
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, pause));
		}
	}
}

/**
 * libSQL opens a file with no busy timeout, and opens a new connection after
 * each transaction, so a pragma cannot set one. Litestream writes to and
 * checkpoints the same file (`npm run start:backup`), and a statement that met
 * its lock failed at once with "database is locked". Statements and batches
 * now wait for it, without blocking the event loop.
 */
function waitWhenBusy(client: Client): Client {
	const execute = client.execute.bind(client) as (...args: unknown[]) => ReturnType<Client['execute']>;
	const batch = client.batch.bind(client) as (...args: unknown[]) => ReturnType<Client['batch']>;
	client.execute = ((...args: unknown[]) => whenFree(() => execute(...args))) as Client['execute'];
	client.batch = ((...args: unknown[]) => whenFree(() => batch(...args))) as Client['batch'];
	return client;
}

/** Points the app at another database (tests). */
export function useDatabase(next: Client): void {
	client = next;
	ready = migrate(next).then(() => next);
}
