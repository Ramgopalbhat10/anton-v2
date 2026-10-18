import { randomBytes } from 'node:crypto';
import {
	auth,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	OAuthError,
	OAuthErrorCode,
	refreshAuthorization,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { announce } from '../core/changes.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { getMcpServer, getMcpSignIn, setMcpSignIn } from '../db/mcp-servers.ts';
import { appOrigin } from './connectors.ts';
import { logProblem } from './log.ts';

/**
 * Signing in to a remote MCP server with OAuth, the way its spec has clients
 * do it, so a server such as Linear or Notion is connected with a button
 * rather than a pasted token. The MCP SDK's `auth()` does the protocol:
 * discovery from the server's protected-resource metadata, registering Anton
 * as an app (dynamic client registration, or a client you paste for a server
 * that has none), PKCE, and the code exchange. This module keeps what it
 * learns per server, on Anton's server only, and renews the token before each
 * message, so the agent's connections get a plain bearer token, as with a
 * pasted one, and the token never reaches a sandbox, a view or the model.
 */

/** What Anton keeps of a server's sign-in, in its `oauth_json`. */
type SignIn = {
	/** Anton as an app of the server's sign-in: registered by Anton, or pasted by you (`pasted`). */
	client?: StoredOAuthClientInformation;
	/** The address the client was registered with; a client registered for another address of Anton's is registered again. */
	clientRedirect?: string;
	pasted?: boolean;
	discovery?: OAuthDiscoveryState;
	resource?: string;
	tokens?: StoredOAuthTokens & { obtainedAt: number };
	signedInAt?: string;
	problem?: string | null;
};

/** How a server's sign-in looks to the browser: never its tokens or client secret. */
export type McpSignInView = { state: 'signed-in' | 'needed' | 'none'; since: string | null; problem: string | null; clientId: string | null; pastedClient: boolean };

export const MCP_CALLBACK_PATH = '/api/mcp-servers/callback';
const LOGIN_TTL_MS = 10 * 60_000;
/** A token this close to expiring is renewed first, so a call the agent makes with it does not fail halfway. */
const RENEW_EARLY_MS = 5 * 60_000;

/** The server's sign-in needs you: it was refused, or it has run out with nothing to renew it. */
export class McpSignInNeeded extends Error {
	override name = 'McpSignInNeeded';
}

async function stored(name: string): Promise<SignIn> {
	return ((await getMcpSignIn(name)) as SignIn | null) ?? {};
}

export async function signInView(name: string): Promise<McpSignInView> {
	const signIn = await stored(name);
	const clientId = signIn.pasted ? (signIn.client?.client_id ?? null) : null;
	if (signIn.problem) return { state: 'needed', since: signIn.signedInAt ?? null, problem: signIn.problem, clientId, pastedClient: Boolean(signIn.pasted) };
	return { state: signIn.tokens ? 'signed-in' : 'none', since: signIn.signedInAt ?? null, problem: null, clientId, pastedClient: Boolean(signIn.pasted) };
}

/**
 * The SDK's view of one server's sign-in. Each leg of a sign-in (and each
 * renewal) works on a copy of what is kept, saved back once the leg is done.
 */
class ServerSignIn implements OAuthClientProvider {
	authorizationUrl: URL | null = null;
	readonly loginState = randomBytes(16).toString('base64url');
	readonly data: SignIn;
	private readonly redirect: string;
	private verifier: string;

	constructor(data: SignIn, redirect: string, verifier = '') {
		this.data = data;
		this.redirect = redirect;
		this.verifier = verifier;
	}

	get redirectUrl() {
		return this.redirect;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: 'Anton',
			redirect_uris: [this.redirect],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			// A public client: PKCE protects the code, so there is no secret to keep.
			token_endpoint_auth_method: 'none',
		};
	}

	state() {
		return this.loginState;
	}

	clientInformation() {
		if (!this.data.client) return undefined;
		// Registered for another of Anton's addresses: the server would refuse this redirect, so register again.
		if (!this.data.pasted && this.data.clientRedirect !== this.redirect) return undefined;
		return this.data.client;
	}

	saveClientInformation(client: StoredOAuthClientInformation) {
		this.data.client = client;
		if (!this.data.pasted) this.data.clientRedirect = this.redirect;
	}

	tokens() {
		return this.data.tokens;
	}

	saveTokens(tokens: StoredOAuthTokens) {
		this.data.tokens = { ...tokens, obtainedAt: Date.now() };
	}

	redirectToAuthorization(url: URL) {
		this.authorizationUrl = url;
	}

	saveCodeVerifier(verifier: string) {
		this.verifier = verifier;
	}

	codeVerifier() {
		return this.verifier;
	}

	saveDiscoveryState(state: OAuthDiscoveryState) {
		this.data.discovery = state;
	}

	discoveryState() {
		return this.data.discovery;
	}

	saveResourceUrl(url: string) {
		this.data.resource = url;
	}

	invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
		if ((scope === 'all' || scope === 'client') && !this.data.pasted) delete this.data.client;
		if (scope === 'all' || scope === 'tokens') delete this.data.tokens;
		if (scope === 'all' || scope === 'discovery') delete this.data.discovery;
	}
}

