import { mkdirSync } from 'node:fs';
import path from 'node:path';

function requiredDevFallback(name: string, fallback: string): string {
	const value = process.env[name];
	if (value && value.length > 0) return value;
	return fallback;
}

export const env = {
	openRouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
	anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
	githubClientId: process.env.GITHUB_CLIENT_ID ?? '',
	githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
	githubCallbackUrl:
		process.env.GITHUB_CALLBACK_URL ?? 'http://127.0.0.1:43127/api/auth/github/callback',
	tursoUrl: requiredDevFallback('TURSO_DATABASE_URL', 'file:./data/anton.db'),
	tursoToken: process.env.TURSO_AUTH_TOKEN ?? '',
	modalTokenId: process.env.MODAL_TOKEN_ID ?? '',
	modalTokenSecret: process.env.MODAL_TOKEN_SECRET ?? '',
	tigrisEndpoint: process.env.TIGRIS_ENDPOINT ?? '',
	tigrisBucket: process.env.TIGRIS_BUCKET ?? '',
	tigrisAccessKey: process.env.TIGRIS_ACCESS_KEY_ID ?? '',
	tigrisSecretKey: process.env.TIGRIS_SECRET_ACCESS_KEY ?? '',
	sessionSecret: requiredDevFallback('SESSION_SECRET', 'dev-session-secret-change-me'),
	tokenEncryptionKey: requiredDevFallback('TOKEN_ENCRYPTION_KEY', 'dev-token-key-change-me-32b'),
	devUser: process.env.ANTON_DEV_USER !== '0',
	port: Number(process.env.PORT ?? 43127),
	defaultModel: process.env.ANTON_MODEL ?? 'openrouter/anthropic/claude-sonnet-4',
};

export function dataDir(): string {
	const dir = path.resolve('data');
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function workspacesDir(): string {
	const dir = path.join(dataDir(), 'workspaces');
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function hasModal(): boolean {
	return Boolean(env.modalTokenId && env.modalTokenSecret);
}

export function hasGitHubOAuth(): boolean {
	return Boolean(env.githubClientId && env.githubClientSecret);
}

export function hasOpenRouter(): boolean {
	return Boolean(env.openRouterApiKey);
}

export function hasTigris(): boolean {
	return Boolean(env.tigrisEndpoint && env.tigrisBucket && env.tigrisAccessKey && env.tigrisSecretKey);
}
