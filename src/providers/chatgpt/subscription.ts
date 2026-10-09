import { createHash, randomBytes } from 'node:crypto';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { REASONING_LEVELS, type Reasoning, type SubscriptionCredential, type SubscriptionModel, type SubscriptionProvider } from '../../core/ports.ts';

/**
 * Sign in with ChatGPT's token sharing for open-source apps
 * (developers.openai.com/siwc/token-sharing-open-source): the user approves
 * Anton in ChatGPT, and the access token it gets calls the OpenAI Responses
 * API on their plan. Ported from pi-ai 1.x (MIT), which Flue does not ship yet.
 */
export type ChatGptOptions = { authUrl: string; apiUrl: string };

export const CHATGPT_DEFAULTS: ChatGptOptions = { authUrl: 'https://auth.openai.com', apiUrl: 'https://api.openai.com/v1' };

/** First sign-ins register a new client under this id; OpenAI sends back the one it issued. */
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME = 'Anton';
/** OpenAI only sends the browser back to a loopback address on 127.0.0.1, never a hosted URL. */
export const CHATGPT_REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** Renew this long before the token expires, so no request starts with one about to lapse. */
const EXPIRY_MARGIN_MS = 3 * 60_000;
const TIMEOUT_MS = 15_000;

const base64url = (bytes: Buffer) => bytes.toString('base64url');
const random = () => base64url(randomBytes(32));

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown; scope?: unknown };

/** The ID token's email, read without checking its signature: Anton only shows it, and trusts nothing to it. */
export function emailOf(idToken: unknown): string | null {
	if (typeof idToken !== 'string') return null;
	try {
		const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown };
		return typeof claims.email === 'string' ? claims.email : null;
	} catch {
		return null;
	}
}

function credentialFrom(token: TokenResponse, clientId: string, email: string | null): SubscriptionCredential {
	const text = (value: unknown, field: string) => {
		if (typeof value !== 'string' || !value.trim()) throw new Error(`ChatGPT's token response has no ${field}`);
		return value;
	};
	if (typeof token.expires_in !== 'number' || !(token.expires_in > 0)) throw new Error("ChatGPT's token response has no expiry");
	const scopes = text(token.scope, 'scope').trim().split(/\s+/);
	if (!scopes.includes(PLAN_SCOPE)) throw new Error('ChatGPT did not allow Anton to use your plan. Sign in again and approve plan usage.');
	return {
		access: text(token.access_token, 'access token'),
		refresh: text(token.refresh_token, 'refresh token'),
		expiresAt: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
		clientId,
		scopes,
		email: emailOf(token.id_token) ?? email,
	};
}

/** `none` is how OpenAI says reasoning is off. */
const asLevel = (effort: unknown): Reasoning | undefined => {
	const name = typeof effort === 'string' ? effort : (effort as { effort?: unknown } | null)?.effort;
	return REASONING_LEVELS.find((level) => level === (name === 'none' ? 'off' : name));
};

/** The fields Anton reads from an entry of `GET /models` for a ChatGPT token. */
type ListedModel = {
	slug?: string;
	id?: string;
	display_name?: string;
	description?: string;
	visibility?: string;
	context_window?: number;
	max_output_tokens?: number;
	input_modalities?: string[];
	supported_reasoning_levels?: unknown[];
	default_reasoning_level?: string;
};

const known = new Map<string, (typeof OPENAI_MODELS)[keyof typeof OPENAI_MODELS]>(Object.values(OPENAI_MODELS).map((model) => [model.id, model]));

/** What pi knows of an OpenAI model fills in what the account's list leaves out. */
export function toSubscriptionModel(listed: ListedModel, gateway: string): SubscriptionModel | null {
	const slug = listed.slug ?? listed.id;
	if (!slug || (listed.visibility && listed.visibility !== 'list')) return null;
	const pi = known.get(slug);
	const listedLevels = (listed.supported_reasoning_levels ?? []).map(asLevel).filter((level) => level !== undefined);
	const piLevels = pi?.reasoning ? REASONING_LEVELS.filter((level) => pi.thinkingLevelMap?.[level] !== null) : [];
	const levels = listedLevels.length ? listedLevels : piLevels.length ? piLevels : (['low', 'medium', 'high'] as Reasoning[]);
	const reasoning = REASONING_LEVELS.filter((level) => levels.includes(level));
	const preferred = asLevel(listed.default_reasoning_level) ?? 'medium';
	return {
		id: `${gateway}/${slug}`,
		name: listed.display_name ?? pi?.name ?? slug,
		vendor: 'OpenAI',
		description: listed.description ?? 'Runs on your ChatGPT plan.',
		createdAt: 0,
		contextLength: listed.context_window ?? pi?.contextWindow ?? 128_000,
		maxOutput: listed.max_output_tokens ?? pi?.maxTokens ?? null,
		vision: listed.input_modalities ? listed.input_modalities.includes('image') : (pi?.input.includes('image') ?? false),
		reasoning,
		defaultReasoning: reasoning.includes(preferred) ? preferred : (reasoning.find((level) => level !== 'off') ?? 'off'),
		listPrice: pi ? { input: pi.cost.input, output: pi.cost.output, cacheRead: pi.cost.cacheRead, cacheWrite: pi.cost.cacheWrite } : null,
	};
}

