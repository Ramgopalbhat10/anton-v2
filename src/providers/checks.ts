import { execFile } from 'node:child_process';
import { createClient } from '@libsql/client';
import { ModalClient } from 'modal';
import { githubHost } from './github/host.ts';
import { openRouterDecisions } from './openrouter/decisions.ts';
import { s3Store } from './s3/store.ts';

/*
 * Each provider checked with values that are not saved yet, for Test in
 * Settings › Connections: it answers what it found in a sentence, or throws
 * with why it could not. None keeps anything it was given.
 */

export async function checkGitHub(token: string, apiUrl: string): Promise<string> {
	const name = await githubHost({ token, apiUrl })
		.accountName()
		.catch((error: unknown) => {
			const status = /: (\d{3})\b/.exec(error instanceof Error ? error.message : '')?.[1];
			if (status === '401') throw new Error('GitHub rejected this token. Make a new one with Contents and Pull requests set to read and write.');
			if (status === '403') throw new Error('GitHub refused this token (403). It may be missing access, or the API rate limit was hit.');
			throw error;
		});
	if (!name) throw new Error('GitHub did not say whose token this is.');
	return `Acting as ${name}. Pushes and pull requests go through its API.`;
}

export async function checkModal(tokenId: string, tokenSecret: string, app: string): Promise<string> {
	const client = new ModalClient({ tokenId, tokenSecret, timeoutMs: 10_000, maxRetries: 0 });
	try {
		await client.apps.fromName(app, { createIfMissing: true });
		return `Signed in to Modal. Tasks run in app ${app}.`;
	} finally {
		client.close();
	}
}

export function checkDocker(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 }, (error, stdout, stderr) => {
			if (error) reject(new Error((stderr || error.message).trim().split('\n')[0] || 'Docker did not answer.'));
			else resolve(`Docker ${stdout.trim()} answered. Tasks run as containers on this server.`);
		});
	});
}

export async function checkS3(options: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string }): Promise<string> {
	await s3Store(options).has('anton/connection-check');
	return `Bucket ${options.bucket} at ${new URL(options.endpoint).host}.`;
}

export async function checkLibsql(url: string, authToken: string): Promise<string> {
	const client = createClient({ url, authToken: authToken || undefined });
	try {
		await client.execute('SELECT 1');
		return `Hosted at ${new URL(url.replace(/^libsql:/, 'https:')).host}.`;
	} finally {
		client.close();
	}
}

export async function checkDecisionModel(apiUrl: string, apiKey: () => string | null, model: string): Promise<string> {
	const started = Date.now();
	await openRouterDecisions({ apiUrl, apiKey, model }).decide({ check: 'connection' }, { ok: { type: 'yes-no', instructions: 'Is this a connection check?' } });
	return `${model} answered a test question in ${((Date.now() - started) / 1000).toFixed(1)}s.`;
}

/** An MCP server that answers the protocol's first request; it is not asked for its tools, which the agent does itself. */
export async function checkMcpServer(url: string, key: string): Promise<string> {
	const response = await fetch(url, {
		method: 'POST',
		signal: AbortSignal.timeout(10_000),
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'anton', version: '1' } } }),
	});
	await response.body?.cancel();
	if (response.status === 401 || response.status === 403) throw new Error(`${new URL(url).host} refused the key (${response.status}).`);
	if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}.`);
	return `${new URL(url).host} answered. The agent gets web_search and web_fetch from it.`;
}
