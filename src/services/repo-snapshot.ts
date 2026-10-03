import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config.ts';
import { NotFoundError } from '../core/errors.ts';
import { safeRelativePath } from '../core/shell.ts';
import { readTar } from '../core/tar.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';

/**
 * A read-only copy of a repo at one commit, on Anton's own disk. It lets the
 * agent answer questions about the code without a sandbox, a clone or a
 * branch; one download serves every task on that commit.
 */
type Entry = { path: string; size: number; kind: 'file' | 'symlink'; stored: boolean; target?: string };
type Snapshot = { dir: string; entries: Entry[] };

/** Larger files are listed but not kept: questions rarely need them, and a workspace can read them. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
/** Snapshots kept on disk, most recently used first. */
const KEEP = 10;
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_MATCHES = 200;
const MAX_LISTED = 500;

const root = () => path.join(config.dataDir, 'snapshots');
const INDEX = 'index.json';
const loaded = new Map<string, Promise<Snapshot>>();

/** Unpacks the archive into `dir`, keeping only regular files under the size limit and never following a link. */
async function unpack(repo: string, sha: string, dir: string): Promise<Entry[]> {
	const archive = await getProviders().git.archive(repo, sha);
	const entries: Entry[] = [];
	let total = 0;
	for await (const entry of readTar(archive.pipeThrough(new DecompressionStream('gzip')), MAX_FILE_BYTES)) {
		// Entries sit under one top-level folder named after the commit.
		const inner = entry.path.split('/').slice(1).join('/');
		if (!inner || (entry.kind !== 'file' && entry.kind !== 'symlink')) continue;
		let relative: string;
		try {
			relative = safeRelativePath(inner);
		} catch {
			continue;
		}
		if (entry.kind === 'symlink') {
			entries.push({ path: relative, size: 0, kind: 'symlink', stored: false, target: entry.target ?? '' });
			continue;
		}
		total += entry.size;
		if (total > MAX_TOTAL_BYTES) throw new Error('This repository is too large to read without a workspace.');
		const stored = entry.content !== null;
		if (entry.content) {
			const target = path.join(dir, 'files', relative);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, entry.content);
		}
		entries.push({ path: relative, size: entry.size, kind: 'file', stored });
	}
	return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Removes all but the most recently used snapshots. */
async function evict(): Promise<void> {
	const names = await readdir(root()).catch(() => [] as string[]);
	const used = await Promise.all(
		names.map(async (name) => ({ name, at: (await stat(path.join(root(), name, INDEX)).catch(() => null))?.mtimeMs ?? 0 })),
	);
	const stale = used.sort((a, b) => b.at - a.at).slice(KEEP);
	await Promise.all(stale.map(({ name }) => rm(path.join(root(), name), { recursive: true, force: true })));
	for (const { name } of stale) loaded.delete(name);
}

async function build(repo: string, sha: string, key: string): Promise<Snapshot> {
	const dir = path.join(root(), key);
	const index = path.join(dir, INDEX);
	const existing = await readFile(index, 'utf8').catch(() => null);
	if (existing) {
		const now = new Date();
		await utimes(index, now, now).catch(() => undefined);
		return { dir, entries: JSON.parse(existing) as Entry[] };
	}
	// Built aside and moved into place whole, so a half-written snapshot is never read.
	const partial = `${dir}.partial-${process.pid}-${Date.now()}`;
	try {
		const entries = await unpack(repo, sha, partial);
		await mkdir(partial, { recursive: true });
		await writeFile(path.join(partial, INDEX), JSON.stringify(entries));
		await rm(dir, { recursive: true, force: true });
		await rename(partial, dir);
		await evict();
		return { dir, entries };
	} finally {
		await rm(partial, { recursive: true, force: true });
	}
}

/** The snapshot of `repo` at `sha`, downloaded on first use. */
export function snapshot(repo: string, sha: string): Promise<Snapshot> {
	const key = `${repo.replace('/', '__')}@${sha}`;
	let pending = loaded.get(key);
	if (!pending) {
		pending = build(repo, sha, key);
		loaded.set(key, pending);
		pending.catch(() => loaded.delete(key));
	}
	return pending;
}

async function snapshotFor(id: string): Promise<Snapshot> {
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	if (!session || !project) throw new NotFoundError('Session not found');
	return snapshot(project.repoFullName, session.baseSha);
}

