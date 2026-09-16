import { execFile as execFileCb } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export type GitLogEntry = {
	sha: string;
	subject: string;
	at: string;
};

export type GitStatus = {
	branch: string;
	upstream: string | null;
	ahead: number;
	behind: number;
	patch: string;
	log: GitLogEntry[];
};

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
		return { stdout, stderr, code: 0 };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; code?: number };
		return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
	}
}

export async function listPaths(cwd: string, dir = cwd, acc: string[] = []): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'data') continue;
		const full = path.join(dir, entry.name);
		const rel = path.relative(cwd, full).split(path.sep).join('/');
		if (entry.isDirectory()) {
			await listPaths(cwd, full, acc);
		} else {
			acc.push(rel);
		}
	}
	return acc;
}

export async function readWorkspaceFile(cwd: string, relPath: string): Promise<string> {
	const resolved = path.resolve(cwd, relPath);
	if (!resolved.startsWith(path.resolve(cwd))) {
		throw new Error('Path escapes workspace');
	}
	const info = await stat(resolved);
	if (!info.isFile()) throw new Error('Not a file');
	if (info.size > 1_000_000) throw new Error('File too large to preview');
	return readFile(resolved, 'utf8');
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
	const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main';
	const upstreamRaw = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
	const upstream = upstreamRaw.code === 0 ? upstreamRaw.stdout.trim() : null;

	let ahead = 0;
	let behind = 0;
	if (upstream) {
		const counts = (await git(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).stdout.trim();
		const [behindText, aheadText] = counts.split(/\s+/);
		behind = Number(behindText || 0);
		ahead = Number(aheadText || 0);
	}

	const diffRange = upstream ? `${upstream}...HEAD` : 'HEAD';
	const unstaged = (await git(cwd, ['diff'])).stdout;
	const staged = (await git(cwd, ['diff', '--cached'])).stdout;
	const vsUpstream = upstream ? (await git(cwd, ['diff', diffRange])).stdout : '';
	const patch = [vsUpstream, staged, unstaged].filter(Boolean).join('\n') || (await git(cwd, ['diff', 'HEAD'])).stdout;

	const logOut = (await git(cwd, ['log', '-20', '--format=%H%x09%s%x09%cI'])).stdout.trim();
	const log: GitLogEntry[] = logOut
		? logOut.split('\n').map((line) => {
				const [sha, subject, at] = line.split('\t');
				return { sha, subject, at };
			})
		: [];

	return { branch, upstream, ahead, behind, patch, log };
}

export async function createLocalPullRequest(cwd: string, title: string): Promise<string> {
	const status = await git(cwd, ['status', '--porcelain']);
	if (status.stdout.trim()) {
		await git(cwd, ['add', '-A']);
		await git(cwd, ['commit', '-m', title || 'feat: anton agent changes']);
	}
	const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
	const sha = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
	return `local://${branch}/${sha}`;
}
