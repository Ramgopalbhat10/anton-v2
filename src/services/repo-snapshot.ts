import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { safeRelativePath } from '../core/shell.ts';
import type { RepoFiles } from '../core/plugins.ts';
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
export const MAX_LISTED = 500;

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

/** A repo's files at `sha` for reading skills and plugins; files too large to keep read as missing. */
export async function snapshotFiles(repo: string, sha: string): Promise<RepoFiles> {
	const { dir, entries } = await snapshot(repo, sha);
	const stored = new Set(entries.filter((entry) => entry.stored).map((entry) => entry.path));
	return {
		paths: [...stored],
		read: async (file) => (stored.has(file) ? new Uint8Array(await readFile(path.join(dir, 'files', file))) : null),
	};
}

/** How long a branch or tag of another repository stays resolved to one commit, so follow-ups read the same files without asking GitHub again. */
const REF_MS = 10 * 60_000;
const refs = new Map<string, { sha: string; at: number }>();

/** `owner/name`, optionally `@` a branch, tag or commit; the default branch when none is given. */
export function parseRepo(text: string): { fullName: string; ref: string | null } {
	const match = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:@(.+))?\/?$/.exec(text.trim());
	if (!match) throw new InvalidInputError(`"${text}" is not a repository: give it as owner/name, optionally @branch, tag or commit.`);
	return { fullName: match[1], ref: match[2]?.trim() || null };
}

