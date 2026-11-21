import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { config } from '../../config.ts';
import { announce } from '../../core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../../core/errors.ts';
import type {
	AgentRuntime,
	GatewayAccount,
	KeyPlan,
	ModelInfo,
	OAuthClient,
	PlanWindow,
	RuntimeSignIn,
	SubscriptionCredential,
	SubscriptionLogin,
	SubscriptionModel,
	SubscriptionProvider,
} from '../../core/ports.ts';
import { spendBy, tokensByMinute } from '../../db/sessions.ts';
import { getSetting, setSetting } from '../../db/settings.ts';
import { type Gateway, getProviders } from '../../providers/index.ts';
import { openRouterKey, openRouterKeySlot } from '../../providers/openrouter/key.ts';
import { vercelKeySlot } from '../../providers/vercel/key.ts';
import { logProblem } from '../../core/log.ts';

/*
 * Plans you already pay for. A ChatGPT plan's sign-in is kept and renewed here. A Claude plan runs through Claude Code (an
 * `AgentRuntime`), which keeps its token to itself; Anton only reads its status. Key plans and gateways keep a pasted key;
 * OpenRouter's pasted key replaces OPENROUTER_API_KEY for the agents, decision and vision models.
 */

/** `countAtApiPrices` counts their calls toward the spending caps as if billed per token. */
export type SubscriptionOptions = { enabled: boolean; countAtApiPrices: boolean };

type Stored = SubscriptionOptions & {
	credential: SubscriptionCredential | null;
	key: string | null;
	account: string | null;
	connectedAt: string | null;
	models: SubscriptionModel[];
	modelsAt: number | null;
	/** So a list kept from before a change to the listing is not served for its hour. */
	modelsVersion?: number;
	problem: string | null;
	limitHitAt: string | null;
	extraUsageAt: string | null;
};

export type SubscriptionView = {
	id: string;
	name: string;
	/**
	 * `oauth`: Anton signs in and holds the token. `runtime`: the vendor's own program signs in on the server.
	 * `key`: a key from the vendor's dashboard. `gateway`: OpenRouter or Vercel AI Gateway, billed per token.
	 */
	kind: 'oauth' | 'runtime' | 'key' | 'gateway';
	gateway: string;
	state: 'connected' | 'expired' | 'signed-out';
	email: string | null;
	connectedAt: string | null;
	problem: string | null;
	expiresAt: string | null;
	options: SubscriptionOptions;
	/** A model's larger context and fast mode are not rows of their own: their tokens count toward it, and `options` names them. */
	models: Array<Pick<ModelInfo, 'id' | 'name' | 'contextLength' | 'vision' | 'reasoning' | 'defaultReasoning'> & { tokens: number; options: string[] } & GatewayFields>;
	monthTokens: number;
	modelsAt: string | null;
	login: { url: string; redirectUri: string; listening: boolean; startedAt: string } | null;
	plan: string | null;
	version: string | null;
	signIn: string | null;
	limitHitAt: string | null;
	extraUsageAt: string | null;
	keyPage: string | null;
	keyHint: string | null;
	windows: PlanWindow[] | null;
	keySource?: 'settings' | 'environment' | null;
	envVar?: string | null;
	/** Set on runtimes whose agent container placement is configurable (ACP on Modal). */
	isolation?: 'sidecar' | 'sandbox' | null;
	/** The OAuth client a runtime's sign-in uses, when Settings keeps one (empty until saved); a public installed-app client, so shown whole. */
	oauthClient?: OAuthClient | null;
};

type GatewayFields = { vendor?: string; price?: Pick<ModelInfo['price'], 'input' | 'output'> };

const DEFAULTS: Stored = {
	enabled: true,
	countAtApiPrices: false,
	credential: null,
	key: null,
	account: null,
	connectedAt: null,
	models: [],
	modelsAt: null,
	problem: null,
	limitHitAt: null,
	extraUsageAt: null,
};
const MODELS_TTL_MS = 60 * 60_000;
/** Raise when a provider's listing changes what it makes of the vendor's list (2: context and fast variants). */
const MODELS_VERSION = 2;
const MODELS_RETRY_MS = 5 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
const HOST_KEY = 'subscription-host';

const settingKey = (id: string) => `subscription.${id}`;

export const subscriptionProviders = (): SubscriptionProvider[] => getProviders().subscriptions ?? [];
export const agentRuntimes = (): AgentRuntime[] => getProviders().runtimes ?? [];
export const keyPlans = (): KeyPlan[] => getProviders().keyPlans ?? [];
export const gatewayAccount = (): GatewayAccount | null => getProviders().gatewayAccount ?? null;

export function gateways(): Gateway[] {
	const providers = getProviders();
	const openRouter = providers.gatewayAccount ? [{ account: providers.gatewayAccount, models: providers.models, key: openRouterKeySlot }] : [];
	return [...openRouter, ...(providers.gateways ?? [])];
}

const isGateway = (id: string): Gateway | undefined => gateways().find((gateway) => gateway.account.id === id);

/** Calls on a plan cost nothing per token. */
export const onPlan = (model: string): boolean =>
	[...subscriptionProviders(), ...agentRuntimes(), ...keyPlans()].some((plan) => model.startsWith(`${plan.gateway}/`));

export function planOf(model: string): { gateway: string; name: string } | null {
	const plan = [...subscriptionProviders(), ...agentRuntimes(), ...keyPlans()].find((candidate) => model.startsWith(`${candidate.gateway}/`));
	return plan ? { gateway: plan.gateway, name: plan.name } : null;
}

