import { Type } from '@earendil-works/pi-ai';
import { createGlobTool, createGrepTool, createReadTool, createWriteTool, type Sandbox, type SandboxToolFactory } from '@flue/runtime';
import { changeLine, PatchError, parsePatch, type PatchState, planPatch } from '../core/apply-patch.ts';
import { LINE_MARK, type ToolProfile } from '../core/tool-profile.ts';
import { createShellTool } from './shell-tool.ts';

export type Tool = ReturnType<SandboxToolFactory>[number];

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** As the composer sends images. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const imageType = (path: string): string | undefined => IMAGE_TYPES[/\.(\w+)$/.exec(path)?.[1]?.toLowerCase() ?? ''];

export type ImageSight = { sees: () => Promise<boolean>; describe: (bytes: Uint8Array, mimeType: string) => Promise<string> };

export const text = (value: string) => ({ type: 'text' as const, text: value });

const ascii = (bytes: Uint8Array, from: number, length: number) => String.fromCharCode(...bytes.subarray(from, from + length));

/** A cut image makes the provider refuse the whole request ("could not parse image"), and every later call of that agent too. */
export function isWholeImage(bytes: Uint8Array, mimeType: string): boolean {
	switch (mimeType) {
		case 'image/png':
			// The last chunk is IEND: a zero length, its type, and its CRC.
			return bytes.length >= 20 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, bytes.length - 8, 4) === 'IEND';
		case 'image/jpeg': {
			// Ends with EOI, though some writers pad a few bytes after it.
			const tail = bytes.subarray(Math.max(2, bytes.length - 64));
			return bytes[0] === 0xff && bytes[1] === 0xd8 && tail.some((byte, index) => byte === 0xff && tail[index + 1] === 0xd9);
		}
		case 'image/gif':
			return ascii(bytes, 0, 3) === 'GIF' && bytes[bytes.length - 1] === 0x3b;
		case 'image/webp':
			// RIFF gives the size of what follows its first 8 bytes.
			return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 <= bytes.length;
		default:
			return true;
	}
}

type Change = { oldText: string; newText: string; replaceAll?: boolean };

const ChangeParams = {
	oldText: Type.String({ description: 'Exact text to find (must be unique)' }),
	newText: Type.String({ description: 'Replacement text' }),
	replaceAll: Type.Optional(Type.Boolean({ description: 'Replace all occurrences' })),
};

const EditParams = Type.Object({
	path: Type.String({ description: 'Path to the file to edit' }),
	oldText: Type.Optional(ChangeParams.oldText),
	newText: Type.Optional(ChangeParams.newText),
	replaceAll: ChangeParams.replaceAll,
	edits: Type.Optional(
		Type.Array(Type.Object(ChangeParams), { description: 'Several changes to this file, made in order, each on the text the one before left. Use it instead of oldText and newText to make them all in one call.' }),
	),
});

const occurrences = (content: string, find: string) => content.split(find).length - 1;

/**
 * Ways an oldText that is not in the file can still name one place in it, each tried only when the exact text is absent,
 * and taken only when it fits once. Prod, Nov 2026: 22 of Devin's and Antigravity's 34 failed edits had one tab more on
 * every line than the file (read's number and tab, taken as indentation), and the retry often moved the new code a level
 * too deep as well. The same shift is made to newText, so the change lands at the file's own indentation.
 */
const NUMBERED = new RegExp(`^ *\\d+(?:${LINE_MARK}|\\t)`);
type Reading = { why: string; line: (line: string) => string | null };
const READINGS: Reading[] = [
	{ why: "with read's line numbers taken off", line: (line) => (NUMBERED.test(line) ? line.replace(NUMBERED, '') : null) },
	...['\t', '  ', '    '].map((unit) => ({
		why: `with ${unit === '\t' ? 'one tab' : `${unit.length} spaces`} less indentation on each line`,
		line: (line: string) => (line.startsWith(unit) ? line.slice(unit.length) : null),
	})),
];

/**
 * The reading's oldText and newText, or null when one of oldText's lines does not take it. A blank line takes any, and so
 * does the first, which may start partway along its line.
 */
