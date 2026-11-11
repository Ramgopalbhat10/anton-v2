import path from 'node:path';
import { NotFoundError } from '../core/errors.ts';
import { readMachineFile } from '../core/machine-fs.ts';
import type { Machine } from '../core/ports.ts';
import { redactor } from '../core/redact.ts';
import { quote, text } from '../core/shell.ts';
import { hasWorkspace, noteWorkspace } from './agent-runner.ts';
import {
	globToRegExp,
	listRepoFiles,
	MAX_FILES,
	MAX_LISTED,
	MAX_MATCHES,
	NARROW_FILES,
	NARROW_SEARCH,
	numberedLines,
	READ_LINES,
	readRepoFile,
	repoBytes,
	repoPaths,
	repoText,
	type SearchInput,
	searchRepo,
} from './repo-snapshot.ts';
import { runnerOf } from './runners.ts';
import { secretsToHide } from './secrets.ts';
import { machineFor } from './workspace.ts';

/*
 * What a repository task's read, grep and glob answer from. Until the task has
 * its workspace they read the snapshot of the repository at the commit it
 * started from, so a task that only reads never needs a machine; once it has one
 * (it had a machine in an earlier reply, or this reply ran a command or changed a
 * file) they read the machine, which holds its changes, even when it has stopped
 * and must start again. A path outside the repository (/tmp, ../outputs) is only
 * in the machine. `repo` names another GitHub repository, always read from its own
 * snapshot. The tools' schemas and output are the same whichever answers.
 */

export type Deps = {
	/** Whether the task's files are in its machine now. */
	workspace: (id: string) => boolean;
	/** The task's machine, started or waited for. */
	machine: (id: string) => Promise<Machine>;
	secrets: (id: string) => Promise<Record<string, string>>;
	/** The repository folder in the task's machine, known before the machine starts. */
	root: (id: string) => Promise<string>;
};

/** The repository folder a task's machine has or will have, `repoDir` of it, without starting it. */
export async function taskRoot(id: string): Promise<string> {
	const runner = await runnerOf(id);
	if (!runner) throw new NotFoundError('Session not found');
	return `${runner.rootOf(id)}/repo`;
}

// Called through, not taken at load: workspace.ts and agent-runner.ts import modules that import this one.
const defaults: Deps = {
	workspace: (id) => hasWorkspace(id),
	machine: (id) => machineFor(id),
	secrets: (id) => secretsToHide(id),
	root: (id) => taskRoot(id),
};

/** The task's machine for work that may change its files: from now on its reads come from there. */
export async function workMachine(id: string, deps: Partial<Deps> = {}): Promise<Machine> {
	const machine = await (deps.machine ?? defaults.machine)(id);
	noteWorkspace(id);
	return machine;
}

type Place = { snapshot: string } | { machine: string };

/** Where a path is read: the snapshot for a path in the repository while the task has no workspace, else the machine. */
async function placeOf(id: string, file: string, d: Deps): Promise<Place> {
	const root = await d.root(id);
	const absolute = path.posix.resolve(root, file);
	const inside = absolute === root || absolute.startsWith(`${root}/`);
	if (inside && !d.workspace(id)) return { snapshot: path.posix.relative(root, absolute) || '.' };
	return { machine: absolute };
}

/** How a path in the machine shows in results: from the repository's root when it is in it. */
function shown(root: string, absolute: string): string {
	return absolute === root ? '.' : absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
}

export type ReadInput = { path: string; offset?: number; limit?: number; repo?: string };

/** A file's lines, numbered from `offset`, or why it cannot be read. */
export async function readTaskFile(id: string, input: ReadInput, deps: Partial<Deps> = {}): Promise<string> {
	const d = { ...defaults, ...deps };
	const { offset = 1, limit = READ_LINES } = input;
	if (input.repo) return readRepoFile(id, input.path, offset, limit, input.repo);
	const place = await placeOf(id, input.path, d);
	if ('snapshot' in place) return readRepoFile(id, place.snapshot, offset, limit);
	const machine = await d.machine(id);
	const where = shown(await d.root(id), place.machine);
	let bytes: Uint8Array;
	try {
		bytes = await readMachineFile(machine, place.machine);
	} catch {
		const kind = text((await machine.exec(`if test -d ${quote(place.machine)}; then echo folder; elif test -e ${quote(place.machine)}; then echo other; fi`)).stdout).trim();
		if (kind === 'folder') return `${where} is a folder. List its files with glob.`;
		return kind ? `${where} could not be read.` : `${where} does not exist. List files to find the right path.`;
	}
	const content = text(bytes);
	return content.includes('\0') ? `${where} is a binary file.` : numberedLines(content, offset, limit);
}

