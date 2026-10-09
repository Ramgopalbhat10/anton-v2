import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { announce } from '../core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { ModelInfo, SubscriptionCredential, SubscriptionLogin, SubscriptionModel, SubscriptionProvider } from '../core/ports.ts';
import { spendBy, tokensByMinute } from '../db/sessions.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getProviders } from '../providers/index.ts';
import { logProblem } from './log.ts';

/**
 * Plans you already pay for (a ChatGPT plan), signed in to from Settings ›
 * Subscriptions. Their models join the model picker, and their calls bill the
 * plan rather than per token. Anton keeps each sign-in and renews its token;
 * the agents ask for a fresh one on every call.
 */

/** `enabled` offers the plan's models in the picker; `countAtApiPrices` counts their calls toward the spending caps as if billed per token. */
export type SubscriptionOptions = { enabled: boolean; countAtApiPrices: boolean };

type Stored = SubscriptionOptions & {
	credential: SubscriptionCredential | null;
	connectedAt: string | null;
	/** The account's models as last listed, kept when the vendor does not answer. */
	models: SubscriptionModel[];
	modelsAt: number | null;
	/** Why the plan cannot be used now, such as a sign-in that was revoked. */
	problem: string | null;
	/** When the vendor last said the plan's usage limit was reached. */
	limitHitAt: string | null;
};

export type SubscriptionView = {
	id: string;
	name: string;
	/** The `<gateway>` its models are named under. */
	gateway: string;
	state: 'connected' | 'expired' | 'signed-out';
	email: string | null;
	connectedAt: string | null;
	problem: string | null;
	/** When the current access token lapses; Anton renews it a few minutes before. */
	expiresAt: string | null;
	options: SubscriptionOptions;
	/** The account's models, each with the tokens it used on the plan this month. */
	models: Array<Pick<ModelInfo, 'id' | 'name' | 'contextLength' | 'vision' | 'reasoning' | 'defaultReasoning'> & { tokens: number }>;
	/** Tokens all of the plan's models used since the start of this month. */
	monthTokens: number;
	modelsAt: string | null;
	/** A sign-in waiting for the address the browser is sent back to; `listening` when Anton can catch it itself. */
	login: { url: string; redirectUri: string; listening: boolean; startedAt: string } | null;
};

const DEFAULTS: Stored = { enabled: true, countAtApiPrices: false, credential: null, connectedAt: null, models: [], modelsAt: null, problem: null, limitHitAt: null };
const MODELS_TTL_MS = 60 * 60_000;
/** After a failed listing, how long the last list is served before asking again. */
const MODELS_RETRY_MS = 5 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
const HOST_KEY = 'subscription-host';

const settingKey = (id: string) => `subscription.${id}`;

export const subscriptionProviders = (): SubscriptionProvider[] => getProviders().subscriptions ?? [];

function providerById(id: string): SubscriptionProvider {
	const provider = subscriptionProviders().find((candidate) => candidate.id === id);
	if (!provider) throw new NotFoundError(`No subscription named "${id}"`);
	return provider;
}

/** Each plan's stored state, read once and written through, so lookups while the agent renders stay cheap. */
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

/** Names this Anton install to the vendor (`ext_agent_host_id`); made once and kept. */
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

/** A working access token for the plan, renewed when it is about to expire; concurrent calls share one renewal. */
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

/** The token for the plan whose models are named under `gateway`, for the agents' model calls. */
export function gatewayToken(gateway: string): Promise<string> {
	const provider = subscriptionProviders().find((candidate) => candidate.gateway === gateway);
	if (!provider) return Promise.reject(new Error(`No subscription serves "${gateway}" models`));
	return accessToken(provider.id);
}

const FREE: ModelInfo['price'] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A plan's call costs nothing per token, unless its options count it at the vendor's API price toward the caps. */
export function priced(model: SubscriptionModel, plan: string, options: SubscriptionOptions): ModelInfo {
	const { listPrice, ...info } = model;
	return { ...info, price: options.countAtApiPrices && listPrice ? listPrice : FREE, subscription: plan };
}

const listing = new Map<string, Promise<SubscriptionModel[]>>();
const retryAt = new Map<string, number>();

async function listNow(provider: SubscriptionProvider): Promise<SubscriptionModel[]> {
	const models = await provider.listModels(await accessToken(provider.id));
	await save(provider.id, { models, modelsAt: Date.now() });
	retryAt.delete(provider.id);
	return models;
}

/** The account's models, listed again once the last list is an hour old; a failure serves the last list for a while. */
async function freshModels(provider: SubscriptionProvider, current: Stored): Promise<SubscriptionModel[]> {
	const fresh = current.modelsAt !== null && Date.now() - current.modelsAt < MODELS_TTL_MS;
	if (fresh || (retryAt.get(provider.id) ?? 0) > Date.now()) return current.models;
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
	return pending;
}

/** Every signed-in plan's models that are switched on, for the model picker and the agents. */
export async function subscriptionModels(): Promise<ModelInfo[]> {
	const lists = await Promise.all(
		subscriptionProviders().map(async (provider) => {
			const current = await stored(provider.id);
			if (!current.enabled || !current.credential) return [];
			return (await freshModels(provider, current)).map((model) => priced(model, provider.name, current));
		}),
	);
	return lists.flat();
}

type Attempt = { login: SubscriptionLogin; startedAt: number; listening: boolean; close: () => void; finishing?: Promise<void> };

/** One sign-in at a time per plan, held only in memory: a restart means starting again. */
const attempts = new Map<string, Attempt>();

function endAttempt(id: string): void {
	attempts.get(id)?.close();
	attempts.delete(id);
}