export const runtimeFor = (gateway: string): AgentRuntime | undefined => agentRuntimes().find((runtime) => runtime.gateway === gateway);

function providerById(id: string): SubscriptionProvider {
	const provider = subscriptionProviders().find((candidate) => candidate.id === id);
	if (!provider) {
		const runtime = agentRuntimes().find((candidate) => candidate.id === id);
		if (runtime) throw new ConflictError(`${runtime.name} signs in on the server through its own agent: ${runtime.signInCommand}`);
		const keyed = keyPlanById(id) ?? isGateway(id)?.account;
		if (keyed) throw new ConflictError(`${keyed.name} takes a key from ${keyed.keyPage} rather than a sign-in.`);
		throw new NotFoundError(`No subscription named "${id}"`);
	}
	return provider;
}

function keyPlanById(id: string): KeyPlan | undefined {
	return keyPlans().find((candidate) => candidate.id === id);
}

function runtimeById(id: string): AgentRuntime | undefined {
	return agentRuntimes().find((candidate) => candidate.id === id);
}

/** Read once and written through, so lookups while the agent renders stay cheap. */
const cache = new Map<string, Stored>();

async function stored(id: string): Promise<Stored> {
	const cached = cache.get(id);
	if (cached) return cached;
	const loaded = { ...DEFAULTS, ...(await getSetting<Partial<Stored>>(settingKey(id), {})) };
	cache.set(id, cache.get(id) ?? loaded);
	return cache.get(id)!;
}

async function save(id: string, patch: Partial<Stored>): Promise<Stored> {
	const next = { ...(await stored(id)), ...patch };
	cache.set(id, next);
	await setSetting(settingKey(id), next);
	announce({ kind: 'subscriptions' });
	return next;
}

async function hostId(): Promise<string> {
	const saved = await getSetting<string | null>(HOST_KEY, null);
	if (saved) return saved;
	const id = `urn:uuid:${randomUUID()}`;
	await setSetting(HOST_KEY, id);
	return id;
}

const renewing = new Map<string, Promise<string>>();

/** A refresh token that was revoked or used elsewhere never works again; a network failure might. */
const isRejected = (message: string) => /\((400|401)\)|invalid_grant/.test(message);

async function renew(provider: SubscriptionProvider, credential: SubscriptionCredential): Promise<string> {
	try {
		const next = await provider.refresh(credential);
		await save(provider.id, { credential: next, problem: null });
		return next.access;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isRejected(message)) await save(provider.id, { problem: `The ${provider.name} sign-in expired or was revoked. Sign in again in Settings › Subscriptions.` });
		throw new Error(`Could not renew the ${provider.name} sign-in: ${message}`);
	}
}

export async function accessToken(id: string): Promise<string> {
	const provider = providerById(id);
	const { credential, problem } = await stored(id);
	if (!credential) throw new Error(`${provider.name} is not signed in. Sign in under Settings › Subscriptions to use its models.`);
	if (credential.expiresAt > Date.now()) return credential.access;
	if (problem) throw new Error(problem);
	let pending = renewing.get(id);
	if (!pending) {
		pending = renew(provider, credential).finally(() => renewing.delete(id));
		renewing.set(id, pending);
	}
	return pending;
}

export function gatewayToken(gateway: string): Promise<string> {
	const provider = subscriptionProviders().find((candidate) => candidate.gateway === gateway);
	if (!provider) return Promise.reject(new Error(`No subscription serves "${gateway}" models`));
	return accessToken(provider.id);
}

const FREE: ModelInfo['price'] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A plan's call costs nothing per token unless its options count it at the API price toward the caps. */
export function priced(model: SubscriptionModel, plan: string, options: SubscriptionOptions): ModelInfo {
	const { listPrice, ...info } = model;
	return { ...info, price: options.countAtApiPrices && listPrice ? listPrice : FREE, subscription: plan };
}

const listing = new Map<string, Promise<SubscriptionModel[]>>();
const retryAt = new Map<string, number>();
const listedHere = new Set<string>();

/** `local`: listed on this server for nothing (Claude Code), so listed again after each start rather than trusting an older Anton's list. */
type Plan = { id: string; name: string; list: () => Promise<SubscriptionModel[]>; local?: boolean };

const oauthPlan = (provider: SubscriptionProvider): Plan => ({
	id: provider.id,
	name: provider.name,
	list: async () => provider.listModels(await accessToken(provider.id)),
});

const runtimePlan = (runtime: AgentRuntime): Plan => ({ id: runtime.id, name: runtime.name, list: () => runtime.listModels(), local: true });

const keyedPlan = (plan: KeyPlan): Plan => ({ id: plan.id, name: plan.name, list: async () => plan.listModels(await planKeyFor(plan)) });

async function listNow(plan: Plan): Promise<SubscriptionModel[]> {
	const models = await plan.list();
	await save(plan.id, { models, modelsAt: Date.now(), modelsVersion: MODELS_VERSION });
	retryAt.delete(plan.id);
	listedHere.add(plan.id);
	return models;
}

