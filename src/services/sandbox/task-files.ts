import path from 'node:path';
import { NotFoundError } from '../../core/errors.ts';
import { readMachineFile } from '../../core/machine-fs.ts';
import type { Machine } from '../../core/ports.ts';
import { redactor } from '../../core/redact.ts';
import { quote, text } from '../../core/shell.ts';
import { hasWorkspace, noteWorkspace } from '../tasks/agent-runner.ts';
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
import { runnerOf } from '../tasks/runners.ts';
import { secretsToHide } from '../secrets/secrets.ts';
import { machineFor } from './workspace.ts';

/*
 * A repository task's read, grep and glob read the snapshot at its base commit until it has a workspace, then the machine
 * (even when stopped). A path outside the repository is only in the machine; `repo` always reads its own snapshot.
 */

export type Deps = {
	workspace: (id: string) => boolean;
	machine: (id: string) => Promise<Machine>;
	secrets: (id: string) => Promise<Record<string, string>>;
	root: (id: string) => Promise<string>;
};

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

/** From now on its reads come from the machine. */
export async function workMachine(id: string, deps: Partial<Deps> = {}): Promise<Machine> {
	const machine = await (deps.machine ?? defaults.machine)(id);
	noteWorkspace(id);
	return machine;
}

type Place = { snapshot: string } | { machine: string };

async function placeOf(id: string, file: string, d: Deps): Promise<Place> {
	const root = await d.root(id);
	const absolute = path.posix.resolve(root, file);
	const inside = absolute === root || absolute.startsWith(`${root}/`);
	if (inside && !d.workspace(id)) return { snapshot: path.posix.relative(root, absolute) || '.' };
	return { machine: absolute };
}

function shown(root: string, absolute: string): string {
	return absolute === root ? '.' : absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
}

export type ReadInput = { path: string; offset?: number; limit?: number; repo?: string };

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

export async function taskFileBytes(id: string, file: string, repo?: string, deps: Partial<Deps> = {}): Promise<Uint8Array> {
	const d = { ...defaults, ...deps };
	if (repo) return repoBytes(id, file, repo);
	const place = await placeOf(id, file, d);
	return 'snapshot' in place ? repoBytes(id, place.snapshot) : readMachineFile(await d.machine(id), place.machine);
}

export type GrepInput = SearchInput;

const MAX_OUTPUT_LINES = 5_000;
const SEARCH_TIMEOUT_MS = 60_000;

/** The snapshot's own glob, so both sides pick the same files. rg's `-g` is not used: a glob matching a folder's name brings back what .gitignore leaves out. */
export const globPattern = (glob: string) => globToRegExp(glob).source.replaceAll('(?:', '(');

const either = (rg: string, other: string, name: string, tool: 'auto' | 'rg' | string) =>
	tool === 'rg' ? `echo @rg; ${rg}` : tool === name ? `echo @${name}; ${other}` : `if command -v rg >/dev/null 2>&1; then echo @rg; ${rg}; else echo @${name}; ${other}; fi`;

/** A folder is searched from inside it, so a glob matches as on the snapshot. Every rg names what it searches: given none, with no terminal, it reads stdin. */
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
	// Perl's expressions where grep has them, as models write \d and \w, which grep -E reads as letters and so finds nothing.
	const grep = [
		"p=E; echo | grep -qP '' 2>/dev/null && p=P; grep -rIHn$p --exclude-dir=.git --exclude-dir=node_modules",
		input.filesOnly ? ' -l' : ' -Z',
		input.ignoreCase ? ' -i' : '',
		context,
		` -e ${quote(input.pattern)} -- "\${@:-.}"`,
	].join('');
	return `if test -d ${quote(target)}; then cd -- ${quote(target)} && echo @dir && set --; else echo @file; set -- ${quote(target)}; fi; { ${either(rg, grep, 'grep', tool)}; } | head -n ${MAX_OUTPUT_LINES + 2}`;
}

