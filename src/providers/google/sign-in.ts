import { createHash, randomBytes } from 'node:crypto';
import type { AccountSignIn, OAuthClient, SubscriptionCredential } from '../../core/ports.ts';

const TIMEOUT_MS = 20_000;
/** Who signed in, for the settings card: an email in the ID token. */
const IDENTITY = ['openid', 'email'];

type Options = { authUrl: string; tokenUrl: string; revokeUrl: string };
const DEFAULTS: Options = {
	authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	revokeUrl: 'https://oauth2.googleapis.com/revoke',
};

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string; error?: string; error_description?: string };

const base64url = (bytes: Buffer) => bytes.toString('base64url');
const random = () => base64url(randomBytes(32));

function emailOf(idToken: string | undefined): string | null {
	const payload = idToken?.split('.')[1];
	if (!payload) return null;
	try {
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown };
		return typeof claims.email === 'string' ? claims.email : null;
	} catch {
		return null;
	}
}

/** Google's errors in words that say what to change. */
function explain(status: number, body: TokenResponse | null, text: string): string {
	const code = body?.error ?? '';
	if (code === 'invalid_client') return 'Google does not know that client id and secret. Copy both again from the OAuth client in Google Cloud.';
	if (code === 'invalid_grant') return 'Google no longer accepts this sign-in (it was revoked, expired, or the consent screen is still in Testing). Connect again.';
	if (code === 'redirect_uri_mismatch') return 'Google says the redirect address is not on the OAuth client. Add the one Settings shows.';
	return `Google sign-in failed (${status}): ${body?.error_description ?? (code || text.slice(0, 300))}`;
}

/** Signing in to a Google account for its APIs, with PKCE on the OAuth client you made in Google Cloud. */
export function googleSignIn(overrides: Partial<Options> = {}): AccountSignIn {
	const options = { ...DEFAULTS, ...overrides };

	async function requestToken(body: URLSearchParams, signal?: AbortSignal): Promise<TokenResponse> {
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		const response = await fetch(options.tokenUrl, {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const text = await response.text().catch(() => '');
		let parsed: TokenResponse | null = null;
		try {
			parsed = JSON.parse(text) as TokenResponse;
		} catch {
			parsed = null;
		}
		// The message carries the status in brackets, so a renewal Google refused reads as a sign-in to repeat.
		if (!response.ok || !parsed?.access_token) throw new Error(`${explain(response.status, parsed, text)} (${response.status})`);
		return parsed;
	}

	function credentialFrom(token: TokenResponse, client: OAuthClient, previous: SubscriptionCredential | null): SubscriptionCredential {
		const refresh = token.refresh_token ?? previous?.refresh;
		if (!refresh) throw new Error('Google sent no refresh token, so Anton could not stay signed in. Remove Anton under your Google account’s third-party connections, then connect again.');
		return {
			access: token.access_token!,
			refresh,
			expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
			clientId: client.clientId,
			scopes: token.scope ? token.scope.split(' ').filter(Boolean) : (previous?.scopes ?? []),
			email: emailOf(token.id_token) ?? previous?.email ?? null,
		};
	}

	return {
		id: 'google',
		name: 'Google',

		startLogin(client, scopes, redirectUri, hint) {
			const verifier = random();
			const state = random();
			const url = new URL(options.authUrl);
			url.search = new URLSearchParams({
				client_id: client.clientId,
				redirect_uri: redirectUri,
				response_type: 'code',
				scope: [...new Set([...IDENTITY, ...scopes])].join(' '),
				// A refresh token every time, so a sign-in again replaces one Google stopped accepting.
				access_type: 'offline',
				prompt: 'consent',
				include_granted_scopes: 'true',
				state,
				code_challenge: base64url(createHash('sha256').update(verifier).digest()),
				code_challenge_method: 'S256',
				...(hint ? { login_hint: hint } : {}),
			}).toString();
			return {
				url: url.toString(),
				redirectUri,
				async complete(callbackUrl, signal) {
					let params: URLSearchParams;
					try {
						params = new URL(callbackUrl.trim()).searchParams;
					} catch {
						throw new Error('That is not the address Google sent you back to.');
					}
					if (params.get('state') !== state) throw new Error('That answer is from a different sign-in. Connect again.');
					const error = params.get('error');
					if (error) throw new Error(error === 'access_denied' ? 'The Google sign-in was cancelled.' : `Google sign-in failed: ${error}`);
					const code = params.get('code');
					if (!code) throw new Error('Google sent no sign-in code back. Connect again.');
					const token = await requestToken(
						new URLSearchParams({
							grant_type: 'authorization_code',
							code,
							client_id: client.clientId,
							client_secret: client.clientSecret,
							redirect_uri: redirectUri,
							code_verifier: verifier,
						}),
						signal,
					);
					return credentialFrom(token, client, null);
				},
			};
		},

		async refresh(client, credential, signal) {
			const token = await requestToken(
				new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refresh, client_id: client.clientId, client_secret: client.clientSecret }),
				signal,
			);
			return credentialFrom(token, client, credential);
		},

		async revoke(credential) {
			const response = await fetch(options.revokeUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ token: credential.refresh }),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			// An already revoked token answers 400, which is what was wanted.
			if (!response.ok && response.status !== 400) throw new Error(`Google did not revoke the sign-in (${response.status})`);
		},
	};
}