/** A file's bytes, for an image; throws with why it cannot be read. */
export async function taskFileBytes(id: string, file: string, repo?: string, deps: Partial<Deps> = {}): Promise<Uint8Array> {
	const d = { ...defaults, ...deps };
	if (repo) return repoBytes(id, file, repo);
	const place = await placeOf(id, file, d);
	return 'snapshot' in place ? repoBytes(id, place.snapshot) : readMachineFile(await d.machine(id), place.machine);
}

export type GrepInput = SearchInput;

/** Output a search may send back from the machine at most, in lines, so a pattern that matches everything stays small. */
const MAX_OUTPUT_LINES = 5_000;
const SEARCH_TIMEOUT_MS = 60_000;

/**
 * A glob as an extended regular expression over paths, for `grep -E`: the snapshot's own glob, so both sides pick the
 * same files. rg's `-g` is not used: a glob that matches a folder's name (`*`, `src/**`) brings back what .gitignore
 * leaves out, node_modules and all.
 */
export const globPattern = (glob: string) => globToRegExp(glob).source.replaceAll('(?:', '(');

/** Runs `rg` when the machine has it, else `other`; the first line says which ran. */
const either = (rg: string, other: string, name: string, tool: 'auto' | 'rg' | string) =>
	tool === 'rg' ? `echo @rg; ${rg}` : tool === name ? `echo @${name}; ${other}` : `if command -v rg >/dev/null 2>&1; then echo @rg; ${rg}; else echo @${name}; ${other}; fi`;

/**
 * The machine's search, as one command run from the repository's root on `target` (from that root, or absolute):
 * rg when the machine has it (it honours .gitignore, so node_modules and build output stay out, and reads dotfiles
 * but not .git), else grep. A folder is searched from inside it, so a glob is matched from there as the snapshot
 * matches it. The first lines say whether `target` was a folder (paths then start from it) and which tool ran.
 * Every rg names what it searches: given none, with no terminal, it reads its input instead.
 */
export function searchCommand(input: GrepInput, target: string, tool: 'auto' | 'rg' | 'grep' = 'auto'): string {
	const context = !input.filesOnly && input.context ? ` -C ${Math.max(0, Math.floor(input.context))}` : '';
	const rgSearch = [
		'rg --no-heading --with-filename --line-number --color never --hidden',
		input.filesOnly ? ' --files-with-matches' : ' --null',
		input.ignoreCase ? ' --ignore-case' : '',
		context,
		` -g '!.git' -e ${quote(input.pattern)} --`,
	].join('');
	const rg = input.glob
		? `rg --files --hidden -g '!.git' -- "\${@:-.}" | sed 's|^\\./||' | grep -E ${quote(globPattern(input.glob))} | xargs -d '\\n' -r ${rgSearch}`
		: `${rgSearch} "\${@:-.}"`;
	const grep = [
		'grep -rIHnE --exclude-dir=.git --exclude-dir=node_modules',
		input.filesOnly ? ' -l' : ' -Z',
		input.ignoreCase ? ' -i' : '',
		context,
		` -e ${quote(input.pattern)} -- "\${@:-.}"`,
	].join('');
	return `if test -d ${quote(target)}; then cd -- ${quote(target)} && echo @dir && set --; else echo @file; set -- ${quote(target)}; fi; { ${either(rg, grep, 'grep', tool)}; } | head -n ${MAX_OUTPUT_LINES + 2}`;
}

/** A matched or context line as the snapshot shows it: indentation dropped unless there is context to line it up with, and cut. */
const lineText = (line: string, context: boolean) => (context ? line.trimEnd() : line.trim()).slice(0, 300);

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Hit = { file: string; line: number; match: boolean; text: string };

/**
 * The machine's search output in the snapshot's form and order: files by path, `path:line: text`, context as
 * `path-line- text`, `--` between groups, and past the cap how to narrow it. rg and grep each print files in the
 * order they find them.
 */
