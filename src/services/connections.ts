import { config } from '../config.ts';
import { appDb } from '../db/client.ts';
import { getProviders } from '../providers/index.ts';
import { accessToken, subscriptionProviders, subscriptionView } from './subscriptions.ts';

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

/** Each plan you can sign in to: off until you do, then checked by renewing its token if it needs it. */
async function subscriptionChecks(): Promise<Check[]> {
	return Promise.all(
		subscriptionProviders().map(async (provider): Promise<Check> => {
			const view = await subscriptionView(provider);
			return {
				id: `subscription-${provider.id}`,
				name: `${provider.name} plan`,
				provider: provider.gateway,
				off: view.state === 'signed-out' ? 'Not signed in. Sign in under Settings › Subscriptions to run tasks on your plan instead of per token.' : undefined,
				run: async () => {
					await accessToken(provider.id);
					const models = view.options.enabled ? `${view.models.length} models in the picker` : 'its models are switched off';
					return `Signed in${view.email ? ` as ${view.email}` : ''}; ${models}.`;
				},
			};
		}),
	);
}

async function checks(): Promise<Check[]> {
	const { git, sandbox, store, models, decisions } = getProviders();
	const plans = await subscriptionChecks();
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
		...plans,
		{
			id: 'decisions',
			name: 'Decision model',
			provider: decisions?.name.replace(/^openrouter\//, '') ?? 'off',
			off: decisions
				? undefined
				: config.decisionModel === 'off'
					? 'ANTON_DECISION_MODEL is off, so every comment wakes the agent and every pull request is reviewed.'
					: 'Needs OPENROUTER_API_KEY. Without it, every comment wakes the agent and every pull request is reviewed.',
			run: async () => {
				// One tiny question, a hundred-thousandth of a dollar.
				await decisions!.decide({ check: 'connection' }, { ok: { type: 'yes-no', instructions: 'Is this a connection check?' } });
				return 'Skips pull request comments that ask nothing and automatic reviews of documentation-only changes; decide() in code mode.';
			},
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
export async function connections(): Promise<Connection[]> {
	return Promise.all((await checks()).map(probe));
}