const lineText = (line: string, context: boolean) => (context ? line.trimEnd() : line.trim()).slice(0, 300);

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Hit = { file: string; line: number; match: boolean; text: string };

/** rg and grep each print files in the order they find them, so they are sorted to the snapshot's order. */
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

export async function grepTask(id: string, input: GrepInput, deps: Partial<Deps> = {}): Promise<string> {
	const d = { ...defaults, ...deps };
	if (input.repo) return searchRepo(id, input);
	const place = await placeOf(id, input.path ?? '.', d);
	if ('snapshot' in place) return searchRepo(id, { ...input, path: place.snapshot === '.' ? undefined : place.snapshot });
	return searchMachine(await d.machine(id), await d.root(id), place.machine, input, await d.secrets(id));
}

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

/** rg's list (honours .gitignore), else git's own list, else find's; picked by the glob as the snapshot picks them, before the cap. */
export function globCommand(pattern: string, target: string, tool: 'auto' | 'rg' | 'list' = 'auto'): string {
	const rg = "rg --files --hidden --sort path -g '!.git'";
	const list = "{ git ls-files -co --exclude-standard 2>/dev/null || find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*'; }";
	return `cd -- ${quote(target)} && { ${either(rg, list, 'list', tool)}; } | sed 's|^\\./||' | grep -E -e '^@' -e ${quote(globPattern(pattern))} | head -n ${MAX_OUTPUT_LINES + 1}`;
}

type Listing = { paths: string[]; cut: boolean } | { problem: string };

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

function listingText(listing: Listing): string {
	if ('problem' in listing) return listing.problem;
	const { paths, cut } = listing;
	if (!paths.length) return 'No files match.';
	const more = paths.length - MAX_LISTED;
	return more > 0 ? `${paths.slice(0, MAX_LISTED).join('\n')}\n(${more}${cut ? '+' : ''} more; narrow it with path or pattern)` : paths.join('\n');
}

export async function globMachine(machine: Machine, root: string, target: string, pattern: string, tool: 'auto' | 'rg' | 'list' = 'auto'): Promise<string> {
	return listingText(await machineGlob(machine, root, target, pattern, tool));
}

export async function globTask(id: string, input: GlobInput, deps: Partial<Deps> = {}): Promise<string> {
	const d = { ...defaults, ...deps };
	if (input.repo) return listRepoFiles(id, { glob: input.pattern, path: input.path, repo: input.repo });
	const place = await placeOf(id, input.path ?? '.', d);
	if ('snapshot' in place) return listRepoFiles(id, { glob: input.pattern, path: place.snapshot === '.' ? undefined : place.snapshot });
	return globMachine(await d.machine(id), await d.root(id), place.machine, input.pattern);
}

export async function taskPaths(id: string, input: GlobInput, deps: Partial<Deps> = {}): Promise<string[]> {
	const d = { ...defaults, ...deps };
	if (input.repo) return repoPaths(id, { glob: input.pattern, path: input.path, repo: input.repo });
	const place = await placeOf(id, input.path ?? '.', d);
	if ('snapshot' in place) return repoPaths(id, { glob: input.pattern, path: place.snapshot === '.' ? undefined : place.snapshot });
	const listing = await machineGlob(await d.machine(id), await d.root(id), place.machine, input.pattern);
	if ('problem' in listing) throw new Error(listing.problem);
	return listing.paths;
}

export async function taskText(id: string, file: string, repo?: string, deps: Partial<Deps> = {}): Promise<string> {
	const d = { ...defaults, ...deps };
	if (repo) return repoText(id, file, repo);
	const place = await placeOf(id, file, d);
	if ('snapshot' in place) return repoText(id, place.snapshot);
	const content = text(await readMachineFile(await d.machine(id), place.machine));
	if (content.includes('\0')) throw new Error(`${file} is a binary file.`);
	return content;
}
