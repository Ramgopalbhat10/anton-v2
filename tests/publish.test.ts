import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import { GitHubReconnectError } from '../src/lib/github.ts';
import { migrateAppDb } from '../src/lib/db-app.ts';
import { createGitHubProject, createSession, getSession } from '../src/lib/sessions.ts';
import { publishPullRequest } from '../src/lib/vm-proxy.ts';

const execFile = promisify(execFileCb);
const root = mkdtempSync(path.join(tmpdir(), 'anton-pr-'));
const db = createClient({ url: `file:${path.join(root, 'anton.db')}` });

after(() => {
	rmSync(root, { recursive: true, force: true });
});

async function gitRepo(name: string): Promise<string> {
	const cwd = path.join(root, name);
	await execFile('git', ['init', '-b', 'main', cwd]);
	await execFile('git', ['config', 'user.email', 'anton@example.test'], { cwd });
	await execFile('git', ['config', 'user.name', 'Anton'], { cwd });
	writeFileSync(path.join(cwd, 'README.md'), 'hello\n');
	await execFile('git', ['add', '.'], { cwd });
	await execFile('git', ['commit', '-m', 'init'], { cwd });
	return cwd;
}

test('publishPullRequest returns a local url when the workspace has no GitHub token', async () => {
	const cwd = await gitRepo('local');
	writeFileSync(path.join(cwd, 'note.txt'), 'change\n');
	const url = await publishPullRequest({
		cwd,
		title: 'feat: local',
		token: null,
		repoFullName: null,
		defaultBranch: 'main',
	});
	assert.match(url, /^local:\/\/main\//);
	assert.equal((await execFile('git', ['status', '--porcelain'], { cwd })).stdout, '');
});

test('publishPullRequest pushes a branch and stores the pull request on that project', async () => {
	await migrateAppDb(db);
	await db.execute({
		sql: `INSERT INTO users (id, github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)`,
		args: ['gh_7', '7', 'octocat', null, new Date().toISOString()],
	});
	const origin = path.join(root, 'origin.git');
	await execFile('git', ['init', '--bare', '-b', 'main', origin]);
	const source = await gitRepo('source');
	await execFile('git', ['remote', 'add', 'origin', origin], { cwd: source });
	await execFile('git', ['push', '-u', 'origin', 'main'], { cwd: source });

	const project = await createGitHubProject(
		{
			userId: 'gh_7',
			repoFullName: 'octocat/app',
			defaultBranch: 'main',
			token: null,
			userName: 'Mona',
			userEmail: 'mona@example.test',
			cloneUrl: source,
			workspacesRoot: root,
		},
		db,
	);
	await execFile('git', ['remote', 'set-url', 'origin', origin], { cwd: project.workspacePath });
	writeFileSync(path.join(project.workspacePath, 'change.txt'), 'edit\n');
	const session = await createSession({ projectId: project.id, title: 'PR' }, db);

	let seen: { title?: string; head?: string; base?: string; authorization?: string } = {};
	const url = await publishPullRequest({
		cwd: project.workspacePath,
		title: 'feat: anton',
		token: 'gho_push',
		repoFullName: 'octocat/app',
		defaultBranch: 'main',
		fetchImpl: async (input, init) => {
			seen = {
				...JSON.parse(String(init?.body)),
				authorization: (init?.headers as Record<string, string>).Authorization,
			};
			assert.equal(String(input), 'https://api.github.com/repos/octocat/app/pulls');
			return Response.json({ html_url: 'https://github.com/octocat/app/pull/8', number: 8 });
		},
	});

	assert.equal(url, 'https://github.com/octocat/app/pull/8');
	assert.equal(seen.base, 'main');
	assert.equal(seen.title, 'feat: anton');
	assert.match(seen.head ?? '', /^anton\//);
	assert.equal(seen.authorization, 'Bearer gho_push');
	const remote = (await execFile('git', ['remote', 'get-url', 'origin'], { cwd: project.workspacePath })).stdout;
	assert.equal(remote.includes('gho_push'), false);
	const branch = (await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.workspacePath })).stdout.trim();
	const pushed = (await execFile('git', ['rev-parse', branch], { cwd: origin })).stdout.trim();
	assert.equal(pushed.length > 0, true);
	await import('../src/lib/sessions.ts').then(async (sessions) => {
		await sessions.attachPullRequest(project.workspacePath, url, db);
	});
	const stored = await getSession(session.id, db);
	assert.equal(stored?.prUrl, url);
});

test('publishPullRequest throws when GitHub rejects the token', async () => {
	const cwd = await gitRepo('expired');
	const origin = path.join(root, 'expired.git');
	await execFile('git', ['init', '--bare', '-b', 'main', origin]);
	await execFile('git', ['remote', 'add', 'origin', origin], { cwd });
	await execFile('git', ['push', '-u', 'origin', 'main'], { cwd });
	writeFileSync(path.join(cwd, 'more.txt'), 'x\n');
	await assert.rejects(
		() =>
			publishPullRequest({
				cwd,
				title: 'feat: expired',
				token: 'gho_old',
				repoFullName: 'octocat/app',
				defaultBranch: 'main',
				fetchImpl: async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
			}),
		GitHubReconnectError,
	);
});