type Login = { name: string; url: string; redirect: string; verifier: string; data: SignIn; at: number };
const logins = new Map<string, Login>();

function dropStale() {
	for (const [state, login] of logins) if (Date.now() - login.at > LOGIN_TTL_MS) logins.delete(state);
}

async function existingServer(name: string) {
	const server = await getMcpServer(name);
	if (!server) throw new NotFoundError(`No MCP server is named ${name}`);
	return server;
}

const UNREACHABLE = /fetch failed|ENOTFOUND|ECONNREFUSED|timed out/i;

/** What went wrong, in words you can act on. */
function explain(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/dynamic client registration|registration_endpoint/i.test(message)) {
		return "This server doesn't let apps register themselves. Create an OAuth app in the service's settings with the redirect URI shown here, then paste its client id.";
	}
	if (error instanceof OAuthError && error.code === OAuthErrorCode.InvalidClient) return 'The server refused the client id. Check it, and that its redirect URI matches.';
	if (UNREACHABLE.test(message)) return `Anton couldn't reach the server's sign-in: ${message}`;
	return message;
}

/**
 * Starts signing in to a server: Anton finds where it signs in, registers
 * itself there if it must, and returns the address to send the browser to.
 * `client` is one you made in the service's settings, for a server that does
 * not let apps register themselves.
 */
export async function beginMcpSignIn(name: string, origin: string, client?: { clientId: string; clientSecret?: string | null } | null): Promise<{ url: string | null }> {
	const server = await existingServer(name);
	const redirect = `${appOrigin(origin)}${MCP_CALLBACK_PATH}`;
	const before = await stored(name);
	const data: SignIn = { ...before };
	if (client?.clientId) {
		// The same client sent again without its secret keeps the secret it had.
		const secret = client.clientSecret || (before.pasted && before.client?.client_id === client.clientId ? before.client.client_secret : undefined);
		data.client = { client_id: client.clientId, ...(secret ? { client_secret: secret } : {}) } as StoredOAuthClientInformation;
		data.pasted = true;
		delete data.clientRedirect;
	}
	// Signing in again starts afresh, so a refused token is never renewed instead of asking you.
	delete data.tokens;
	const provider = new ServerSignIn(data, redirect);
	let result: Awaited<ReturnType<typeof auth>>;
	try {
		result = await auth(provider, { serverUrl: server.url });
	} catch (error) {
		// Nothing told Anton where the server signs in: it takes a token, or nothing at all.
		const discovered = provider.data.discovery?.resourceMetadata || provider.data.discovery?.authorizationServerMetadata;
		throw new InvalidInputError(discovered || UNREACHABLE.test(String(error)) ? explain(error) : `${name} doesn't offer an OAuth sign-in. If it needs a token, add it with Edit.`);
	}
	if (result === 'AUTHORIZED') {
		// A server that needs no browser step (a client credentials grant) is signed in already.
		await setMcpSignIn(name, { ...provider.data, signedInAt: new Date().toISOString(), problem: null });
		announce({ kind: 'connectors' });
		return { url: null };
	}
	// Where it signs in and Anton's registration are kept now; the sign-in in hand stays until the new one replaces it.
	await setMcpSignIn(name, { ...provider.data, tokens: before.tokens, signedInAt: before.signedInAt, problem: before.problem ?? null });
	if (!provider.authorizationUrl) throw new InvalidInputError("The server's sign-in gave no address to sign in at.");
	dropStale();
	logins.set(provider.loginState, { name, url: server.url, redirect, verifier: provider.codeVerifier(), data: provider.data, at: Date.now() });
	return { url: String(provider.authorizationUrl) };
}