/** Relisted once an hour old or made by an older listing. A plan with a list serves it at once while the new one is made, so nothing waits on the vendor. */
function freshModels(provider: Plan, current: Stored): Promise<SubscriptionModel[]> {
	const fresh =
		current.modelsAt !== null &&
		Date.now() - current.modelsAt < MODELS_TTL_MS &&
		current.modelsVersion === MODELS_VERSION &&
		(!provider.local || listedHere.has(provider.id));
	if (fresh || (retryAt.get(provider.id) ?? 0) > Date.now()) return Promise.resolve(current.models);
	let pending = listing.get(provider.id);
	if (!pending) {
		pending = listNow(provider)
			.catch((error: unknown) => {
				logProblem('warn', `Could not list ${provider.name} models`, error);
				retryAt.set(provider.id, Date.now() + MODELS_RETRY_MS);
				return current.models;
			})
			.finally(() => listing.delete(provider.id));
		listing.set(provider.id, pending);
	}
	return current.models.length ? Promise.resolve(current.models) : pending;
}

const signedInHere = new Map<string, boolean>();

/** Right after a start, a plan that had models is taken as signed in while the program starts, so the first list does not wait for Claude Code. */
async function runtimeSignedIn(runtime: AgentRuntime, current: Stored): Promise<boolean> {
	const read = runtime.status().then(({ signedIn }) => {
		const before = signedInHere.get(runtime.id);
		signedInHere.set(runtime.id, signedIn);
		if (before === undefined && !signedIn && current.models.length) announce({ kind: 'models' });
		return signedIn;
	});
	if (signedInHere.has(runtime.id) || !current.models.length) return read;
	void read.catch(() => undefined);
	return true;
}

export async function subscriptionModels(): Promise<ModelInfo[]> {
	const lists = await Promise.all([
		...subscriptionProviders().map(async (provider) => {
			const current = await stored(provider.id);
			if (!current.enabled || !current.credential) return [];
			return (await freshModels(oauthPlan(provider), current)).map((model) => priced(model, provider.name, current));
		}),
		...agentRuntimes().map(async (runtime) => {
			const current = await stored(runtime.id);
			if (!current.enabled || !(await runtimeSignedIn(runtime, current))) return [];
			return (await freshModels(runtimePlan(runtime), current)).map((model) => priced(model, runtime.name, current));
		}),
		...keyPlans().map(async (plan) => {
			const current = await stored(plan.id);
			if (!current.enabled || !current.key) return [];
			return (await freshModels(keyedPlan(plan), current)).map((model) => priced(model, plan.name, current));
		}),
	]);
	return lists.flat();
}

async function planKeyFor(plan: KeyPlan): Promise<string> {
	const { key, problem } = await stored(plan.id);
	if (!key) throw new Error(`${plan.name} is not connected. Add its key under Settings › Subscriptions to use its models.`);
	if (problem) throw new Error(problem);
	return key;
}

export function planKey(gateway: string): Promise<string> {
	const plan = keyPlans().find((candidate) => candidate.gateway === gateway);
	if (!plan) return Promise.reject(new Error(`No subscription serves "${gateway}" models`));
	return planKeyFor(plan);
}

export async function planRuntime(gateway: string): Promise<Pick<AgentRuntime, 'open'> | undefined> {
	const runtime = runtimeFor(gateway);
	if (runtime) return runtime;
	const plan = keyPlans().find((candidate) => candidate.gateway === gateway);
	const open = plan?.open?.bind(plan);
	if (!plan || !open) return undefined;
	const key = await planKeyFor(plan);
	return { open: (options) => open(key, options) };
}

/** A key the vendor refuses is not kept. */
export async function connectKey(id: string, input: string): Promise<SubscriptionView> {
	const gateway = isGateway(id);
	if (gateway) return connectGatewayKey(gateway, input);
	const plan = keyPlanById(id);
	if (!plan) throw new NotFoundError(`No subscription named "${id}" takes a key`);
	const key = input.trim();
	if (!key || /\s/.test(key)) throw new InvalidInputError(`Paste the key from ${plan.keyPage} on its own.`);
	const { email } = await plan.check(key).catch((error: unknown) => {
		throw new InvalidInputError(`${plan.name} did not accept that key: ${error instanceof Error ? error.message : String(error)}`);
	});
	await save(plan.id, { key, account: email, connectedAt: new Date().toISOString(), problem: null, models: [], modelsAt: null, limitHitAt: null });
	windowsCache.delete(plan.id);
	retryAt.delete(plan.id);
	await listNow(keyedPlan(plan)).catch((error: unknown) => logProblem('warn', `Could not list ${plan.name} models`, error));
	return keyView(plan);
}

type Attempt = { login: SubscriptionLogin; startedAt: number; listening: boolean; close: () => void; finishing?: Promise<void> };

const attempts = new Map<string, Attempt>();

function endAttempt(id: string): void {
	attempts.get(id)?.close();
	attempts.delete(id);
}

type RuntimeAttempt = { signIn: RuntimeSignIn; startedAt: number; timer: NodeJS.Timeout; finishing?: Promise<void> };
const runtimeAttempts = new Map<string, RuntimeAttempt>();

function endRuntimeAttempt(id: string): void {
	const attempt = runtimeAttempts.get(id);
	if (!attempt) return;
	clearTimeout(attempt.timer);
	attempt.signIn.cancel();
	runtimeAttempts.delete(id);
}

async function beginRuntimeLogin(runtime: AgentRuntime): Promise<SubscriptionView> {
	if (!runtime.signIn) throw new ConflictError(`${runtime.name} signs in on the server: ${runtime.signInCommand}`);
	endRuntimeAttempt(runtime.id);
	const signIn = await runtime.signIn().catch((error: unknown) => {
		throw new ConflictError(`${runtime.name} could not start signing in: ${error instanceof Error ? error.message : String(error)}`);
	});
	const timer = setTimeout(() => {
		if (runtimeAttempts.get(runtime.id)?.signIn !== signIn) return;
		endRuntimeAttempt(runtime.id);
		announce({ kind: 'subscriptions' });
	}, LOGIN_TTL_MS);
	timer.unref();
	runtimeAttempts.set(runtime.id, { signIn, startedAt: Date.now(), timer });
	announce({ kind: 'subscriptions' });
	return runtimeView(runtime);
}