export function chatGptSubscription(options: ChatGptOptions = CHATGPT_DEFAULTS): SubscriptionProvider {
	const tokenUrl = `${options.authUrl}/api/accounts/oauth/token`;

	async function requestToken(body: URLSearchParams, signal?: AbortSignal): Promise<TokenResponse> {
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		const response = await fetch(tokenUrl, {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) throw new Error(`ChatGPT sign-in failed (${response.status}): ${(await response.text().catch(() => '')).slice(0, 300) || response.statusText}`);
		return (await response.json()) as TokenResponse;
	}

	return {
		id: 'chatgpt',
		name: 'ChatGPT',
		// pi's own id for OpenAI, so tool calls and reasoning replay the way pi tunes them for the Responses API.
		gateway: 'openai',

		startLogin(hostId, previous) {
			const verifier = random();
			const state = random();
			const url = new URL(`${options.authUrl}/api/accounts/authorize`);
			url.search = new URLSearchParams({
				// A sign-in again reuses the client the first one registered, so ChatGPT lists Anton once.
				client_id: previous?.clientId ?? DYNAMIC_CLIENT_ID,
				...(previous ? (previous.email ? { login_hint: previous.email } : {}) : { agent_name_hint: AGENT_NAME }),
				ext_agent_host_id: hostId,
				response_type: 'code',
				redirect_uri: CHATGPT_REDIRECT_URI,
				resource: options.apiUrl,
				scope: SCOPE,
				state,
				nonce: random(),
				code_challenge: base64url(createHash('sha256').update(verifier).digest()),
				code_challenge_method: 'S256',
			}).toString();
			return {
				url: url.toString(),
				redirectUri: CHATGPT_REDIRECT_URI,
				async complete(callbackUrl, signal) {
					let callback: URL;
					try {
						callback = new URL(callbackUrl.trim());
					} catch {
						throw new Error(`Paste the whole address, starting with ${CHATGPT_REDIRECT_URI}`);
					}
					const expected = new URL(CHATGPT_REDIRECT_URI);
					if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
						throw new Error(`Paste the whole address, starting with ${CHATGPT_REDIRECT_URI}`);
					}
					const params = callback.searchParams;
					if (params.get('state') !== state) throw new Error('That address is from a different sign-in. Start again and paste the newest one.');
					const error = params.get('error');
					if (error) throw new Error(error === 'access_denied' ? 'ChatGPT sign-in was cancelled.' : `ChatGPT sign-in failed: ${error}`);
					const code = params.get('code');
					if (!code) throw new Error('That address has no sign-in code. Paste the address ChatGPT sent you back to.');
					const issued = params.get('client_id') ?? previous?.clientId;
					if (!issued) throw new Error('ChatGPT did not say which client it registered for Anton. Start the sign-in again.');
					if (previous && issued !== previous.clientId) throw new Error('ChatGPT answered for a different client. Disconnect and sign in again.');
					const token = await requestToken(
						new URLSearchParams({
							grant_type: 'authorization_code',
							client_id: issued,
							code,
							code_verifier: verifier,
							redirect_uri: CHATGPT_REDIRECT_URI,
							resource: options.apiUrl,
						}),
						signal,
					);
					return credentialFrom(token, issued, null);
				},
			};
		},

		async refresh(credential, signal) {
			const token = await requestToken(
				new URLSearchParams({ grant_type: 'refresh_token', client_id: credential.clientId, refresh_token: credential.refresh, resource: options.apiUrl }),
				signal,
			);
			return credentialFrom(token, credential.clientId, credential.email);
		},

		async listModels(accessToken) {
			const response = await fetch(`${options.apiUrl}/models`, {
				headers: { Authorization: `Bearer ${accessToken}` },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`ChatGPT models: ${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);
			const body = (await response.json()) as { models?: ListedModel[]; data?: ListedModel[] };
			return (body.models ?? body.data ?? []).map((listed) => toSubscriptionModel(listed, 'openai')).filter((model) => model !== null);
		},
	};
}