export function searchResult(output: string, input: GrepInput, prefix: string): string {
	const [where = '', tool = '', ...rest] = output.split('\n');
	const lines = rest.filter(Boolean);
	let more = lines.length > MAX_OUTPUT_LINES;
	const named = (file: string) => {
		const bare = file.replace(/^\.\//, '');
		return where === '@dir' && prefix ? `${prefix}/${bare}` : bare;
	};
	// grep has no globs that cross folders, so its results are filtered here, as the snapshot filters; rg's were already.
	const pattern = tool === '@grep' && input.glob ? globToRegExp(input.glob) : null;
	const wanted = (file: string) => !pattern || pattern.test(file.replace(/^\.\//, ''));
	if (input.filesOnly) {
		const found = lines.filter(wanted).map(named).sort(byPath);
		if (!found.length) return 'No matches.';
		return found.length > MAX_FILES || more ? `${found.slice(0, MAX_FILES).join('\n')}\n${NARROW_FILES}` : found.join('\n');
	}
	const hits: Hit[] = [];
	for (const line of lines) {
		const nul = line.indexOf('\0');
		const parts = nul >= 0 ? /^(\d+)([:-])(.*)$/s.exec(line.slice(nul + 1)) : null;
		const file = nul >= 0 ? line.slice(0, nul) : '';
		if (parts && wanted(file)) hits.push({ file: named(file), line: Number(parts[1]), match: parts[2] === ':', text: parts[3] });
	}
	hits.sort((a, b) => byPath(a.file, b.file) || a.line - b.line);
	const context = input.context ?? 0;
	const out: string[] = [];
	let found = 0;
	let last: Hit | undefined;
	for (const hit of hits) {
		if (hit.match && found === MAX_MATCHES) {
			more = true;
			break;
		}
		if (hit.match) found += 1;
		if (context && last && (last.file !== hit.file || hit.line > last.line + 1)) out.push('--');
		out.push(`${hit.file}${hit.match ? ':' : '-'}${hit.line}${hit.match ? ':' : '-'} ${lineText(hit.text, Boolean(context))}`);
		last = hit;
	}
	// The context before a match past the cap is not shown, as the snapshot shows none.
	const kept = hits.slice(0, out.filter((line) => line !== '--').length);
	const lastMatch = kept.findLast((hit) => hit.match);
	while (more && kept.length && !kept.at(-1)!.match && (kept.at(-1)!.file !== lastMatch?.file || kept.at(-1)!.line > lastMatch.line + context)) {
		kept.pop();
		out.pop();
		while (out.at(-1) === '--') out.pop();
	}
	if (!found) return 'No matches.';
	return more ? `${out.join('\n')}\n${NARROW_SEARCH}` : out.join('\n');
}

/** Lines matching a regular expression, with context around them, or the files that have one. */
export async function grepTask(id: string, input: GrepInput, deps: Partial<Deps> = {}): Promise<string> {
	const d = { ...defaults, ...deps };
	if (input.repo) return searchRepo(id, input);
	const place = await placeOf(id, input.path ?? '.', d);
	if ('snapshot' in place) return searchRepo(id, { ...input, path: place.snapshot === '.' ? undefined : place.snapshot });
	return searchMachine(await d.machine(id), await d.root(id), place.machine, input, await d.secrets(id));
}

/** A search in the machine, secrets hidden from what it prints. */
export async function searchMachine(machine: Machine, root: string, target: string, input: GrepInput, secrets: Record<string, string> = {}, tool: 'auto' | 'rg' | 'grep' = 'auto'): Promise<string> {
	const hide = redactor(secrets);
	const where = shown(root, target);
	const result = await machine.exec(searchCommand(input, where, tool), { cwd: root, timeoutMs: SEARCH_TIMEOUT_MS });
	const answer = searchResult(hide(text(result.stdout)), input, where === '.' ? '' : where);
	const problem = hide(result.stderr).trim();
	// A pattern rg or grep cannot read says so, rather than "No matches".
	if (answer === 'No matches.' && problem) return `The search failed: ${problem.slice(0, 500)}`;
	return answer;
}

export type GlobInput = { pattern: string; path?: string; repo?: string };

/**
 * Files under `target` matching `pattern`: rg's list when the machine has it (it honours .gitignore and never walks
 * .git or node_modules), else git's own list of the files it tracks or would, else find's; picked by the glob as the
 * snapshot picks them, before the cap on what comes back. The first line says which listed them.
 */
export function globCommand(pattern: string, target: string, tool: 'auto' | 'rg' | 'list' = 'auto'): string {
	const rg = "rg --files --hidden --sort path -g '!.git'";
	const list = "{ git ls-files -co --exclude-standard 2>/dev/null || find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*'; }";
	return `cd -- ${quote(target)} && { ${either(rg, list, 'list', tool)}; } | sed 's|^\\./||' | grep -E -e '^@' -e ${quote(globPattern(pattern))} | head -n ${MAX_OUTPUT_LINES + 1}`;
}

type Listing = { paths: string[]; cut: boolean } | { problem: string };

/** The machine's listing as paths from the repository's root, sorted. */
export function globPaths(output: string, pattern: string, prefix: string): { paths: string[]; cut: boolean } {
	const [, ...rest] = output.split('\n');
	const regex = globToRegExp(pattern);
	const paths = rest
		.filter(Boolean)
		.map((file) => file.replace(/^\.\//, ''))
		.filter((file) => regex.test(file))
		.map((file) => (prefix ? `${prefix}/${file}` : file))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return { paths, cut: rest.length > MAX_OUTPUT_LINES };
}

async function machineGlob(machine: Machine, root: string, target: string, pattern: string, tool: 'auto' | 'rg' | 'list' = 'auto'): Promise<Listing> {
	const result = await machine.exec(globCommand(pattern, target, tool), { cwd: root, timeoutMs: SEARCH_TIMEOUT_MS });
	const where = shown(root, target);
	if (result.exitCode !== 0 && !text(result.stdout).trim()) return { problem: `${where} is not a folder to list.` };
	return globPaths(text(result.stdout), pattern, where === '.' ? '' : where);
}

/** A listing as the snapshot's: past the cap, how many more and how to narrow it. */
function listingText(listing: Listing): string {
	if ('problem' in listing) return listing.problem;
	const { paths, cut } = listing;
	if (!paths.length) return 'No files match.';
	const more = paths.length - MAX_LISTED;
	return more > 0 ? `${paths.slice(0, MAX_LISTED).join('\n')}\n(${more}${cut ? '+' : ''} more; narrow it with path or pattern)` : paths.join('\n');
}

/** Files under `target` in the machine matching a glob, as the glob tool shows them. */
export async function globMachine(machine: Machine, root: string, target: string, pattern: string, tool: 'auto' | 'rg' | 'list' = 'auto'): Promise<string> {
	return listingText(await machineGlob(machine, root, target, pattern, tool));
}

/** Files matching a glob, as paths from the repository's root. */
export async function globTask(id: string, input: GlobInput, deps: Partial<Deps> = {}): Promise<string> {
	const d = { ...defaults, ...deps };
	if (input.repo) return listRepoFiles(id, { glob: input.pattern, path: input.path, repo: input.repo });
	const place = await placeOf(id, input.path ?? '.', d);
	if ('snapshot' in place) return listRepoFiles(id, { glob: input.pattern, path: place.snapshot === '.' ? undefined : place.snapshot });
	return globMachine(await d.machine(id), await d.root(id), place.machine, input.pattern);
}

/** For run_script programs: every path matching a glob, as a list, from wherever the task's reads come from. */
export async function taskPaths(id: string, input: GlobInput, deps: Partial<Deps> = {}): Promise<string[]> {
	const d = { ...defaults, ...deps };
	if (input.repo) return repoPaths(id, { glob: input.pattern, path: input.path, repo: input.repo });
	const place = await placeOf(id, input.path ?? '.', d);
	if ('snapshot' in place) return repoPaths(id, { glob: input.pattern, path: place.snapshot === '.' ? undefined : place.snapshot });
	const listing = await machineGlob(await d.machine(id), await d.root(id), place.machine, input.pattern);
	if ('problem' in listing) throw new Error(listing.problem);
	return listing.paths;
}

/** For run_script programs: a file's whole text; throws when it cannot be read. */
export async function taskText(id: string, file: string, repo?: string, deps: Partial<Deps> = {}): Promise<string> {
	const d = { ...defaults, ...deps };
	if (repo) return repoText(id, file, repo);
	const place = await placeOf(id, file, d);
	if ('snapshot' in place) return repoText(id, place.snapshot);
	const content = text(await readMachineFile(await d.machine(id), place.machine));
	if (content.includes('\0')) throw new Error(`${file} is a binary file.`);
	return content;
}