/** A wrong code ends Claude Code's sign-in, so a failed one starts over. */
async function finishRuntimeLogin(runtime: AgentRuntime, code: string): Promise<SubscriptionView> {
	const attempt = runtimeAttempts.get(runtime.id);
	if (!attempt) throw new ConflictError('No sign-in is waiting. Start one again.');
	attempt.finishing ??= attempt.signIn.complete(code).finally(() => {
		if (runtimeAttempts.get(runtime.id) === attempt) endRuntimeAttempt(runtime.id);
		announce({ kind: 'subscriptions' });
	});
	try {
		await attempt.finishing;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new InvalidInputError(`${message.replace(/\.$/, '')}. Sign in again for a new code.`);
	}
	return refreshSubscriptionModels(runtime.id);
}

const page = (title: string, detail: string) =>
	`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;margin:3rem;max-width:36rem"><h1 style="font-size:20px">${title}</h1><p>${detail
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')}</p></body>`;

/** Hosted, nothing reaches the loopback address and it is pasted instead. Null when the port is taken, such as by the Codex CLI. */
function catchCallback(redirectUri: string, finish: (url: string) => Promise<void>): Promise<(() => void) | null> {
	const target = new URL(redirectUri);
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', redirectUri);
		if (url.pathname !== target.pathname) {
			response.writeHead(404).end();
			return;
		}
		finish(url.toString()).then(
			() => response.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Connected to Anton', 'You can close this tab and go back to Anton.')),
			(error: unknown) =>
				response.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Not connected', error instanceof Error ? error.message : String(error))),
		);
	});
	return new Promise((resolve) => {
		server.once('error', () => resolve(null));
		server.listen(Number(target.port), target.hostname, () =>
			resolve(() => {
				// Idle ones only, so the page answering this return still reaches the browser; browsers
				// keep spare connections open, and one could carry a later sign-in's return here.
				server.close();
				server.closeIdleConnections();
			}),
		);
	});
}

export async function beginLogin(id: string): Promise<SubscriptionView> {
	const runtime = runtimeById(id);
	if (runtime) return beginRuntimeLogin(runtime);
	const provider = providerById(id);
	endAttempt(id);
	const previous = (await stored(id)).credential;
	const login = provider.startLogin(await hostId(), previous ? { clientId: previous.clientId, email: previous.email } : undefined);
	const attempt: Attempt = { login, startedAt: Date.now(), listening: false, close: () => {} };
	attempts.set(id, attempt);
	const close = await catchCallback(login.redirectUri, (url) => finishLogin(id, url).then(() => undefined));
	const timer = setTimeout(() => attempts.get(id) === attempt && (endAttempt(id), announce({ kind: 'subscriptions' })), LOGIN_TTL_MS);
	timer.unref();
	attempt.listening = close !== null;
	attempt.close = () => {
		clearTimeout(timer);
		close?.();
	};
	announce({ kind: 'subscriptions' });
	return subscriptionView(provider);
}

export async function cancelLogin(id: string): Promise<SubscriptionView> {
	const runtime = runtimeById(id);
	if (runtime) {
		endRuntimeAttempt(id);
		announce({ kind: 'subscriptions' });
		return runtimeView(runtime);
	}
	const provider = providerById(id);
	endAttempt(id);
	announce({ kind: 'subscriptions' });
	return subscriptionView(provider);
}

async function connect(provider: SubscriptionProvider, credential: SubscriptionCredential): Promise<void> {
	await save(provider.id, { credential, connectedAt: new Date().toISOString(), problem: null, models: [], modelsAt: null });
	retryAt.delete(provider.id);
	await listNow(oauthPlan(provider)).catch((error: unknown) => logProblem('warn', `Could not list ${provider.name} models`, error));
}

export async function finishLogin(id: string, callbackUrl: string): Promise<SubscriptionView> {
	const runtime = runtimeById(id);
	if (runtime) return finishRuntimeLogin(runtime, callbackUrl);
	const provider = providerById(id);
	const attempt = attempts.get(id);
	if (!attempt) throw new ConflictError('No sign-in is waiting. Start one again.');
	// The loopback catch and a paste can race; both wait on the first.
	attempt.finishing ??= attempt.login
		.complete(callbackUrl)
		.then(async (credential) => {
			if (attempts.get(id) === attempt) endAttempt(id);
			await connect(provider, credential);
		})
		.catch((error: unknown) => {
			attempt.finishing = undefined;
			throw error instanceof Error ? new InvalidInputError(error.message) : error;
		});
	await attempt.finishing;
	return subscriptionView(provider);
}

type Imported = { access?: unknown; access_token?: unknown; refresh?: unknown; refresh_token?: unknown; clientId?: unknown; client_id?: unknown; scopes?: unknown; email?: unknown };

const text = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && value.length > 0);