const page = (title: string, detail: string) =>
	`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;margin:3rem;max-width:36rem"><h1 style="font-size:20px">${title}</h1><p>${detail
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')}</p></body>`;

/**
 * Catches the browser's return on the loopback address when Anton runs on the
 * same computer as the browser. Hosted, nothing reaches it, and the address is
 * pasted instead. Null when the port is taken, such as by the Codex CLI.
 */
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
	const provider = providerById(id);
	endAttempt(id);
	announce({ kind: 'subscriptions' });
	return subscriptionView(provider);
}

async function connect(provider: SubscriptionProvider, credential: SubscriptionCredential): Promise<void> {
	await save(provider.id, { credential, connectedAt: new Date().toISOString(), problem: null, models: [], modelsAt: null });
	retryAt.delete(provider.id);
	await listNow(provider).catch((error: unknown) => logProblem('warn', `Could not list ${provider.name} models`, error));
}

/** Finishes a sign-in with the address the browser was sent back to, pasted or caught on the loopback address. */
export async function finishLogin(id: string, callbackUrl: string): Promise<SubscriptionView> {
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

/**
 * A sign-in made on another computer, as pi writes it to auth.json (a whole
 * file, or the one entry) or as OpenAI's guide for self-hosted machines saves it.
 */
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

/**
 * Takes over a sign-in made elsewhere: renewing it at once checks it and makes
 * Anton its owner, since the refresh token rotates and the old copy stops working.
 */
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

/** Forgets the sign-in here; the vendor keeps Anton listed until you remove it there. */
export async function disconnect(id: string): Promise<SubscriptionView> {
	const provider = providerById(id);
	endAttempt(id);
	await save(id, { credential: null, connectedAt: null, models: [], modelsAt: null, problem: null });
	return subscriptionView(provider);
}

export async function setSubscriptionOptions(id: string, options: SubscriptionOptions): Promise<SubscriptionView> {
	const provider = providerById(id);
	await save(id, options);
	return subscriptionView(provider);
}

export async function refreshSubscriptionModels(id: string): Promise<SubscriptionView> {
	const provider = providerById(id);
	if (!(await stored(id)).credential) throw new ConflictError(`${provider.name} is not signed in.`);
	await listNow(provider);
	return subscriptionView(provider);
}

function startOfMonth(now = new Date()): Date {
	return new Date(now.getFullYear(), now.getMonth(), 1);
}

export async function subscriptionView(provider: SubscriptionProvider): Promise<SubscriptionView> {
	const current = await stored(provider.id);
	const attempt = attempts.get(provider.id);
	// Usage is logged under `<gateway>/<model>`, the way tasks name the plan's models.
	const spent = current.models.length ? await spendBy('model', startOfMonth()).catch(() => []) : [];
	const tokensOf = (id: string) => spent.find((row) => row.key === id)?.tokens ?? 0;
	const models = current.models.map(({ id, name, contextLength, vision, reasoning, defaultReasoning }) => ({
		id,
		name,
		contextLength,
		vision,
		reasoning,
		defaultReasoning,
		tokens: tokensOf(id),
	}));
	return {
		id: provider.id,
		name: provider.name,
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
	};
}

export const subscriptionsView = (): Promise<SubscriptionView[]> => Promise.all(subscriptionProviders().map(subscriptionView));

/** What the vendor calls a plan whose usage limit is reached (OpenAI's Sign in with ChatGPT). */
const LIMIT_CODES = ['subscription_sharing_usage_limit_exceeded', 'usage_limit_reached', 'usage_limit_exceeded'];

/** The fields Anton reads from a runtime `turn` event. */
type TurnEvent = { type: string; request?: { providerId?: string }; response?: unknown; isError?: boolean };

/** Notes when a plan's model call failed because the plan's usage limit was reached, for the usage views. */
export async function recordPlanLimit(event: TurnEvent): Promise<void> {
	if (event.type !== 'turn' || !event.request?.providerId) return;
	const provider = subscriptionProviders().find((candidate) => candidate.gateway === event.request?.providerId);
	if (!provider || !(await stored(provider.id)).credential) return;
	const text = JSON.stringify(event.response ?? '');
	if (LIMIT_CODES.some((code) => text.includes(code))) await save(provider.id, { limitHitAt: new Date().toISOString() });
}

/** Where each vendor shows the plan's own limits and what is left of them. */
const USAGE_PAGES: Record<string, string> = { chatgpt: 'https://chatgpt.com/settings/usage' };

/**
 * A plan's use as Anton saw it: tokens and calls on its models, and what the
 * same calls would have cost at the vendor's API list prices. The vendor
 * does not tell apps how much of the plan is left, so that is not here.
 */
export type PlanUsage = {
	id: string;
	name: string;
	gateway: string;
	connected: boolean;
	tokens: { today: number; week: number; month: number };
	calls: number;
	/**
	 * US dollars the month's calls would have cost per token, at the vendor's list price or, failing that,
	 * OpenRouter's for the same model; input counted at the input price, cache reads included. Null when no price is known.
	 */
	apiValue: number | null;
	/** Tokens per local day and model over the last 30 days; days with none are left out. */
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
	return Promise.all(
		subscriptionProviders().map(async (provider) => {
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
						apiValue += (row.input * price.input + row.output * price.output) / 1_000_000;
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
				connected: current.credential !== null && !current.problem,
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

/** Tests start each case from nothing stored. */
export function resetSubscriptionsForTests(): void {
	for (const id of attempts.keys()) endAttempt(id);
	cache.clear();
	retryAt.clear();
}
