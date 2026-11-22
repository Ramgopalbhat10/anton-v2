import { Type } from '@earendil-works/pi-ai';
import { type Sandbox, type SandboxDriver, type SandboxToolFactory, sandboxFromDriver } from '@flue/runtime';
import { MAX_READ_LINES, numberedLines, READ_LINES } from '../services/sandbox/repo-snapshot.ts';
import type { ToolProfile } from '../core/tool-profile.ts';
import type { GlobInput, GrepInput, ReadInput } from '../services/sandbox/task-files.ts';
import { changeTools, type ImageSight, imageResult, imageType, text, type Tool } from './sandbox-tools.ts';
import { createShellTool } from './shell-tool.ts';

const DISCOVERED = /(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|\.agents\/skills)$/;

/**
 * Given to the runtime from the first model call, so the tool list and system prompt never change. The runtime reads
 * AGENTS.md, CLAUDE.md, `.agents/skills` and a listing into the prompt when a reply starts; it finds none here, as they
 * would change the prompt, and Anton adds them from the task's base commit instead.
 */
export function taskSandbox(cwd: string, machine: (work: boolean) => Promise<Sandbox>): Sandbox {
	const driver: SandboxDriver = {
		exec: async (command, options) => (await machine(true)).exec(command, options),
		readFile: async (path) => (await machine(false)).readFile(path),
		readFileBuffer: async (path) => (await machine(false)).readFileBuffer(path),
		writeFile: async (path, content) => (await machine(true)).writeFile(path, content),
		stat: async (path) => (await machine(false)).stat(path),
		exists: async (path) => !DISCOVERED.test(path) && (await machine(false)).exists(path),
		async readdir() {
			throw new Error('List folders with the glob tool.');
		},
		mkdir: async (path, options) => (await machine(true)).mkdir(path, options),
		rm: async (path, options) => (await machine(true)).rm(path, options),
	};
	return sandboxFromDriver(driver, cwd);
}

export type TaskFiles = {
	read: (input: ReadInput) => Promise<string>;
	bytes: (path: string, repo?: string) => Promise<Uint8Array>;
	grep: (input: GrepInput) => Promise<string>;
	glob: (input: GlobInput) => Promise<string>;
};

const REPO = Type.Optional(Type.String({ description: "Another GitHub repository to read instead of this task's, as owner/name, optionally @branch, tag or commit" }));

/** Files of activated skills the runtime serves itself (Flue's packaged-skill overlay). */
const PACKAGED = '/.flue/packaged-skills/';

/** Files one read may take: its path and as many more. */
export const MAX_READ_FILES = 8;

const ReadParams = Type.Object({
	path: Type.String({ description: 'Path from the repository root, or absolute' }),
	offset: Type.Optional(Type.Number({ description: 'First line to show' })),
	limit: Type.Optional(Type.Number({ description: `Lines to show (default ${READ_LINES}, at most ${MAX_READ_LINES})` })),
	repo: REPO,
	more: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.String(),
				offset: Type.Optional(Type.Number()),
				limit: Type.Optional(Type.Number()),
			}),
			{ description: `Other files to read in the same call, each with its own offset and limit (up to ${MAX_READ_FILES - 1})` },
		),
	),
});

type ReadEntry = { path: string; offset?: number; limit?: number };

const GrepParams = Type.Object({
	pattern: Type.String({ description: 'Regular expression' }),
	path: Type.Optional(Type.String({ description: 'Folder or file to search (default: the repository)' })),
	glob: Type.Optional(Type.String({ description: 'Only files matching this glob, such as *.ts or src/**/*.tsx' })),
	ignoreCase: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.Number({ description: 'Lines to show before and after each match (up to 10)' })),
	filesOnly: Type.Optional(Type.Boolean({ description: 'List only the files that match' })),
	repo: REPO,
});

const GlobParams = Type.Object({
	pattern: Type.String({ description: 'Glob, such as **/*.ts or package.json' }),
	path: Type.Optional(Type.String({ description: 'Folder to search (default: the repository)' })),
	repo: REPO,
});

const READ_MORE = 'To read several files you already know you need, pass the others as more: one call, read at once, each under a ==> path <== line.';

const READ_DESCRIPTION: Record<ToolProfile, string> = {
	edit:
		"Read a file with line numbers: each line comes as its number, a tab, then the line (leave the numbers out of edit's oldText). " +
		'Long files come in pages; pass offset to read on. An image (PNG, JPEG, GIF or WebP) comes back as the picture itself. ' +
		READ_MORE,
	patch:
		'Read a file with line numbers: each line comes as its number, a tab, then the line (leave the numbers out of a patch). ' +
		'Long files come in pages; pass offset to read on. An image (PNG, JPEG, GIF or WebP) comes back as the picture itself. ' +
		READ_MORE,
};