/** As pi writes it to auth.json (a whole file, or the one entry) or as OpenAI's guide for self-hosted machines saves it. */
export function parseImported(input: string): Pick<SubscriptionCredential, 'refresh' | 'clientId' | 'access' | 'scopes' | 'email'> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		throw new InvalidInputError('Paste the sign-in as JSON, such as the contents of pi’s auth.json.');
	}
	const candidates = [parsed, ...(parsed && typeof parsed === 'object' ? Object.values(parsed) : [])] as Imported[];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== 'object') continue;
		const refresh = text(candidate.refresh, candidate.refresh_token);
		const clientId = text(candidate.clientId, candidate.client_id);
		if (refresh && clientId) {
			const scopes = Array.isArray(candidate.scopes) ? candidate.scopes.filter((scope) => typeof scope === 'string') : [];
			return { refresh, clientId, access: text(candidate.access, candidate.access_token) ?? '', scopes, email: text(candidate.email) ?? null };
		}
	}
	throw new InvalidInputError('That sign-in has no refresh token and client id. Sign in with ChatGPT on the other computer first.');
}

/** The refresh token rotates, so renewing it at once checks it and makes Anton its owner; the old copy stops working. */
export async function importLogin(id: string, input: string): Promise<SubscriptionView> {
	const provider = providerById(id);
	const imported = parseImported(input);
	const credential = await provider.refresh({ ...imported, expiresAt: 0 }).catch((error: unknown) => {
		throw new InvalidInputError(`${provider.name} did not accept that sign-in: ${error instanceof Error ? error.message : String(error)}`);
	});
	endAttempt(id);
	await connect(provider, credential);
	return subscriptionView(provider);
}

/** The vendor keeps Anton listed until you remove it there. */
export async function disconnect(id: string): Promise<SubscriptionView> {
	const runtime = runtimeById(id);
	if (runtime) {
		if (!runtime.signOut) throw new ConflictError(`${runtime.name} keeps its own sign-in. Sign out on the server with: ${runtime.signInCommand.replace(/ login$/, ' logout')}`);
		endRuntimeAttempt(id);
		await runtime.signOut().catch((error: unknown) => {
			throw new ConflictError(`${runtime.name} could not sign out: ${error instanceof Error ? error.message : String(error)}`);
		});
		await save(id, { models: [], modelsAt: null });
		announce({ kind: 'models' });
		return refreshSubscriptionModels(id);
	}
	const keyed = keyPlanById(id);
	if (keyed) {
		// The key itself stays valid until you delete it on the vendor's dashboard.
		await save(id, { key: null, account: null, connectedAt: null, models: [], modelsAt: null, problem: null });
		windowsCache.delete(id);
		return keyView(keyed);
	}
	const gateway = isGateway(id);
	if (gateway) {
		// The server's own key, if it has one, takes over again.
		await save(id, { key: null, account: null, connectedAt: null, problem: null });
		gateway.key.set(null);
		windowsCache.delete(id);
		return gatewayView(gateway);
	}
	const provider = providerById(id);
	endAttempt(id);
	await save(id, { credential: null, connectedAt: null, models: [], modelsAt: null, problem: null });
	return subscriptionView(provider);
}

export async function setSubscriptionOptions(id: string, options: SubscriptionOptions): Promise<SubscriptionView> {
	const runtime = runtimeById(id);
	if (runtime) {
		await save(id, options);
		return runtimeView(runtime);
	}
	const keyed = keyPlanById(id);
	if (keyed) {
		await save(id, options);
		return keyView(keyed);
	}
	const gateway = isGateway(id);
	if (gateway) {
		await save(id, options);
		return gatewayView(gateway);
	}
	const provider = providerById(id);
	await save(id, options);
	return subscriptionView(provider);
}

/** An empty client id removes the client. A sign-in already waiting started on the old client, so it ends. */
export async function setRuntimeClient(id: string, input: { clientId: string; clientSecret: string }): Promise<SubscriptionView> {
	const runtime = runtimeById(id);
	if (!runtime?.oauthClient) throw new NotFoundError(`${runtime?.name ?? id} has no OAuth client to set`);
	const clientId = input.clientId.trim();
	const clientSecret = input.clientSecret.trim();
	if (clientId && !clientSecret) throw new InvalidInputError('Paste the client secret too');
	await runtime.oauthClient.set(clientId ? { clientId, clientSecret } : null);
	endRuntimeAttempt(runtime.id);
	announce({ kind: 'subscriptions' });
	return runtimeView(runtime);
}

/** For a runtime its sign-in is read again first, so a sign-in on the server shows at once. */
export async function refreshSubscriptionModels(id: string): Promise<SubscriptionView> {
	const runtime = runtimeById(id);
	if (runtime) {
		const status = await runtime.status(true);
		if (!status.signedIn) {
			await save(id, { models: [], modelsAt: null });
			return runtimeView(runtime);
		}
		await listNow(runtimePlan(runtime));
		return runtimeView(runtime);
	}
	const keyed = keyPlanById(id);
	if (keyed) {
		if (!(await stored(id)).key) throw new ConflictError(`${keyed.name} is not connected.`);
		windowsCache.delete(id);
		await listNow(keyedPlan(keyed));
		return keyView(keyed);
	}
	const gateway = isGateway(id);
	if (gateway) {
		windowsCache.delete(id);
		await gateway.models.list(true);
		await save(id, { modelsAt: Date.now() });
		return gatewayView(gateway);
	}
	const provider = providerById(id);
	if (!(await stored(id)).credential) throw new ConflictError(`${provider.name} is not signed in.`);
	await listNow(oauthPlan(provider));
	return subscriptionView(provider);
}

export async function notePlanLimit(id: string): Promise<void> {
	await save(id, { limitHitAt: new Date().toISOString() });
}