function reread(change: Change, reading: Reading): { oldText: string; newText: string } | null {
	const lines = change.oldText.split('\n');
	const old = lines.map((line, index) => (line.trim() ? (reading.line(line) ?? (index === 0 ? line : null)) : line));
	if (old.some((line) => line === null) || old.join('\n') === change.oldText) return null;
	const newText = change.newText
		.split('\n')
		.map((line) => reading.line(line) ?? line)
		.join('\n');
	return { oldText: old.join('\n'), newText };
}

/** Where the file holds the line oldText names first, numbered as read shows it, so the next try copies it. */
function nearest(content: string, oldText: string): string {
	// Spacing aside, as a miss is most often a matter of whitespace.
	const squeeze = (line: string) => line.replace(/\s+/g, '');
	const first = squeeze(oldText.split('\n').find((line) => line.trim()) ?? '');
	if (!first) return '';
	const lines = content.split('\n');
	const at = lines.findIndex((line) => squeeze(line) === first);
	const loose = at >= 0 ? at : lines.findIndex((line) => squeeze(line).includes(first));
	if (loose < 0) return '';
	const shown = lines.slice(loose, loose + Math.min(oldText.split('\n').length + 2, 12));
	return `\nIts first line is line ${loose + 1} of the file, which reads:\n${shown.map((line, index) => `${loose + 1 + index}${LINE_MARK}${line}`).join('\n')}`;
}

export function applyChanges(path: string, content: string, changes: Change[]): { content: string; replacements: number; notes: string[] } {
	// The text after each change, so a miss can tell which earlier change took its text.
	const after: string[] = [content];
	let replacements = 0;
	const notes: string[] = [];
	changes.forEach((given, index) => {
		const which = changes.length > 1 ? `Edit ${index + 1} of ${changes.length}: ` : '';
		const unchanged = changes.length > 1 ? ' No changes made.' : '';
		if (!given.oldText) throw new Error(`${which}oldText must be a non-empty string.`);
		let change = given;
		let found = occurrences(content, change.oldText);
		if (found === 0) {
			for (const reading of READINGS) {
				const read = reread(given, reading);
				const count = read ? occurrences(content, read.oldText) : 0;
				if (read && (count === 1 || (count > 1 && given.replaceAll))) {
					change = { ...given, ...read };
					found = count;
					notes.push(`${which}its oldText matched only ${reading.why}; newText was shifted the same way. Copy a line's indentation from after the ${LINE_MARK} that follows its number.`);
					break;
				}
			}
		}
		if (found === 0) {
			const before = occurrences(after[0], given.oldText) > 0 ? after.findIndex((text) => occurrences(text, given.oldText) === 0) - 1 : -1;
			const why = before >= 0 ? ` The file had this text, but edit ${before + 1} of this call changed it${changes[before].replaceAll ? ' (its replaceAll matched here too)' : ''}: aim this edit at the text edit ${before + 1} leaves.` : `${nearest(content, given.oldText)}`;
			throw new Error(`${which}Could not find the exact text in ${path}. Make sure your oldText matches exactly, including whitespace and indentation${changes.length > 1 ? ', and the text the edits before it left' : ''}.${why}${unchanged}`);
		}
		if (found > 1 && !change.replaceAll) throw new Error(`${which}Found ${found} occurrences of the text in ${path}. Provide more surrounding context to make the match unique, or use replaceAll.${unchanged}`);
		content = change.replaceAll ? content.replaceAll(change.oldText, () => change.newText) : content.replace(change.oldText, () => change.newText);
		after.push(content);
		replacements += change.replaceAll ? found : 1;
	});
	return { content, replacements, notes };
}

/** One change to a file at a time, per sandbox: a step's tool calls run together, and two that read the same file would each write over the other. */
const fileLocks = new WeakMap<Sandbox, Map<string, Promise<unknown>>>();

