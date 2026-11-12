/*
 * The apply_patch format (V4A), which OpenAI's GPT and Codex models are trained
 * to write: Codex CLI gives them this tool for every file change. Parsed and
 * applied here as pure functions; `createApplyPatchTool` in
 * src/flue/sandbox-tools.ts reads and writes the files, and the thread reads a
 * call's files from here too.
 *
 *   *** Begin Patch
 *   *** Add File: path        then each line as +line
 *   *** Update File: path     then *** Move to: path, and hunks: @@ headers, then
 *                             ' ' context, - removed and + added lines, and
 *                             *** End of File when the hunk ends the file
 *   *** Delete File: path
 *   *** End Patch
 */

/** A patch that cannot be parsed or does not fit: its message is what the model reads. */
export class PatchError extends Error {}

/** One hunk: the `@@` headers that narrow down where it goes, the lines it replaces and those it leaves. */
export type PatchHunk = { headers: string[]; old: string[]; new: string[]; endOfFile: boolean };

export type FilePatch =
	| { kind: 'add'; path: string; lines: string[] }
	| { kind: 'delete'; path: string }
	| { kind: 'update'; path: string; moveTo: string | null; hunks: PatchHunk[]; added: number; removed: number };

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const END_OF_FILE = '*** End of File';

/** A hunk's `@@` line, bare or naming where the hunk is; a context line that starts with @@ starts with a space. */
const HUNK_HEADER = /^@@(?: |$)/;

const isFileHeader = (line: string) => [ADD, DELETE, UPDATE].some((header) => line.startsWith(header)) || line === END;

/**
 * The patch out of the wrappers models put around it: code fences, a leading
 * `apply_patch` word (the shell command they know it as), and a heredoc.
 * Nothing else is guessed at.
 */