export async function noteExtraUsage(id: string): Promise<void> {
	const current = await stored(id);
	// A runtime says so on each call while it lasts; one note an hour is enough.
	if (current.extraUsageAt && Date.now() - new Date(current.extraUsageAt).getTime() < 60 * 60_000) return;
	const name = [...agentRuntimes(), ...keyPlans()].find((plan) => plan.id === id)?.name ?? 'The plan';
	logProblem('warn', `${name} says the plan is now using paid extra usage`, null);
	await save(id, { extraUsageAt: new Date().toISOString() });
}

export function runtimeHooks(gateway: string): { onLimit(): void; onExtraUsage(): void; maxOpen: number } {
	const id = () => runtimeFor(gateway)?.id ?? keyPlans().find((plan) => plan.gateway === gateway)?.id;
	const report = (note: (id: string) => Promise<void>) => () => {
		const plan = id();
		if (plan) note(plan).catch((error: unknown) => logProblem('warn', 'Could not note the plan usage', error));
	};
	return { onLimit: report(notePlanLimit), onExtraUsage: report(noteExtraUsage), maxOpen: config.claudeCode.maxOpen };
}

function startOfMonth(now = new Date()): Date {
	return new Date(now.getFullYear(), now.getMonth(), 1);
}

export async function subscriptionView(provider: SubscriptionProvider): Promise<SubscriptionView> {
	const current = await stored(provider.id);
	const attempt = attempts.get(provider.id);
	const models = await withTokens(current.models);
	return {
		id: provider.id,
		name: provider.name,
		kind: 'oauth',
		gateway: provider.gateway,
		state: !current.credential ? 'signed-out' : current.problem ? 'expired' : 'connected',
		email: current.credential?.email ?? null,
		connectedAt: current.connectedAt,
		problem: current.problem,
		expiresAt: current.credential ? new Date(current.credential.expiresAt).toISOString() : null,
		options: { enabled: current.enabled, countAtApiPrices: current.countAtApiPrices },
		models,
		monthTokens: models.reduce((sum, model) => sum + model.tokens, 0),
		modelsAt: current.modelsAt === null ? null : new Date(current.modelsAt).toISOString(),
		login: attempt
			? { url: attempt.login.url, redirectUri: attempt.login.redirectUri, listening: attempt.listening, startedAt: new Date(attempt.startedAt).toISOString() }
			: null,
		plan: null,
		version: null,
		signIn: null,
		limitHitAt: current.limitHitAt,
		extraUsageAt: current.extraUsageAt,
		keyPage: null,
		keyHint: null,
		windows: null,
	};
}

async function withTokens(models: SubscriptionModel[]): Promise<SubscriptionView['models']> {
	// Usage is logged under `<gateway>/<model>`, the way tasks name the plan's models.
	const spent = models.length ? await spendBy('model', startOfMonth()).catch(() => []) : [];
	const tokensOf = (id: string) => spent.find((row) => row.key === id)?.tokens ?? 0;
	return models
		.filter((model) => !model.variant)
		.map(({ id, name, contextLength, vision, reasoning, defaultReasoning }) => {
			const variants = models.filter((model) => model.variant?.of === id);
			const contexts = [...new Set(variants.flatMap((model) => (model.variant?.context ? [model.variant.context.toUpperCase()] : [])))];
			return {
				id,
				name,
				contextLength,
				vision,
				reasoning,
				defaultReasoning,
				tokens: tokensOf(id) + variants.reduce((sum, model) => sum + tokensOf(model.id), 0),
				options: [...contexts, ...(variants.some((model) => model.variant?.fast) ? ['Fast'] : [])],
			};
		});
}

export async function runtimeView(runtime: AgentRuntime): Promise<SubscriptionView> {
	const [current, status] = await Promise.all([stored(runtime.id), runtime.status()]);
	const attempt = runtimeAttempts.get(runtime.id);
	const [models, windows] = status.signedIn
		? await Promise.all([withTokens(await freshModels(runtimePlan(runtime), current)), runtime.windows?.() ?? Promise.resolve(null)])
		: [[], null];
	return {
		id: runtime.id,
		name: runtime.name,
		kind: 'runtime',
		gateway: runtime.gateway,
		state: status.signedIn ? 'connected' : status.problem ? 'expired' : 'signed-out',
		email: status.email,
		connectedAt: null,
		problem: status.problem,
		expiresAt: null,
		options: { enabled: current.enabled, countAtApiPrices: current.countAtApiPrices },
		models,
		monthTokens: models.reduce((sum, model) => sum + model.tokens, 0),
		modelsAt: current.modelsAt === null ? null : new Date(current.modelsAt).toISOString(),
		login: attempt
			? { url: attempt.signIn.url, redirectUri: new URL(attempt.signIn.url).searchParams.get('redirect_uri') ?? '', listening: false, startedAt: new Date(attempt.startedAt).toISOString() }
			: null,
		plan: status.plan,
		version: status.version,
		signIn: runtime.signInCommand,
		limitHitAt: current.limitHitAt,
		extraUsageAt: current.extraUsageAt,
		keyPage: null,
		keyHint: null,
		windows,
		isolation: runtime.isolation ? await runtime.isolation().catch(() => null) : null,
		oauthClient: runtime.oauthClient ? ((await runtime.oauthClient.get()) ?? { clientId: '', clientSecret: '' }) : null,
	};
}

const WINDOWS_TTL_MS = 60_000;
const windowsCache = new Map<string, { at: number; windows: Promise<PlanWindow[] | null> }>();