/** A glob as a regular expression: `**` crosses folders, `*` and `?` do not, `{a,b}` picks one. */
export function globToRegExp(glob: string): RegExp {
	let out = '';
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];
		if (char === '*' && glob[index + 1] === '*') {
			out += glob[index + 2] === '/' ? '(?:.*/)?' : '.*';
			index += glob[index + 2] === '/' ? 2 : 1;
		} else if (char === '*') out += '[^/]*';
		else if (char === '?') out += '[^/]';
		else if (char === '{') out += '(?:';
		else if (char === '}') out += ')';
		else if (char === ',') out += '|';
		else out += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
	}
	// A pattern without a folder matches the file name anywhere, as most tools do.
	return new RegExp(glob.includes('/') ? `^${out}$` : `(?:^|/)${out}$`);
}

type Filter = { path?: string; glob?: string };

function select(entries: Entry[], { path: folder, glob }: Filter): Entry[] {
	const prefix = folder ? `${safeRelativePath(folder)}/` : '';
	const pattern = glob ? globToRegExp(glob) : null;
	return entries.filter((entry) => entry.path.startsWith(prefix) && (!pattern || pattern.test(entry.path)));
}

/** Paths in the repo at the task's base commit, optionally under a folder or matching a glob. */
export async function listRepoFiles(id: string, filter: Filter): Promise<string> {
	const picked = select((await snapshotFor(id)).entries, filter);
	if (picked.length === 0) return 'No files match.';
	const lines = picked.slice(0, MAX_LISTED).map((entry) => (entry.kind === 'symlink' ? `${entry.path} -> ${entry.target}` : entry.path));
	const more = picked.length - MAX_LISTED;
	return more > 0 ? `${lines.join('\n')}\n(${more} more; narrow it with path or glob)` : lines.join('\n');
}

/** A file's lines, numbered from `offset`. */
export async function readRepoFile(id: string, file: string, offset = 1, limit = 400): Promise<string> {
	const { dir, entries } = await snapshotFor(id);
	const wanted = safeRelativePath(file);
	const entry = entries.find((item) => item.path === wanted);
	if (!entry) return `${wanted} does not exist. List files to find the right path.`;
	if (entry.kind === 'symlink') return `${wanted} is a link to ${entry.target}.`;
	if (!entry.stored) return `${wanted} is ${entry.size} bytes, too large to read without a workspace.`;
	const text = await readFile(path.join(dir, 'files', wanted), 'utf8');
	if (text.includes('\0')) return `${wanted} is a binary file.`;
	const lines = text.split('\n');
	const start = Math.max(1, offset);
	const shown = lines.slice(start - 1, start - 1 + limit);
	const numbered = shown.map((line, index) => `${start + index}\t${line}`).join('\n');
	const end = start + shown.length - 1;
	return end < lines.length ? `${numbered}\n(lines ${start}-${end} of ${lines.length}; read on with offset ${end + 1})` : numbered;
}

/**
 * Runs in a worker thread, so a pattern that backtracks without end can be
 * stopped without stalling Anton.
 */
const SEARCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const { dir, files, pattern, flags, max } = workerData;
const regex = new RegExp(pattern, flags);
const matches = [];
let more = false;
for (const file of files) {
	let text;
	try { text = readFileSync(dir + '/files/' + file, 'utf8'); } catch { continue; }
	if (text.includes('\\u0000')) continue;
	const lines = text.split('\\n');
	for (let index = 0; index < lines.length && !more; index += 1) {
		const line = lines[index].slice(0, 2000);
		if (!regex.test(line)) continue;
		if (matches.length === max) more = true;
		else matches.push(file + ':' + (index + 1) + ': ' + line.trim().slice(0, 300));
	}
	if (more) break;
}
parentPort.postMessage({ matches, more });
`;

/** Lines matching a regular expression, as `path:line: text`. */
export async function searchRepo(id: string, input: Filter & { pattern: string; ignoreCase?: boolean }): Promise<string> {
	const { dir, entries } = await snapshotFor(id);
	const flags = input.ignoreCase ? 'i' : '';
	try {
		new RegExp(input.pattern, flags);
	} catch (error) {
		return `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`;
	}
	const files = select(entries, input)
		.filter((entry) => entry.stored)
		.map((entry) => entry.path);
	const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: { dir, files, pattern: input.pattern, flags, max: MAX_MATCHES } });
	const result = await new Promise<{ matches: string[]; more: boolean } | null>((resolve, reject) => {
		const timer = setTimeout(() => resolve(null), SEARCH_TIMEOUT_MS);
		worker.once('message', (message: { matches: string[]; more: boolean }) => {
			clearTimeout(timer);
			resolve(message);
		});
		worker.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	}).finally(() => void worker.terminate());
	if (!result) return 'The search took too long. Use a simpler pattern, or narrow it with path or glob.';
	if (result.matches.length === 0) return 'No matches.';
	return result.more ? `${result.matches.join('\n')}\n(more matches; narrow the search)` : result.matches.join('\n');
}