export function unwrapPatch(text: string): string[] {
	let lines = text.split(/\r?\n/);
	const trimEnds = () => {
		while (lines.length && !lines[0].trim()) lines.shift();
		while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	};
	trimEnds();
	if (lines.length >= 2 && /^```[\w-]*$/.test(lines[0].trim()) && lines[lines.length - 1].trim() === '```') {
		lines = lines.slice(1, -1);
		trimEnds();
	}
	if (lines.length && /^apply_patch\b/.test(lines[0].trim())) {
		const rest = lines[0].trim().slice('apply_patch'.length).trim();
		if (rest) lines[0] = rest;
		else lines.shift();
		trimEnds();
	}
	const heredoc = lines.length >= 2 ? /^<<-?\s*(['"]?)([\w-]+)\1$/.exec(lines[0].trim()) : null;
	if (heredoc && lines[lines.length - 1].trim() === heredoc[2]) {
		lines = lines.slice(1, -1);
		trimEnds();
	}
	return lines;
}

/** The file changes a patch makes, in order; a patch that does not follow the format throws, naming the line. */
export function parsePatch(text: string): FilePatch[] {
	const lines = unwrapPatch(text);
	if (lines[0]?.trim() !== BEGIN) throw new PatchError(`The patch must start with "${BEGIN}".`);
	if (lines.length < 2 || lines[lines.length - 1].trim() !== END) throw new PatchError(`The patch must end with "${END}".`);
	const body = lines.slice(1, -1);
	const files: FilePatch[] = [];
	let at = 0;
	const where = () => `Line ${at + 2} of the patch`;
	while (at < body.length) {
		const header = body[at].trim();
		// A blank line between files.
		if (!header) {
			at++;
			continue;
		}
		if (header.startsWith(ADD)) {
			const path = header.slice(ADD.length).trim();
			const added: string[] = [];
			at++;
			while (at < body.length && body[at].startsWith('+')) added.push(body[at++].slice(1));
			files.push({ kind: 'add', path, lines: added });
		} else if (header.startsWith(DELETE)) {
			files.push({ kind: 'delete', path: header.slice(DELETE.length).trim() });
			at++;
		} else if (header.startsWith(UPDATE)) {
			const path = header.slice(UPDATE.length).trim();
			at++;
			let moveTo: string | null = null;
			if (at < body.length && body[at].trim().startsWith(MOVE)) moveTo = body[at++].trim().slice(MOVE.length).trim();
			const file = { kind: 'update' as const, path, moveTo, hunks: [] as PatchHunk[], added: 0, removed: 0 };
			while (at < body.length && !isFileHeader(body[at].trimEnd())) {
				const hunk: PatchHunk = { headers: [], old: [], new: [], endOfFile: false };
				while (at < body.length && HUNK_HEADER.test(body[at].trimEnd())) {
					const named = body[at++].trim().slice(2).trim();
					if (named) hunk.headers.push(named);
				}
				let lines = 0;
				let changes = 0;
				while (at < body.length) {
					const line = body[at];
					if (line.trimEnd() === END_OF_FILE) {
						hunk.endOfFile = true;
						at++;
						break;
					}
					if (HUNK_HEADER.test(line.trimEnd()) || isFileHeader(line.trimEnd())) break;
					const mark = line[0];
					if (line === '' || mark === ' ') {
						hunk.old.push(line.slice(1));
						hunk.new.push(line.slice(1));
					} else if (mark === '-') {
						hunk.old.push(line.slice(1));
						file.removed++;
						changes++;
					} else if (mark === '+') {
						hunk.new.push(line.slice(1));
						file.added++;
						changes++;
					} else {
						throw new PatchError(`${where()} in the update of ${path}, "${line}", is not a hunk line: each starts with a space (context), - (removed) or + (added).`);
					}
					lines++;
					at++;
				}
				if (!lines) throw new PatchError(`${where()}: hunk ${file.hunks.length + 1} of the update of ${path} has no lines.`);
				// Context alone changes nothing, as blank lines before the next file do not.
				if (changes) file.hunks.push(hunk);
			}
			if (!file.hunks.length && !moveTo) throw new PatchError(`The update of ${path} changes nothing: give each hunk its - and + lines.`);
			files.push(file);
		} else {
			throw new PatchError(`${where()}, "${body[at]}", is not a file header: use "${ADD}", "${UPDATE}" or "${DELETE}".`);
		}
	}
	if (!files.length) throw new PatchError('The patch changes no files.');
	for (const file of files) if (!file.path) throw new PatchError('A file header names no path.');
	return files;
}

/** Typographic punctuation a model may have written as plain ASCII, or the other way round, as Codex folds it. */
function plainPunctuation(line: string): string {
	return line
		.replace(/[\u2010-\u2015\u2212]/g, '-')
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C-\u201F]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

/** How lines are compared, strictest first: exactly, then without trailing space, then without either end's, then with punctuation folded. */
const PASSES: Array<(line: string) => string> = [(line) => line, (line) => line.trimEnd(), (line) => line.trim(), (line) => plainPunctuation(line.trim())];

const fitsAt = (lines: string[], want: string[], at: number, pass: (line: string) => string) => want.every((line, index) => pass(lines[at + index]) === line);

/**
 * Where `pattern` first fits in `lines` from `from` on, with the strictest
 * comparison that finds it, and where else it fits as well; at the end only,
 * for a hunk anchored there.
 */
function seek(lines: string[], pattern: string[], from: number, atEnd: boolean): { at: number; also: number[] } | null {
	if (pattern.length > lines.length) return null;
	const last = lines.length - pattern.length;
	const start = atEnd ? last : from;
	if (start < from) return null;
	for (const pass of PASSES) {
		const want = pattern.map(pass);
		for (let at = start; at <= last; at++) {
			if (!fitsAt(lines, want, at, pass)) continue;
			const also: number[] = [];
			for (let other = at + 1; other <= last; other++) if (fitsAt(lines, want, other, pass)) also.push(other);
			return { at, also };
		}
	}
	return null;
}

type Lines = { text: string[]; eols: string[]; finalNewline: boolean; eol: string };

/** A file's lines, each with its own ending, so CRLF stays CRLF and a file without a final newline keeps none. */
function splitLines(content: string): Lines {
	if (content === '') return { text: [], eols: [], finalNewline: true, eol: '\n' };
	const parts = content.split('\n');
	const finalNewline = content.endsWith('\n');
	if (finalNewline) parts.pop();
	const eols = parts.map((part, index) => (index === parts.length - 1 && !finalNewline ? '' : part.endsWith('\r') ? '\r\n' : '\n'));
	const text = parts.map((part, index) => (eols[index] === '\r\n' ? part.slice(0, -1) : part));
	const crlf = eols.filter((eol) => eol === '\r\n').length;
	return { text, eols, finalNewline, eol: crlf > eols.filter((eol) => eol === '\n').length ? '\r\n' : '\n' };
}

const quoted = (lines: string[]) => (lines.length ? lines.map((line) => `  ${line}`).join('\n') : '  (no lines)');

/**
 * The file's new content with each hunk applied in order, each found from where
 * the one before ended, or an error naming the hunk that does not fit and the
 * lines it looked for. A hunk whose lines fit more than one place, with no `@@`
 * header or end-of-file anchor to say which, fails too, rather than change the first.
 */
export function applyHunks(path: string, content: string, hunks: PatchHunk[]): string {
	const file = splitLines(content);
	const lines = file.text;
	const replacements: Array<{ at: number; length: number; lines: string[] }> = [];
	let from = 0;
	hunks.forEach((hunk, index) => {
		const which = `Hunk ${index + 1} of ${hunks.length} for ${path}`;
		let start = from;
		for (const header of hunk.headers) {
			const found = seek(lines, [header], start, false);
			if (!found) throw new PatchError(`${which}: its @@ line "${header}" is not in the file${start ? ' after the hunk or @@ line before it' : ''}.`);
			// The hunk may start on the header's own line.
			start = found.at;
		}
		let old = hunk.old;
		let made = hunk.new;
		if (!old.length) {
			// Only added lines: after the last header, else at the end.
			const at = hunk.headers.length ? start + 1 : lines.length;
			replacements.push({ at, length: 0, lines: made });
			from = at;
			return;
		}
		let found = seek(lines, old, start, hunk.endOfFile);
		// A blank last line the model added as context the file does not have.
		if (!found && old[old.length - 1] === '' && old.length > 1) {
			old = old.slice(0, -1);
			if (made[made.length - 1] === '') made = made.slice(0, -1);
			found = seek(lines, old, start, hunk.endOfFile);
		}
		if (!found) throw new PatchError(`${which} does not fit: these lines are not in the file${index ? ' after the hunk before it' : ''}${hunk.headers.length ? ` under "${hunk.headers.join('" then "')}"` : ''}:\n${quoted(old)}`);
		if (found.also.length && !hunk.headers.length && !hunk.endOfFile) {
			const places = [found.at, ...found.also].map((at) => at + 1);
			throw new PatchError(
				`${which} fits ${places.length} places (lines ${places.slice(0, 5).join(', ')}${places.length > 5 ? ', …' : ''}), so it is not clear which to change. ` +
					`Add an @@ line naming the function or class it is in, or more context lines. The lines it looked for:\n${quoted(old)}`,
			);
		}
		replacements.push({ at: found.at, length: old.length, lines: made });
		from = found.at + old.length;
	});
	const text = [...lines];
	const eols: Array<string | null> = [...file.eols];
	for (const { at, length, lines: added } of [...replacements].reverse()) {
		text.splice(at, length, ...added);
		eols.splice(at, length, ...added.map(() => null));
	}
	if (!text.length) return '';
	return text.map((line, index) => line + (index < text.length - 1 ? eols[index] || file.eol : file.finalNewline ? eols[index] || file.eol : '')).join('');
}

/** A new file's content: its lines, each ending in a newline. */
export const addedContent = (lines: string[]) => lines.map((line) => `${line}\n`).join('');

/** What a patch does to each file, in a line the model reads: A, M or D and its path, a move as both paths. */
export function changeLine(file: FilePatch): string {
	if (file.kind === 'add') return `A ${file.path}`;
	if (file.kind === 'delete') return `D ${file.path}`;
	return file.moveTo ? `M ${file.path} -> ${file.moveTo}` : `M ${file.path}`;
}

/** A file's state once the patch so far is made: its content, or null once deleted. */
export type PatchState = Map<string, string | null>;

/**
 * Every file's content once the whole patch is made, worked out before anything
 * is written: `read` gives a file as it is now, and throws for one that is not
 * there; `key` names a path the same way however it was written. A patch that
 * changes a file twice sees its first change the second time.
 */
export async function planPatch(files: FilePatch[], read: (path: string) => Promise<string>, key: (path: string) => string = (path) => path): Promise<{ after: PatchState; before: Map<string, string | null> }> {
	const after: PatchState = new Map();
	const before = new Map<string, string | null>();
	const current = async (path: string): Promise<string | null> => {
		const at = key(path);
		if (after.has(at)) return after.get(at)!;
		if (!before.has(at)) before.set(at, await read(path).catch(() => null));
		return before.get(at)!;
	};
	const note = async (path: string, content: string | null) => {
		await current(path);
		after.set(key(path), content);
	};
	for (const file of files) {
		if (file.kind === 'add') {
			await note(file.path, addedContent(file.lines));
			continue;
		}
		const content = await current(file.path);
		if (content === null) throw new PatchError(`${file.kind === 'delete' ? 'Cannot delete' : 'Cannot update'} ${file.path}: there is no such file.`);
		if (file.kind === 'delete') {
			await note(file.path, null);
			continue;
		}
		const changed = applyHunks(file.path, content, file.hunks);
		if (file.moveTo && key(file.moveTo) !== key(file.path)) {
			await note(file.moveTo, changed);
			await note(file.path, null);
		} else {
			await note(file.path, changed);
		}
	}
	return { after, before };
}

/** A file an apply_patch call changed, for the thread: its path, what happened to it, and the lines it added and removed. */
export type PatchedFile = { path: string; change: 'add' | 'update' | 'delete' | 'move'; to?: string; added: number; removed: number };

/** The files a patch names, without reading any; empty for a patch that does not parse. */
export function patchedFiles(text: string): PatchedFile[] {
	let files: FilePatch[];
	try {
		files = parsePatch(text);
	} catch {
		return [];
	}
	return files.map((file) => {
		if (file.kind === 'add') return { path: file.path, change: 'add', added: file.lines.length, removed: 0 };
		if (file.kind === 'delete') return { path: file.path, change: 'delete', added: 0, removed: 0 };
		return { path: file.path, change: file.moveTo ? 'move' : 'update', ...(file.moveTo ? { to: file.moveTo } : {}), added: file.added, removed: file.removed };
	});
}