function planWindows(plan: Pick<KeyPlan, 'id' | 'name' | 'windows'>, key: string): Promise<PlanWindow[] | null> {
	const read = plan.windows?.bind(plan);
	if (!read) return Promise.resolve(null);
	const cached = windowsCache.get(plan.id);
	if (cached && Date.now() - cached.at < WINDOWS_TTL_MS) return cached.windows;
	const windows = read(key).catch((error: unknown) => {
		logProblem('warn', `Could not read the ${plan.name} plan's limits`, error);
		return null;
	});
	windowsCache.set(plan.id, { at: Date.now(), windows });
	return windows;
}

export async function keyView(plan: KeyPlan): Promise<SubscriptionView> {
	const current = await stored(plan.id);
	const connected = Boolean(current.key);
	const [models, windows] = await Promise.all([
		connected && current.enabled ? withTokens(await freshModels(keyedPlan(plan), current)) : withTokens(current.models),
		connected && !current.problem ? planWindows(plan, current.key!) : Promise.resolve(null),
	]);
	return {
		id: plan.id,
		name: plan.name,
		kind: 'key',
		gateway: plan.gateway,
		state: !connected ? 'signed-out' : current.problem ? 'expired' : 'connected',
		email: current.account,
		connectedAt: current.connectedAt,
		problem: current.problem,
		expiresAt: null,
		options: { enabled: current.enabled, countAtApiPrices: current.countAtApiPrices },
		models,
		monthTokens: models.reduce((sum, model) => sum + model.tokens, 0),
		modelsAt: current.modelsAt === null ? null : new Date(current.modelsAt).toISOString(),
		login: null,
		plan: null,
		version: null,
		signIn: null,
		limitHitAt: current.limitHitAt,
		extraUsageAt: current.extraUsageAt,
		keyPage: plan.keyPage,
		keyHint: current.key ? current.key.slice(-4) : null,
		windows,
	};
}

async function gatewayStored(gateway: Gateway): Promise<Stored> {
	const current = await stored(gateway.account.id);
	gateway.key.set(current.key);
	return current;
}

export async function plansSignedIn(): Promise<string[]> {
	const names: string[] = [];
	for (const provider of subscriptionProviders()) if ((await stored(provider.id)).credential) names.push(provider.name);
	for (const plan of keyPlans()) if ((await stored(plan.id)).key) names.push(plan.name);
	for (const runtime of agentRuntimes()) if ((await runtime.status().catch(() => null))?.signedIn) names.push(runtime.name);
	return names;
}

/** Without OpenRouter's port its catalog is offered as it is. */
export async function gatewayOffered(id = 'openrouter'): Promise<boolean> {
	const gateway = isGateway(id);
	if (!gateway) return id === 'openrouter' && !gatewayAccount();
	const current = await gatewayStored(gateway);
	return current.enabled && gateway.key.source() !== null;
}

/** At startup, so the decision and vision models have OpenRouter's before any call. */
export async function loadGatewayKey(): Promise<void> {
	await Promise.all(gateways().map(gatewayStored));
}

export async function gatewayKey(): Promise<string | null> {
	await loadGatewayKey();
	return openRouterKey();
}

export async function gatewayKeyOf(id: string): Promise<string | null> {
	const gateway = isGateway(id);
	if (!gateway) return null;
	await gatewayStored(gateway);
	return gateway.key.get();
}

async function connectGatewayKey(gateway: Gateway, input: string): Promise<SubscriptionView> {
	const { account } = gateway;
	const key = input.trim();
	if (!key || /\s/.test(key)) throw new InvalidInputError(`Paste the key from ${account.keyPage} on its own.`);
	const { email } = await account.check(key).catch((error: unknown) => {
		throw new InvalidInputError(`${account.name} did not accept that key: ${error instanceof Error ? error.message : String(error)}`);
	});
	await save(account.id, { key, account: email, connectedAt: new Date().toISOString(), problem: null, limitHitAt: null });
	gateway.key.set(key);
	windowsCache.delete(account.id);
	await gateway.models
		.list(true)
		.then(() => save(account.id, { modelsAt: Date.now() }))
		.catch((error: unknown) => logProblem('warn', `Could not list ${account.name} models`, error));
	return gatewayView(gateway);
}

async function gatewayModels(models: ModelInfo[]): Promise<SubscriptionView['models']> {
	const spent = models.length ? await spendBy('model', startOfMonth()).catch(() => []) : [];
	const tokensOf = new Map(spent.map((row) => [row.key, row.tokens]));
	return models.map(({ id, name, vendor, contextLength, vision, reasoning, defaultReasoning, price }) => ({
		id,
		name,
		vendor,
		contextLength,
		vision,
		reasoning,
		defaultReasoning,
		tokens: tokensOf.get(id) ?? 0,
		options: [],
		price: { input: price.input, output: price.output },
	}));
}

export async function gatewayView(gateway: Gateway): Promise<SubscriptionView> {
	const { account } = gateway;
	const current = await gatewayStored(gateway);
	const source = gateway.key.source();
	const key = gateway.key.get();
	const [listed, windows] = key
		? await Promise.all([
				gateway.models.list().catch((error: unknown) => {
					logProblem('warn', `Could not list ${account.name} models`, error);
					return [] as ModelInfo[];
				}),
				planWindows(account, key),
			])
		: [[], null];
	const models = await gatewayModels(listed.filter((model) => model.id.startsWith(`${account.gateway}/`)));
	return {
		id: account.id,
		name: account.name,
		kind: 'gateway',
		gateway: account.gateway,
		state: source ? 'connected' : 'signed-out',
		email: current.key ? current.account : null,
		connectedAt: current.key ? current.connectedAt : null,
		problem: null,
		expiresAt: null,
		options: { enabled: current.enabled, countAtApiPrices: true },
		models,
		monthTokens: models.reduce((sum, model) => sum + model.tokens, 0),
		modelsAt: current.modelsAt === null ? null : new Date(current.modelsAt).toISOString(),
		login: null,
		plan: null,
		version: null,
		signIn: null,
		limitHitAt: null,
		extraUsageAt: null,
		keyPage: account.keyPage,
		keyHint: key ? key.slice(-4) : null,
		windows,
		keySource: source,
		envVar: account.envVar,
	};
}

