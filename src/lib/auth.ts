import type { Client } from '@libsql/client';
import { decryptToken, encryptToken, stateMatches } from './crypto.ts';
import { env } from './env.ts';
import {
	exchangeCode,
	fetchUser,
	GitHubReconnectError,
	refreshAccessToken,
	type GitHubClientConfig,
} from './github.ts';

const REFRESH_WINDOW_MS = 60_000;

export function githubClientFromEnv(): GitHubClientConfig {
	return {
		clientId: env.githubClientId,
		clientSecret: env.githubClientSecret,
		callbackUrl: env.githubCallbackUrl,
	};
}

export async function finishGitHubLogin(input: {
	code: string;
	state: string;
	nonce: string | null;
	db: Client;
	client: GitHubClientConfig;
	fetchImpl: typeof fetch;
	now?: number;
}): Promise<{ userId: string; login: string; avatarUrl: string | null; name: string | null; email: string | null }> {
	if (!input.nonce || !stateMatches(input.state, input.nonce)) {
		throw new Error('GitHub OAuth state is invalid');
	}
	const now = input.now ?? Date.now();
	const token = await exchangeCode(input.code, input.client, input.fetchImpl, now);
	const profile = await fetchUser(token.accessToken, input.fetchImpl);
	const userId = `gh_${profile.id}`;
	const createdAt = new Date(now).toISOString();
	await input.db.execute({
		sql: `INSERT INTO users (id, github_id, login, avatar_url, created_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				github_id = excluded.github_id,
				login = excluded.login,
				avatar_url = excluded.avatar_url`,
		args: [userId, String(profile.id), profile.login, profile.avatarUrl, createdAt],
	});
	await input.db.execute({
		sql: `INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, needs_reconnect)
			VALUES (?, ?, ?, ?, 0)
			ON CONFLICT(user_id) DO UPDATE SET
				access_token = excluded.access_token,
				refresh_token = excluded.refresh_token,
				expires_at = excluded.expires_at,
				needs_reconnect = 0`,
		args: [
			userId,
			encryptToken(token.accessToken),
			token.refreshToken ? encryptToken(token.refreshToken) : null,
			token.expiresAt,
		],
	});
	return {
		userId,
		login: profile.login,
		avatarUrl: profile.avatarUrl,
		name: profile.name,
		email: profile.email,
	};
}

export async function markGitHubReconnect(userId: string, db: Client): Promise<void> {
	await db.execute({
		sql: 'UPDATE oauth_tokens SET needs_reconnect = 1 WHERE user_id = ?',
		args: [userId],
	});
}

export async function ensureAccessToken(
	userId: string,
	db: Client,
	client: GitHubClientConfig,
	fetchImpl: typeof fetch = fetch,
	now = Date.now(),
): Promise<string> {
	const result = await db.execute({
		sql: 'SELECT access_token, refresh_token, expires_at, needs_reconnect FROM oauth_tokens WHERE user_id = ?',
		args: [userId],
	});
	const row = result.rows[0] as Record<string, unknown> | undefined;
	if (!row || Number(row.needs_reconnect) === 1) throw new GitHubReconnectError();
	const expiresAt = row.expires_at ? Date.parse(String(row.expires_at)) : null;
	if (expiresAt !== null && expiresAt - now < REFRESH_WINDOW_MS) {
		const refresh = row.refresh_token ? decryptToken(String(row.refresh_token)) : null;
		if (!refresh) {
			await markGitHubReconnect(userId, db);
			throw new GitHubReconnectError();
		}
		try {
			const next = await refreshAccessToken(refresh, client, fetchImpl, now);
			await db.execute({
				sql: `UPDATE oauth_tokens
					SET access_token = ?, refresh_token = ?, expires_at = ?, needs_reconnect = 0
					WHERE user_id = ?`,
				args: [
					encryptToken(next.accessToken),
					next.refreshToken ? encryptToken(next.refreshToken) : null,
					next.expiresAt,
					userId,
				],
			});
			return next.accessToken;
		} catch (error) {
			await markGitHubReconnect(userId, db);
			if (error instanceof GitHubReconnectError) throw error;
			throw new GitHubReconnectError();
		}
	}
	return decryptToken(String(row.access_token));
}

export async function githubProfile(userId: string, db: Client): Promise<{
	id: string;
	login: string;
	avatarUrl: string | null;
	needsReconnect: boolean;
} | null> {
	const result = await db.execute({
		sql: `SELECT users.id, users.login, users.avatar_url, oauth_tokens.needs_reconnect
			FROM users LEFT JOIN oauth_tokens ON oauth_tokens.user_id = users.id
			WHERE users.id = ?`,
		args: [userId],
	});
	const row = result.rows[0] as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		id: String(row.id),
		login: String(row.login),
		avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
		needsReconnect: Number(row.needs_reconnect ?? 0) === 1,
	};
}