async function commitOf(fullName: string, ref: string | null): Promise<string> {
	if (ref && /^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
	const key = `${fullName.toLowerCase()}@${ref ?? ''}`;
	const known = refs.get(key);
	if (known && Date.now() - known.at < REF_MS) return known.sha;
	const { git } = getProviders();
	let sha: string;
	try {
		sha = await git.resolveRef(fullName, ref ?? (await git.getRepo(fullName)).defaultBranch);
	} catch (error) {
		throw new NotFoundError(`Could not read ${fullName}${ref ? `@${ref}` : ''}: ${error instanceof Error ? error.message : String(error)}. Check the name, or that GitHub access covers it.`);
	}
	refs.set(key, { sha, at: Date.now() });
	return sha;
}

/**
 * The snapshot the repo tools read: the task's repository at its base commit, or, given `repo`, any GitHub
 * repository the token can read, so studying another codebase is one download and then local reads.
 */
async function snapshotFor(id: string, repo?: string): Promise<Snapshot> {
	const session = await getSessionRecord(id);
	if (!session) throw new NotFoundError('Session not found');
	const project = session.projectId ? await getProject(session.projectId) : null;
	if (repo?.trim()) {
		const { fullName, ref } = parseRepo(repo);
		if (!ref && project && fullName.toLowerCase() === project.repoFullName.toLowerCase()) return snapshot(project.repoFullName, session.baseSha);
		return snapshot(fullName, await commitOf(fullName, ref));
	}
	if (!session.projectId) throw new InvalidInputError('A chat has no repository to read: give repo as owner/name to read a GitHub repository.');
	if (!project) throw new NotFoundError('Session not found');
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

type Filter = { path?: string; glob?: string; repo?: string };

/** Entries under `folder` (or that file), matching `glob` from that folder down, as a search run in that folder matches it. */
function select(entries: Entry[], { path: folder, glob }: Filter): Entry[] {
	const relative = folder ? safeRelativePath(folder) : '';
	const prefix = relative && relative !== '.' ? `${relative}/` : '';
	const pattern = glob ? globToRegExp(glob) : null;
	return entries.filter((entry) =>
		entry.path === relative ? !pattern || pattern.test(entry.path) : entry.path.startsWith(prefix) && (!pattern || pattern.test(entry.path.slice(prefix.length))),
	);
}

/** Paths in the repo at the task's base commit, optionally under a folder or matching a glob. */
export async function listRepoFiles(id: string, filter: Filter): Promise<string> {
	const picked = select((await snapshotFor(id, filter.repo)).entries, filter);
	if (picked.length === 0) return 'No files match.';
	const lines = picked.slice(0, MAX_LISTED).map((entry) => (entry.kind === 'symlink' ? `${entry.path} -> ${entry.target}` : entry.path));
	const more = picked.length - MAX_LISTED;
	return more > 0 ? `${lines.join('\n')}\n(${more} more; narrow it with path or glob)` : lines.join('\n');
}

/** A file's bytes, or why it cannot be read. */
async function fileBytes(id: string, file: string, repo?: string): Promise<{ bytes: Uint8Array } | { problem: string }> {
	const { dir, entries } = await snapshotFor(id, repo);
	const wanted = safeRelativePath(file);
	const entry = entries.find((item) => item.path === wanted);
	if (!entry) {
		const folder = entries.some((item) => item.path.startsWith(`${wanted}/`));
		return { problem: folder ? `${wanted} is a folder. List its files with glob.` : `${wanted} does not exist. List files to find the right path.` };
	}
	if (entry.kind === 'symlink') return { problem: `${wanted} is a link to ${entry.target}.` };
	if (!entry.stored) return { problem: `${wanted} is ${entry.size} bytes, too large to read without a workspace.` };
	return { bytes: new Uint8Array(await readFile(path.join(dir, 'files', wanted))) };
}

/** A file's whole text, or why it cannot be read. */
async function fileText(id: string, file: string, repo?: string): Promise<{ text: string } | { problem: string }> {
	const read = await fileBytes(id, file, repo);
	if ('problem' in read) return read;
	const text = new TextDecoder().decode(read.bytes);
	return text.includes('\0') ? { problem: `${safeRelativePath(file)} is a binary file.` } : { text };
}

/** A file of the snapshot as bytes, for an image; throws with why it cannot be read. */
export async function repoBytes(id: string, file: string, repo?: string): Promise<Uint8Array> {
	const read = await fileBytes(id, file, repo);
	if ('problem' in read) throw new Error(read.problem);
	return read.bytes;
}

/** For run_script programs: every matching path, as a list. */
export async function repoPaths(id: string, filter: Filter): Promise<string[]> {
	return select((await snapshotFor(id, filter.repo)).entries, filter).map((entry) => entry.path);
}

/** For run_script programs: a file's whole text; throws when it cannot be read. */
export async function repoText(id: string, file: string, repo?: string): Promise<string> {
	const read = await fileText(id, file, repo);
	if ('problem' in read) throw new Error(read.problem);
	return read.text;
}

/** Lines a read shows when it names no limit, and at most. */
export const READ_LINES = 400;
export const MAX_READ_LINES = 2000;
/** A longer line (minified code, a data blob) is cut, so one line cannot fill the context. */
const MAX_LINE_CHARS = 2000;

/** A text's lines numbered from `offset`, number and tab first, saying how to read on when more follow: the same for the snapshot and the sandbox. */
export function numberedLines(text: string, offset = 1, limit = READ_LINES): string {
	const lines = text.split('\n');
	const start = Math.max(1, offset);
	if (start > lines.length) return `(the file has ${lines.length} lines; offset ${start} is past its end)`;
	const shown = lines.slice(start - 1, start - 1 + limit);
	const cut = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… (line cut at ${MAX_LINE_CHARS} characters)` : line);
	const numbered = shown.map((line, index) => `${start + index}\t${cut(line)}`).join('\n');
	const end = start + shown.length - 1;
	return end < lines.length ? `${numbered}\n(lines ${start}-${end} of ${lines.length}; read on with offset ${end + 1})` : numbered;
}

/** A file's lines, numbered from `offset`. */
export async function readRepoFile(id: string, file: string, offset = 1, limit = READ_LINES, repo?: string): Promise<string> {
	const read = await fileText(id, file, repo);
	if ('problem' in read) return read.problem;
	return numberedLines(read.text, offset, limit);
}

/**
 * Runs in a worker thread, so a pattern that backtracks without end can be
 * stopped without stalling Anton. Matches come as `path:line: text`; with
 * context, the lines around them as `path-line- text` and `--` between groups,
 * as rg and grep print them.
 */
const SEARCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const { dir, files, pattern, flags, max, context, filesOnly } = workerData;
const regex = new RegExp(pattern, flags);
const show = (line) => (context ? line.trimEnd() : line.trim()).slice(0, 300);
const out = [];
let found = 0;
let more = false;
for (const file of files) {
	let text;
	try { text = readFileSync(dir + '/files/' + file, 'utf8'); } catch { continue; }
	if (text.includes('\\u0000')) continue;
	const lines = text.split('\\n');
	const hits = new Set();
	for (let index = 0; index < lines.length; index += 1) if (regex.test(lines[index].slice(0, 2000))) hits.add(index);
	if (!hits.size) continue;
	if (filesOnly) {
		if (found === max) { more = true; break; }
		found += 1;
		out.push(file);
		continue;
	}
	let last = -1;
	for (const hit of hits) {
		if (found === max) { more = true; break; }
		found += 1;
		const from = Math.max(hit - context, last + 1);
		if (context && out.length && (last === -1 || from > last + 1)) out.push('--');
		for (let index = from; index < hit; index += 1) out.push(file + '-' + (index + 1) + '- ' + show(lines[index]));
		out.push(file + ':' + (hit + 1) + ': ' + show(lines[hit]));
		last = hit;
		for (let index = hit + 1; index <= Math.min(lines.length - 1, hit + context) && !hits.has(index); index += 1) {
			out.push(file + '-' + (index + 1) + '- ' + show(lines[index]));
			last = index;
		}
	}
	if (more) break;
}
parentPort.postMessage({ lines: out, more });
`;

/** Matches a search shows at most, or files with filesOnly; past them it says how to narrow it. */
export const MAX_MATCHES = 200;
export const MAX_FILES = 500;
export const NARROW_SEARCH = '(more matches; narrow the search with path or glob)';
export const NARROW_FILES = '(more files match; narrow the search with path or glob)';

export type SearchInput = Filter & { pattern: string; ignoreCase?: boolean; context?: number; filesOnly?: boolean };

/** Lines matching a regular expression, as `path:line: text`, with `context` lines around each; or, with `filesOnly`, the files that have one. */
export async function searchRepo(id: string, input: SearchInput): Promise<string> {
	const { dir, entries } = await snapshotFor(id, input.repo);
	const flags = input.ignoreCase ? 'i' : '';
	try {
		new RegExp(input.pattern, flags);
	} catch (error) {
		return `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`;
	}
	const files = select(entries, input)
		.filter((entry) => entry.stored)
		.map((entry) => entry.path);
	const filesOnly = Boolean(input.filesOnly);
	const workerData = { dir, files, pattern: input.pattern, flags, max: filesOnly ? MAX_FILES : MAX_MATCHES, context: filesOnly ? 0 : (input.context ?? 0), filesOnly };
	const worker = new Worker(SEARCH_WORKER, { eval: true, workerData });
	const result = await new Promise<{ lines: string[]; more: boolean } | null>((resolve, reject) => {
		const timer = setTimeout(() => resolve(null), SEARCH_TIMEOUT_MS);
		worker.once('message', (message: { lines: string[]; more: boolean }) => {
			clearTimeout(timer);
			resolve(message);
		});
		worker.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	}).finally(() => void worker.terminate());
	if (!result) return 'The search took too long. Use a simpler pattern, or narrow it with path or glob.';
	if (result.lines.length === 0) return 'No matches.';
	return result.more ? `${result.lines.join('\n')}\n${filesOnly ? NARROW_FILES : NARROW_SEARCH}` : result.lines.join('\n');
}