export const subscriptionsView = async (): Promise<SubscriptionView[]> => [
	...(await Promise.all(subscriptionProviders().map(subscriptionView))),
	...(await Promise.all(agentRuntimes().map(runtimeView))),
	...(await Promise.all(keyPlans().map(keyView))),
	...(await Promise.all(gateways().map(gatewayView))),
];

/** OpenAI's Sign in with ChatGPT. */
const LIMIT_CODES = ['subscription_sharing_usage_limit_exceeded', 'usage_limit_reached', 'usage_limit_exceeded'];

type TurnEvent = { type: string; request?: { providerId?: string }; response?: unknown; isError?: boolean };

export async function recordPlanLimit(event: TurnEvent): Promise<void> {
	if (event.type !== 'turn' || !event.request?.providerId) return;
	const provider = subscriptionProviders().find((candidate) => candidate.gateway === event.request?.providerId);
	if (!provider || !(await stored(provider.id)).credential) return;
	const text = JSON.stringify(event.response ?? '');
	if (LIMIT_CODES.some((code) => text.includes(code))) await save(provider.id, { limitHitAt: new Date().toISOString() });
}

const USAGE_PAGES: Record<string, string> = {
	chatgpt: 'https://chatgpt.com/settings/usage',
	claude: 'https://claude.ai/settings/usage',
	'opencode-go': 'https://opencode.ai/auth',
	cursor: 'https://cursor.com/dashboard/usage',
};

export type PlanUsage = {
	id: string;
	name: string;
	gateway: string;
	connected: boolean;
	tokens: { today: number; week: number; month: number };
	calls: number;
	/** At the vendor's list price, else OpenRouter's for the same model; cached input at the cached price where one is listed. Null when no price is known. */
	apiValue: number | null;
	daily: Array<{ day: string; model: string; tokens: number }>;
	limitHitAt: string | null;
	usagePage: string | null;
};

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export async function planUsage(now = new Date()): Promise<PlanUsage[]> {
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
	const weekStart = new Date(midnight);
	weekStart.setDate(weekStart.getDate() - 6);
	const thirty = new Date(midnight);
	thirty.setDate(thirty.getDate() - 29);
	const since = thirty < monthStart ? thirty : monthStart;
	const plans = [
		...subscriptionProviders().map((provider) => ({ ...provider, connected: async (current: Stored) => current.credential !== null && !current.problem })),
		...agentRuntimes().map((runtime) => ({ ...runtime, connected: async () => (await runtime.status()).signedIn })),
		...keyPlans().map((plan) => ({ ...plan, connected: async (current: Stored) => current.key !== null && !current.problem })),
	];
	return Promise.all(
		plans.map(async (provider) => {
			const current = await stored(provider.id);
			const rows = await tokensByMinute(`${provider.gateway}/`, since).catch(() => []);
			// The vendor's own list price, else what OpenRouter lists the same model at.
			const routed = await getProviders()
				.models.list()
				.catch(() => []);
			const priceOf = (id: string) =>
				current.models.find((model) => model.id === id)?.listPrice ?? routed.find((model) => model.id === `openrouter/${id}`)?.price ?? null;
			let priced = false;
			const tokens = { today: 0, week: 0, month: 0 };
			let calls = 0;
			let apiValue = 0;
			const daily = new Map<string, { day: string; model: string; tokens: number }>();
			for (const row of rows) {
				const at = new Date(`${row.minute}:00Z`);
				const total = row.input + row.output;
				if (at >= midnight) tokens.today += total;
				if (at >= weekStart) tokens.week += total;
				if (at >= monthStart) {
					tokens.month += total;
					calls += row.calls;
					const price = priceOf(row.model);
					if (price) {
						priced = true;
						// Cached input is billed at its own, lower price; without one listed it counts at the input price.
						const cachedPrice = price.cacheRead > 0 ? price.cacheRead : price.input;
						apiValue += ((row.input - row.cached) * price.input + row.cached * cachedPrice + row.output * price.output) / 1_000_000;
					}
				}
				if (at >= thirty) {
					const key = `${localDay(at)} ${row.model}`;
					const entry = daily.get(key) ?? { day: localDay(at), model: row.model, tokens: 0 };
					entry.tokens += total;
					daily.set(key, entry);
				}
			}
			return {
				id: provider.id,
				name: provider.name,
				gateway: provider.gateway,
				connected: await provider.connected(current),
				tokens,
				calls,
				apiValue: priced || tokens.month === 0 ? apiValue : null,
				daily: [...daily.values()],
				limitHitAt: current.limitHitAt,
				usagePage: USAGE_PAGES[provider.id] ?? null,
			};
		}),
	);
}

export function resetSubscriptionsForTests(): void {
	for (const id of attempts.keys()) endAttempt(id);
	cache.clear();
	retryAt.clear();
	listedHere.clear();
	signedInHere.clear();
	windowsCache.clear();
	openRouterKeySlot.set(null);
	vercelKeySlot.set(null);
}

export async function listingsSettledForTests(): Promise<void> {
	await Promise.all(listing.values());
}