function oneAtATime<T>(sandbox: Sandbox, path: string, work: () => Promise<T>): Promise<T> {
	const locks = fileLocks.get(sandbox) ?? new Map<string, Promise<unknown>>();
	fileLocks.set(sandbox, locks);
	const key = resolved(sandbox, path);
	const run = (locks.get(key) ?? Promise.resolve()).then(work);
	const settled = run.catch(() => undefined);
	locks.set(key, settled);
	void settled.then(() => locks.get(key) === settled && locks.delete(key));
	return run;
}

/** Every file of one change, each path's lock taken in turn in one order, so two calls that share files never each hold a lock the other waits for. */
function allAtOnce<T>(sandbox: Sandbox, paths: string[], work: () => Promise<T>): Promise<T> {
	const keys = [...new Set(paths.map((path) => resolved(sandbox, path)))].sort();
	return keys.reduceRight<() => Promise<T>>((next, key) => () => oneAtATime(sandbox, key, next), work)();
}

function resolved(sandbox: Sandbox, path: string): string {
	try {
		return sandbox.resolvePath(path);
	} catch {
		return path;
	}
}

/** Several changes to a file in one call: one review round on a long thread made 60 single edits, about ten seconds each. */
export function createMultiEditTool(sandbox: Sandbox): Tool {
	return {
		name: 'edit',
		label: 'Edit File',
		description:
			'Edit a file using exact text replacement. The oldText must match a unique region of the file. Use replaceAll to replace all occurrences. ' +
			'To make several changes to the file, pass them all as edits in one call rather than calling edit once for each; edits to other files can go in the same step.',
		parameters: EditParams,
		async execute(_toolCallId, params, signal) {
			const input = params as { path: string; edits?: Change[] } & Partial<Change>;
			const changes = [...(input.oldText !== undefined || input.newText !== undefined ? [{ oldText: input.oldText ?? '', newText: input.newText ?? '', replaceAll: input.replaceAll }] : []), ...(input.edits ?? [])];
			if (!changes.length) throw new Error('Give oldText and newText, or a list of edits.');
			signal?.throwIfAborted();
			return oneAtATime(sandbox, input.path, async () => {
				signal?.throwIfAborted();
				const before = await sandbox.readFile(input.path);
				signal?.throwIfAborted();
				const { content, replacements, notes } = applyChanges(input.path, before, changes);
				await sandbox.writeFile(input.path, content);
				const made = changes.length > 1 ? ` (${changes.length} edits)` : replacements > 1 ? ` (${replacements} occurrences)` : '';
				return { content: [text([`Successfully edited ${input.path}${made}`, ...notes].join('\n'))], details: { path: input.path, edits: changes.length, replacements } };
			});
		},
	};
}

const PatchParams = Type.Object({ input: Type.String({ description: 'The whole patch, from *** Begin Patch to *** End Patch' }) });

/** Short, as it is sent with every call: the models it is for are trained on the format. */
const APPLY_PATCH_DESCRIPTION = [
	'Change files with a patch. One call can add, update, move and delete several files, with several hunks in each:',
	'*** Begin Patch',
	'*** Update File: src/app.ts',
	'@@ function start',
	' context line',
	'-old line',
	'+new line',
	'*** Add File: src/new.ts',
	'+content',
	'*** Delete File: src/old.ts',
	'*** End Patch',
	'Paths are from the working folder, or absolute. *** Move to: after an Update File line renames the file.',
].join('\n');

