// Google sign-in for the Antigravity ACP agent. agy authenticates itself: it
// reads `antigravity-oauth-token` from its app-data dir (a refresh-token JSON
// it refreshes in place), or the OS keyring when one exists. Anton runs the
// same OAuth the `agy acp --login` flow does — Antigravity's public installed-app
// client, agy's scopes — and keeps the token file itself, so a jailed container
// needs nothing but that one file.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../../config.ts';
import type { RuntimeSignIn } from '../../core/ports.ts';

/** agy's own scope list (what `agy acp --login` requests); aicode and openid are its additions. */
const SCOPES = [
	'https://www.googleapis.com/auth/cloud-platform',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/userinfo.profile',
	'https://www.googleapis.com/auth/cclog',
	'https://www.googleapis.com/auth/experimentsandconfigs',
	'https://www.googleapis.com/auth/aicode',
	'openid',
];
// The redirect agy's own login uses; its hosted page shows the code to paste back.
const REDIRECT_URI = 'https://antigravity.google/oauth-callback';
const TIMEOUT_MS = 15_000;

// The client is agy's public installed-app registration, kept in env so the
// repo carries no vendor credential; every function that trades codes or
// refreshes tokens needs it.
function oauthClient(): { id: string; secret: string } {
	const id = config.antigravity.oauthClientId;
	const secret = config.antigravity.oauthClientSecret;
	if (!id || !secret) throw new Error('Antigravity OAuth is not configured: set ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET (agy’s public installed-app client) and try again.');
	return { id, secret };
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

// The PKCE verifier rides inside `state` so complete() can trade a pasted URL without server-side login state.
const encodeState = (verifier: string) => Buffer.from(JSON.stringify({ verifier }), 'utf8').toString('base64url');
const decodeState = (state: string): string => {
	try {
		const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { verifier?: unknown };
		return typeof parsed.verifier === 'string' ? parsed.verifier : '';
	} catch {
		return '';
	}
};

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string };
type StoredToken = { token?: { refresh_token?: unknown; access_token?: unknown }; id_token_email?: unknown };

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const text = await response.text().catch(() => '');
	let parsed: TokenResponse | null = null;
	try {
		parsed = JSON.parse(text) as TokenResponse;
	} catch {
		/* non-JSON */
	}
	if (!response.ok || !parsed?.access_token) {
		throw new Error(`Google sign-in failed (${response.status}): ${parsed?.error_description ?? parsed?.error ?? text.slice(0, 300)}`);
	}
	return parsed;
}

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

/** The shape agy stores at `<app-data>/antigravity-oauth-token`; it refreshes access_token itself. */
function tokenFile(token: TokenResponse, previous: StoredToken | null): string {
	const refresh = token.refresh_token ?? (typeof previous?.token?.refresh_token === 'string' ? previous.token.refresh_token : '');
	if (!refresh) throw new Error('Google sent no refresh token. Remove Anton under your Google account’s third-party connections, then sign in again.');
	const email = emailOf(token.id_token) ?? (typeof previous?.id_token_email === 'string' ? previous.id_token_email : null);
	return JSON.stringify(
		{
			token: {
				access_token: token.access_token,
				token_type: 'Bearer',
				refresh_token: refresh,
				expiry: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
				expires_in: token.expires_in ?? 3600,
			},
			auth_method: 'consumer',
			id_token_email: email,
		},
		null,
		2,
	);
}

async function writeTokenFile(file: string, content: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	await writeFile(tmp, content, { mode: 0o600 });
	await rename(tmp, file);
}

/** The raw file content when it holds a usable sign-in, else null — what `signedIn`/`credential` judge by. */
export async function readCredential(file: string): Promise<string | null> {
	let text: string;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	try {
		const parsed = JSON.parse(text) as StoredToken;
		return typeof parsed.token?.refresh_token === 'string' && parsed.token.refresh_token ? text : null;
	} catch {
		return null;
	}
}

async function readStored(file: string): Promise<StoredToken | null> {
	const text = await readCredential(file);
	if (!text) return null;
	try {
		return JSON.parse(text) as StoredToken;
	} catch {
		return null;
	}
}

export function antigravitySignIn(file: string): RuntimeSignIn {
	const client = oauthClient();
	const verifier = base64url(randomBytes(32));
	const state = encodeState(verifier);
	const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
	url.search = new URLSearchParams({
		client_id: client.id,
		response_type: 'code',
		redirect_uri: REDIRECT_URI,
		scope: SCOPES.join(' '),
		access_type: 'offline',
		prompt: 'consent',
		code_challenge: base64url(createHash('sha256').update(verifier).digest()),
		code_challenge_method: 'S256',
		state,
	}).toString();
	return {
		url: url.toString(),
		async complete(pasted) {
			// The paste is either the whole callback URL or the bare code the page shows.
			let code = '';
			let callbackState = '';
			try {
				const params = new URL(pasted.trim()).searchParams;
				code = params.get('code') ?? '';
				callbackState = params.get('state') ?? '';
				const error = params.get('error');
				if (error) throw new Error(error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${error}`);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith('Google sign-in')) throw error;
				code = pasted.trim();
			}
			if (!code) throw new Error('Paste the address Google sent you back to, or the code it shows.');
			if (callbackState && callbackState !== state) throw new Error('That address is from a different sign-in. Start again and paste the newest one.');
			const token = await requestToken(
				new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: client.id,
					client_secret: client.secret,
					code,
					code_verifier: decodeState(callbackState) || verifier,
					redirect_uri: REDIRECT_URI,
				}),
			);
			// Google omits refresh_token on re-consent; keep the stored one.
			await writeTokenFile(file, tokenFile(token, await readStored(file)));
		},
		cancel() {},
	};
}

/**
 * Refresh-token grant for reads that are not sign-in (the quota probe). The
 * token file is never written here — agy owns it and may rotate the refresh
 * token; callers keep the result in memory only.
 */
export async function antigravityRefresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
	const client = oauthClient();
	const token = await requestToken(
		new URLSearchParams({
			grant_type: 'refresh_token',
			client_id: client.id,
			client_secret: client.secret,
			refresh_token: refreshToken,
		}),
	);
	return { accessToken: token.access_token!, expiresIn: token.expires_in ?? 3600 };
}

/** Best-effort revoke of the refresh token, then the file goes — agy holds nothing else. */
export async function antigravitySignOut(file: string): Promise<void> {
	const credential = await readCredential(file);
	if (credential) {
		try {
			const parsed = JSON.parse(credential) as StoredToken;
			const refresh = parsed.token?.refresh_token;
			if (typeof refresh === 'string' && refresh) {
				await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
			}
		} catch {
			/* revocation is best-effort */
		}
	}
	await rm(file, { force: true }).catch(() => undefined);
}
