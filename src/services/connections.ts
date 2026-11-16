import { config } from '../config.ts';
import { appDb } from '../db/client.ts';
import { getProviders } from '../providers/index.ts';
import { openRouterKeySource } from '../providers/openrouter/key.ts';
import { logProblem } from './log.ts';
import { accessToken, agentRuntimes, loadGatewayKey, subscriptionProviders, subscriptionView } from './subscriptions.ts';
import { whyNoAnswer } from './why-no-answer.ts';

/** `set` when it is set up but not checked from here; `off` when it is not set up; `failing` when the check did not pass. */
export type Connection = { id: string; name: string; provider: string; detail: string; state: 'ok' | 'set' | 'off' | 'failing' };

export const CHECK_MS = 10_000;

/** A check that ran out of time, told apart from one that was answered with an error. */
class NoAnswer extends Error {}

/**
 * Runs a check for at most CHECK_MS. Out of time with the service's `url`, it says which step was slow (the
 * address lookup, the connection, or the service), since one stall on this server fails every check at once.
 */
export async function withTimeout<T>(work: Promise<T>, url?: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new NoAnswer(`No answer within ${CHECK_MS / 1000}s`)), CHECK_MS);
	});
	try {
		return await Promise.race([work, timeout]);
	} catch (error) {
		if (error instanceof NoAnswer && url) throw new Error(await whyNoAnswer(url, CHECK_MS));
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/** `url` is the service's address, for saying why it did not answer in time. */
type Check = { id: string; name: string; provider: string; off?: string; unchecked?: boolean; url?: string; run: () => Promise<string> };

/** Each plan you can sign in to: off until you do, then checked by renewing its token if it needs it. */
async function subscriptionChecks(): Promise<Check[]> {
	const runtimes = await Promise.all(
		agentRuntimes().map(async (runtime): Promise<Check> => {
			const status = await runtime.status();
			return {
				id: `subscription-${runtime.id}`,
				name: `${runtime.name} plan`,
				provider: runtime.gateway,
				off: status.signedIn || status.problem ? undefined : 'Claude Code is not signed in. Settings › Subscriptions has the command to run once on the server.',
				run: async () => {
					const fresh = await runtime.status(true);
					if (!fresh.signedIn) throw new Error(fresh.problem ?? 'Claude Code is not signed in.');
					const who = fresh.email ? ` as ${fresh.email}` : '';
					const plan = fresh.plan ? ` on the ${fresh.plan} plan` : '';
					return `Claude Code${fresh.version ? ` ${fresh.version}` : ''} is signed in${who}${plan}. Anton never sees its token.`;
				},
			};
		}),
	);
	const plans = await Promise.all(
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
	return [...plans, ...runtimes];
}

async function checks(): Promise<Check[]> {
	await loadGatewayKey();
	const { git, sandbox, store, models, decisions } = getProviders();
	const plans = await subscriptionChecks();
	const keySource = openRouterKeySource();
	const web = config.web.mcpUrl === 'off' ? null : new URL(config.web.mcpUrl);
	return [
		{
			id: 'git',
			name: 'Code host',
			provider: git.name,
			url: config.github.apiUrl,
			off: config.github.token ? undefined : 'No GitHub token, so Anton cannot read repositories or push.',
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
			url: store.name === 's3' ? config.s3.endpoint : undefined,
			run: async () => {
				await store.has('anton/connection-check');
				return store.name === 's3' ? `Bucket ${config.s3.bucket} at ${new URL(config.s3.endpoint).host}.` : 'Files under the data directory on this server.';
			},
		},
		{
			id: 'models',
			name: 'Models',
			provider: models.name,
			url: config.openrouter.apiUrl,
			off: keySource ? undefined : 'No OpenRouter key, so the agent cannot answer on OpenRouter models. Add one under Settings › Subscriptions.',
			run: async () =>
				`${(await models.list()).length} models that can call tools, with ${keySource === 'settings' ? 'the key from Settings › Subscriptions' : 'OPENROUTER_API_KEY'}.`,
		},
		...plans,
		{
			id: 'decisions',
			name: 'Decision model',
			provider: decisions?.name.replace(/^openrouter\//, '') ?? 'off',
			url: config.openrouter.apiUrl,
			off: decisions
				? undefined
				: config.decisionModel === 'off'
					? 'Off, so every comment wakes the agent and every pull request is reviewed.'
					: 'Needs an OpenRouter key (Settings › Subscriptions). Without it, every comment wakes the agent and every pull request is reviewed.',
			run: async () => {
				// One tiny question, a hundred-thousandth of a dollar.
				await decisions!.decide({ check: 'connection' }, { ok: { type: 'yes-no', instructions: 'Is this a connection check?' } });
				return 'Skips pull request comments that ask nothing and automatic reviews of documentation-only changes, drives the browser agent through sites, and answers decide() in code mode.';
			},
		},
		{
			id: 'web',
			name: 'Web search',
			provider: web?.host ?? 'off',
			off: web ? undefined : 'Web search is off, so the agent has no web_search or web_fetch.',
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

async function probe({ id, name, provider, off, unchecked, url, run }: Check): Promise<Connection> {
	if (off) return { id, name, provider, detail: off, state: 'off' };
	try {
		return { id, name, provider, detail: await withTimeout(run(), url), state: unchecked ? 'set' : 'ok' };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		logProblem('warn', `${name} failed its connection check`, error);
		return { id, name, provider, detail, state: 'failing' };
	}
}

/** Every service Anton depends on, each checked live. */
export async function connections(): Promise<Connection[]> {
	return Promise.all((await checks()).map(probe));
}