/** When a write fails, puts back the files already written and says whether it could. */
async function writePatched(sandbox: Sandbox, after: PatchState, before: Map<string, string | null>): Promise<void> {
	const done: string[] = [];
	const order = [...after].sort(([, a], [, b]) => Number(a === null) - Number(b === null));
	try {
		for (const [path, content] of order) {
			if (content === null) await sandbox.rm(path);
			else await sandbox.writeFile(path, content);
			done.push(path);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const stuck: string[] = [];
		for (const path of done.reverse()) {
			const was = before.get(path) ?? null;
			await (was === null ? sandbox.rm(path) : sandbox.writeFile(path, was)).catch(() => stuck.push(path));
		}
		throw new Error(stuck.length ? `${message}\nThe patch was cut short, and these files could not be put back as they were: ${stuck.join(', ')}.` : `${message}\nNo file was changed.`);
	}
}

/** Every file's new content is worked out before anything is written, so a hunk that does not fit changes nothing. */
export function createApplyPatchTool(sandbox: Sandbox): Tool {
	return {
		name: 'apply_patch',
		label: 'Apply Patch',
		description: APPLY_PATCH_DESCRIPTION,
		parameters: PatchParams,
		async execute(_toolCallId, params, signal) {
			signal?.throwIfAborted();
			try {
				const input = (params as { input?: unknown }).input;
				const files = parsePatch(typeof input === 'string' ? input : '');
				const paths = files.flatMap((file) => (file.kind === 'update' && file.moveTo ? [file.path, file.moveTo] : [file.path]));
				return await allAtOnce(sandbox, paths, async () => {
					signal?.throwIfAborted();
					const { after, before } = await planPatch(files, (path) => sandbox.readFile(path), (path) => resolved(sandbox, path));
					signal?.throwIfAborted();
					await writePatched(sandbox, after, before);
					const lines = files.map(changeLine);
					return { content: [text(`Success. Updated the following files:\n${lines.join('\n')}`)], details: { files: lines } };
				});
			} catch (error) {
				if (error instanceof PatchError) throw new Error(`${error.message}\nNo file was changed.`);
				throw error;
			}
		},
	};
}

export const changeTools = (sandbox: Sandbox, profile: ToolProfile): Tool[] => (profile === 'patch' ? [createApplyPatchTool(sandbox)] : [queuedWriteTool(sandbox), createMultiEditTool(sandbox)]);

export async function imageResult(path: string, bytes: Uint8Array, mimeType: string, sight: ImageSight): Promise<Awaited<ReturnType<Tool['execute']>>> {
	const details = { path, size: bytes.length };
	if (bytes.length > MAX_IMAGE_BYTES) {
		return { content: [text(`${path} is an image of ${(bytes.length / 1024 / 1024).toFixed(1)} MB, too large to look at. Make a smaller copy (with ImageMagick or Python) and read that.`)], details };
	}
	if (!isWholeImage(bytes, mimeType)) {
		return { content: [text(`${path} is not a whole ${mimeType.slice(6).toUpperCase()} (${bytes.length} bytes): it may still be being written, or is damaged. Read it again in a moment, or take the screenshot again.`)], details };
	}
	if (await sight.sees()) return { content: [text(`${path}, an image:`), { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType }], details };
	const words = await sight.describe(bytes, mimeType).catch((error: unknown) => `No vision model could describe it: ${error instanceof Error ? error.message : String(error)}`);
	return { content: [text(`${path} is an image, and your model cannot see images, so a vision model described it:\n\n${words}`)], details };
}

/** Waits on the edits to the same file, which Flue's own lock no longer covers. */
export function queuedWriteTool(sandbox: Sandbox): Tool {
	const write = createWriteTool(sandbox);
	return { ...write, execute: (toolCallId, params, signal, onUpdate) => oneAtATime(sandbox, (params as { path: string }).path, () => write.execute(toolCallId, params as Parameters<typeof write.execute>[1], signal, onUpdate)) };
}

/** Flue's standard read reads every file as text; this one shows an image as a picture, or in the vision model's words. */
export function sandboxTools(sight: ImageSight, profile: ToolProfile = 'edit'): SandboxToolFactory {
	return (sandbox) => {
		const read = createReadTool(sandbox);
		const readImage: Tool = {
			...read,
			description: `${read.description} An image (PNG, JPEG, GIF or WebP) comes back as the picture itself, to look at.`,
			async execute(toolCallId, params, signal, onUpdate) {
				const input = params as Parameters<typeof read.execute>[1];
				const mimeType = imageType(input.path);
				if (!mimeType) return read.execute(toolCallId, input, signal, onUpdate);
				return imageResult(input.path, await sandbox.readFileBuffer(input.path), mimeType, sight);
			},
		};
		return [readImage, ...changeTools(sandbox, profile), createShellTool(sandbox), createGrepTool(sandbox), createGlobTool(sandbox)];
	};
}