const whole = (value: unknown, min: number, max: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : undefined);

/** The same schema whether the snapshot or the machine answers, so they never change. */
export function taskTools(files: TaskFiles, sight: ImageSight, profile: ToolProfile = 'edit'): SandboxToolFactory {
	return (sandbox) => {
		// Another repository's paths are from its root; this task's from the session's folder.
		const at = (path: string | undefined, repo: string | undefined) => (repo ? path : sandbox.resolvePath(path ?? '.'));
		const read: Tool = {
			name: 'read',
			label: 'Read File',
			description: READ_DESCRIPTION[profile],
			parameters: ReadParams,
			async execute(_toolCallId, params, signal) {
				signal?.throwIfAborted();
				const input = params as ReadInput & { more?: ReadEntry[] };
				const one = async (entry: ReadEntry): Promise<Awaited<ReturnType<Tool['execute']>>> => {
					const offset = whole(entry.offset, 1, Number.MAX_SAFE_INTEGER);
					const limit = whole(entry.limit, 1, MAX_READ_LINES);
					if (!input.repo && entry.path.startsWith(PACKAGED)) return { content: [text(numberedLines(await sandbox.readFile(entry.path), offset, limit))], details: { path: entry.path } };
					const mimeType = imageType(entry.path);
					if (mimeType) return imageResult(entry.path, await files.bytes(at(entry.path, input.repo) as string, input.repo), mimeType, sight);
					return { content: [text(await files.read({ path: at(entry.path, input.repo) as string, offset, limit, repo: input.repo }))], details: { path: entry.path } };
				};
				const more = (Array.isArray(input.more) ? input.more : []).filter((entry) => typeof entry?.path === 'string' && entry.path);
				// One file reads exactly as it did before `more`, so its result and the conversation's bytes stay the same.
				if (!more.length) return one(input);
				const entries = [input, ...more];
				const taken = entries.slice(0, MAX_READ_FILES);
				// Each file is read on its own, as a lone read would be, and a failure stays with its file.
				const results = await Promise.all(
					taken.map((entry) =>
						one(entry).catch((error: unknown) => ({ content: [text(`Could not read it: ${error instanceof Error ? error.message : String(error)}`)], details: { path: entry.path } })),
					),
				);
				const parts = results.flatMap((result, index) => [text(`${index ? '\n' : ''}==> ${taken[index].path} <==`), ...result.content]);
				const left = entries.length - taken.length;
				if (left) parts.push(text(`\n${left} more ${left === 1 ? 'file was' : 'files were'} left out: one read takes up to ${MAX_READ_FILES}. Read ${left === 1 ? 'it' : 'them'} in another call.`));
				// The text comes as one part, as a lone read's does; an image keeps a part of its own.
				const content: typeof parts = [];
				for (const part of parts) {
					const last = content.at(-1);
					if (part.type === 'text' && last?.type === 'text') content[content.length - 1] = text(`${last.text}\n${part.text}`);
					else content.push(part);
				}
				return { content, details: { path: input.path, paths: taken.map((entry) => entry.path) } };
			},
		};
		const grep: Tool = {
			name: 'grep',
			label: 'Search Files',
			description: 'Search file contents with a regular expression. Matches come as path:line: text; context adds the lines around each, filesOnly lists only the files. Skips what .gitignore leaves out.',
			parameters: GrepParams,
			async execute(_toolCallId, params, signal) {
				signal?.throwIfAborted();
				const input = params as GrepInput;
				const output = await files.grep({ ...input, path: at(input.path, input.repo), context: whole(input.context, 0, 10) });
				return { content: [text(output)], details: { pattern: input.pattern } };
			},
		};
		const glob: Tool = {
			name: 'glob',
			label: 'Find Files',
			description: 'Find files by glob, such as **/*.ts or package.json, optionally under a folder. Skips what .gitignore leaves out.',
			parameters: GlobParams,
			async execute(_toolCallId, params, signal) {
				signal?.throwIfAborted();
				const input = params as GlobInput;
				return { content: [text(await files.glob({ ...input, path: at(input.path, input.repo) }))], details: { pattern: input.pattern } };
			},
		};
		return [read, ...changeTools(sandbox, profile), createShellTool(sandbox), grep, glob];
	};
}
