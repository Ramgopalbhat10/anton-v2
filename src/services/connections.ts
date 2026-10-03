import { config } from '../config.ts';
import { appDb } from '../db/client.ts';
import { getProviders } from '../providers/index.ts';

/** `set` when it is set up but not checked from here; `off` when it is not set up; `failing` when the check did not pass. */
export type Connection = { id: string; name: string; provider: string; detail: string; state: 'ok' | 'set' | 'off' | 'failing' };

const CHECK_MS = 10_000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`No answer within ${CHECK_MS / 1000}s`)), CHECK_MS);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

type Check = { id: string; name: string; provider: string; off?: string; unchecked?: boolean; run: () => Promise<string> };

function checks(): Check[] {
	const { git, sandbox, store, models } = getProviders();
	const web = config.web.mcpUrl === 'off' ? null : new URL(config.web.mcpUrl);
	return [
		{
			id: 'git',
			name: 'Code host',
			provider: git.name,
			off: config.github.token ? undefined : 'ANTON_GITHUB_TOKEN is not set, so Anton cannot read repositories or push.',
			run: async () => `Acting as ${(await git.accountName()) ?? 'an account with no name'}. Pushes and pull requests go through its API.`,
		},
		{
			id: 'sandbox',
			name: 'Sandboxes',
			provider: sandbox.name,
			run: async () => {
				const running = (await sandbox.running()).size;
				const where = sandbox.name === 'modal' ? `Modal app ${config.modal.app}` : 'this server, in folders under the data directory';
				return `Tasks run in ${where}. ${running} running now.`;
			},
		},
		{
			id: 'store',
			name: 'Object storage',
			provider: store.name,
			run: async () => {
				await store.has('anton/connection-check');
				return store.name === 's3' ? `Bucket ${config.s3.bucket} at ${new URL(config.s3.endpoint).host}.` : 'Files under the data directory on this server.';
			},
		},
		{
			id: 'models',
			name: 'Models',
			provider: models.name,
			off: config.hasOpenRouter() ? undefined : 'OPENROUTER_API_KEY is not set, so the agent cannot answer.',
			run: async () => `${(await models.list()).length} models that can call tools.`,
		},
		{
			id: 'web',
			name: 'Web search',
			provider: web?.host ?? 'off',
			off: web ? undefined : 'ANTON_WEB_MCP_URL is off, so the agent has no web_search or web_fetch.',
			// The agent connects to it itself; a dead server only costs it those two tools.
			unchecked: true,
			run: async () => `web_search and web_fetch through ${web?.host}, ${config.web.apiKey ? 'with an API key' : 'on the free tier'}. The agent connects to it itself.`,
		},
		{
			id: 'database',
			name: 'Database',
			provider: config.databaseUrl.startsWith('file:') ? 'sqlite' : 'libsql',
			run: async () => {
				await (await appDb()).execute('SELECT 1');
				return config.databaseUrl.startsWith('file:') ? 'A file on this server.' : `Hosted at ${new URL(config.databaseUrl).host}.`;
			},
		},
	];
}

async function probe({ id, name, provider, off, unchecked, run }: Check): Promise<Connection> {
	if (off) return { id, name, provider, detail: off, state: 'off' };
	try {
		return { id, name, provider, detail: await withTimeout(run()), state: unchecked ? 'set' : 'ok' };
	} catch (error) {
		return { id, name, provider, detail: error instanceof Error ? error.message : String(error), state: 'failing' };
	}
}

/** Every service Anton depends on, each checked live. */
export function connections(): Promise<Connection[]> {
	return Promise.all(checks().map(probe));
}