/** Finishes a sign-in when the server sends the browser back with a code; returns the server's name. */
export async function finishMcpSignIn(query: URLSearchParams): Promise<string> {
	dropStale();
	const login = logins.get(query.get('state') ?? '');
	if (!login) throw new InvalidInputError('That sign-in has expired or was already used. Start it again from Settings › Connectors.');
	logins.delete(query.get('state') ?? '');
	const denied = query.get('error');
	if (denied) throw new InvalidInputError(denied === 'access_denied' ? 'You declined the sign-in.' : (query.get('error_description') ?? denied));
	const code = query.get('code');
	if (!code) throw new InvalidInputError('The server sent no sign-in code back.');
	const server = await existingServer(login.name);
	// The server's address changed while you were signing in: the sign-in was for the old one.
	if (server.url !== login.url) throw new InvalidInputError(`${login.name} changed address during the sign-in. Sign in again.`);
	const provider = new ServerSignIn(login.data, login.redirect, login.verifier);
	try {
		await auth(provider, { serverUrl: server.url, authorizationCode: code, iss: query.get('iss') ?? undefined });
	} catch (error) {
		throw new InvalidInputError(explain(error));
	}
	await setMcpSignIn(login.name, { ...provider.data, signedInAt: new Date().toISOString(), problem: null });
	announce({ kind: 'connectors' });
	return login.name;
}

/** Forgets a server's sign-in, keeping a client you pasted for it. */
export async function signOutOfMcpServer(name: string): Promise<void> {
	await existingServer(name);
	const data = await stored(name);
	await setMcpSignIn(name, data.pasted ? { client: data.client, pasted: true } : null);
	announce({ kind: 'connectors' });
}

/** Forgets everything about a server's sign-in, for a server pointed somewhere else. */
export async function forgetMcpSignIn(name: string): Promise<void> {
	await setMcpSignIn(name, null);
}

const renewing = new Map<string, Promise<string>>();

async function markNeeded(name: string, data: SignIn, problem: string): Promise<never> {
	await setMcpSignIn(name, { ...data, problem });
	announce({ kind: 'connectors' });
	throw new McpSignInNeeded(problem);
}

/**
 * The server's access token for the agent's connections, renewed first when
 * it is about to run out (one renewal shared by everyone asking). Null when
 * the server has no sign-in; McpSignInNeeded when it needs you again.
 */
export async function mcpAccessToken(name: string, url: string): Promise<string | null> {
	const data = await stored(name);
	if (data.problem) throw new McpSignInNeeded(data.problem);
	const tokens = data.tokens;
	if (!tokens) return null;
	const expiresAt = tokens.expires_in ? tokens.obtainedAt + tokens.expires_in * 1000 : null;
	if (expiresAt === null || expiresAt - Date.now() > RENEW_EARLY_MS) return tokens.access_token;
	let pending = renewing.get(name);
	if (!pending) {
		pending = (async () => {
			if (!tokens.refresh_token || !data.client || !data.discovery) {
				if (expiresAt > Date.now()) return tokens.access_token;
				return markNeeded(name, data, 'The sign-in ran out. Sign in again.');
			}
			try {
				const next = await refreshAuthorization(data.discovery.authorizationServerUrl, {
					metadata: data.discovery.authorizationServerMetadata,
					clientInformation: data.client as OAuthClientInformationMixed,
					refreshToken: tokens.refresh_token,
					resource: data.resource ? new URL(data.resource) : undefined,
				});
				// Saved only if the server still has this address, so a sign-in for an old one is not brought back.
				if ((await getMcpServer(name))?.url === url) await setMcpSignIn(name, { ...data, tokens: { ...next, obtainedAt: Date.now() }, problem: null });
				return next.access_token;
			} catch (error) {
				if (error instanceof OAuthError && error.code !== OAuthErrorCode.ServerError) return markNeeded(name, data, 'The server no longer accepts the sign-in. Sign in again.');
				// Anything else may pass: the token still in hand is used while it lasts.
				logProblem('warn', `Renewing ${name}'s MCP sign-in failed`, error);
				if (expiresAt > Date.now()) return tokens.access_token;
				throw new McpSignInNeeded(`Anton couldn't renew ${name}'s sign-in.`);
			}
		})().finally(() => renewing.delete(name));
		renewing.set(name, pending);
	}
	return pending;
}

/** For tests: forget sign-ins in progress. */
export function resetMcpSignInsForTests(): void {
	logins.clear();
	renewing.clear();
}
