import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import { GitHubReconnectError } from '../src/lib/github.ts';
import { decryptToken, sealState } from '../src/lib/crypto.ts';
import { ensureAccessToken, finishGitHubLogin, markGitHubReconnect } from '../src/lib/auth.ts';
import { migrateAppDb } from '../src/lib/db-app.ts';
import { createGitHubProject, createSession, listSessions } from '../src/lib/sessions.ts';

const execFile = promisify(execFileCb);
const root = mkdtempSync(path.join(tmpdir(), 'anton-account-'));
const db = createClient({ url: `file:${path.join(root, 'anton.db')}` });
const client = {
	clientId: 'cid',
	clientSecret: 'csec',
	callbackUrl: 'http://127.0.0.1:43127/api/auth/github/callback',
};

after(() => {
	rmSync(root, { recursive: true, force: true });
});

test('finishGitHubLogin rejects a missing or mismatched state', async () => {
	await migrateAppDb(db);
	await assert.rejects(
		() =>
			finishGitHubLogin({
				code: 'abc',
				state: 'nope',
				nonce: null,
				db,
				client,
				fetchImpl: async () => {
					throw new Error('fetch should not run');
				},
			}),
		/state/i,
	);
});

test('finishGitHubLogin stores an encrypted token and a github user', async () => {
	const nonce = 'nonce-login';
	const fetchImpl: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes('access_token')) {
			return Response.json({ access_token: 'gho_plain', refresh_token: 'ghr_plain', expires_in: 3600 });
		}
		if (url.endsWith('/user')) {
			return Response.json({ id: 99, login: 'octocat', avatar_url: 'https://example.test/a.png', name: 'Mona', email: 'mona@example.test' });
		}
		throw new Error(`unexpected ${url}`);
	};
	const user = await finishGitHubLogin({
		code: 'abc',
		state: sealState(nonce),
		nonce,
		db,
		client,
		fetchImpl,
		now: Date.parse('2026-09-30T00:00:00.000Z'),
	});
	assert.equal(user.userId, 'gh_99');
	assert.equal(user.login, 'octocat');
	const row = (
		await db.execute({ sql: 'SELECT access_token, refresh_token, needs_reconnect FROM oauth_tokens WHERE user_id = ?', args: ['gh_99'] })
	).rows[0] as Record<string, unknown>;
	assert.equal(String(row.access_token).includes('gho_plain'), false);
	assert.equal(decryptToken(String(row.access_token)), 'gho_plain');
	assert.equal(decryptToken(String(row.refresh_token)), 'ghr_plain');
	assert.equal(Number(row.needs_reconnect), 0);
});

test('ensureAccessToken refreshes an expired token and records a failed refresh', async () => {
	const now = Date.parse('2026-09-30T02:00:00.000Z');
	const fetchImpl: typeof fetch = async () => Response.json({ access_token: 'gho_new', refresh_token: 'ghr_new', expires_in: 60 });
	const token = await ensureAccessToken('gh_99', db, client, fetchImpl, now);
	assert.equal(token, 'gho_new');

	const failFetch: typeof fetch = async () => Response.json({ error: 'bad_refresh', error_description: 'expired' });
	await db.execute({
		sql: `UPDATE oauth_tokens SET expires_at = ? WHERE user_id = ?`,
		args: [new Date(now - 1000).toISOString(), 'gh_99'],
	});
	await assert.rejects(() => ensureAccessToken('gh_99', db, client, failFetch, now), GitHubReconnectError);
	const row = (await db.execute({ sql: 'SELECT needs_reconnect FROM oauth_tokens WHERE user_id = ?', args: ['gh_99'] })).rows[0] as Record<string, unknown>;
	assert.equal(Number(row.needs_reconnect), 1);
	await markGitHubReconnect('gh_99', db);
});

test('createGitHubProject clones once and sessions stay on that user', async () => {
	await db.execute({ sql: 'UPDATE oauth_tokens SET needs_reconnect = 0 WHERE user_id = ?', args: ['gh_99'] });
	const source = path.join(root, 'repo');
	await execFile('git', ['init', '-b', 'main', source]);
	await execFile('git', ['config', 'user.email', 'source@example.test'], { cwd: source });
	await execFile('git', ['config', 'user.name', 'Source'], { cwd: source });
	writeFileSync(path.join(source, 'README.md'), 'repo\n');
	await execFile('git', ['add', '.'], { cwd: source });
	await execFile('git', ['commit', '-m', 'init'], { cwd: source });

	const project = await createGitHubProject(
		{
			userId: 'gh_99',
			repoFullName: 'octocat/app',
			defaultBranch: 'main',
			token: 'gho_new',
			userName: 'Mona',
			userEmail: 'mona@example.test',
			cloneUrl: source,
			workspacesRoot: root,
		},
		db,
	);
	const again = await createGitHubProject(
		{
			userId: 'gh_99',
			repoFullName: 'octocat/app',
			defaultBranch: 'main',
			token: 'gho_new',
			userName: 'Mona',
			userEmail: 'mona@example.test',
			cloneUrl: source,
			workspacesRoot: root,
		},
		db,
	);
	assert.equal(again.id, project.id);
	assert.equal((await execFile('git', ['remote', 'get-url', 'origin'], { cwd: project.workspacePath })).stdout.includes('gho_new'), false);

	const session = await createSession({ projectId: project.id, title: 'GitHub chat' }, db);
	assert.equal(session.projectId, project.id);
	const own = await listSessions(db, 'gh_99');
	assert.equal(own.some((item) => item.id === session.id), true);
	const dev = await createSession({ title: 'Dev chat' }, db);
	const still = await listSessions(db, 'gh_99');
	assert.equal(still.some((item) => item.id === dev.id), false);
});
