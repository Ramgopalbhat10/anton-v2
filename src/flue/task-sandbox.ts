import { Type } from '@earendil-works/pi-ai';
import { type Sandbox, type SandboxDriver, type SandboxToolFactory, sandboxFromDriver } from '@flue/runtime';
import { MAX_READ_LINES, numberedLines, READ_LINES } from '../services/repo-snapshot.ts';
import type { ToolProfile } from '../core/tool-profile.ts';
import type { GlobInput, GrepInput, ReadInput } from '../services/task-files.ts';
import { changeTools, type ImageSight, imageResult, imageType, text, type Tool } from './sandbox-tools.ts';
import { createShellTool } from './shell-tool.ts';

/** What the runtime reads from a working folder for its system prompt: the repository's instructions and its skills. */
const DISCOVERED = /(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|\.agents\/skills)$/;

/**
 * A repository task's sandbox from its first model call, before it has a machine. The runtime is given it at once,
 * so the tool list and the system prompt are the same before and after the machine starts. Commands and writes wait
 * for the machine (`machine(true)`, which gives the task its workspace); a file read here (an edit's or a patch's) comes from
 * the machine too, while the agent's own reads go through `taskTools`. The runtime reads AGENTS.md, CLAUDE.md,
 * `.agents/skills` and a listing of the working folder into the system prompt when a reply starts: it finds none of
 * them here, as they would come from the snapshot before the machine and from the machine after, and change the
 * prompt. Anton puts the repository's instructions and skills in from the commit the task started at instead.
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

/** Where `read`, `grep` and `glob` answer from: the snapshot or the machine, as the task stands (`task-files.ts`). */
export type TaskFiles = {
	read: (input: ReadInput) => Promise<string>;
	bytes: (path: string, repo?: string) => Promise<Uint8Array>;
	grep: (input: GrepInput) => Promise<string>;
	glob: (input: GlobInput) => Promise<string>;
};

const REPO = Type.Optional(Type.String({ description: "Another GitHub repository to read instead of this task's, as owner/name, optionally @branch, tag or commit" }));

/** Files of activated skills the runtime serves itself (Flue's packaged-skill overlay). */
const PACKAGED = '/.flue/packaged-skills/';

const ReadParams = Type.Object({
	path: Type.String({ description: 'Path from the repository root, or absolute' }),
	offset: Type.Optional(Type.Number({ description: 'First line to show' })),
	limit: Type.Optional(Type.Number({ description: `Lines to show (default ${READ_LINES}, at most ${MAX_READ_LINES})` })),
	repo: REPO,
});

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

/** `read`'s description, which says how its numbered lines go into the profile's editing tool. */
const READ_DESCRIPTION: Record<ToolProfile, string> = {
	edit:
		"Read a file with line numbers: each line comes as its number, a tab, then the line (leave the numbers out of edit's oldText). " +
		'Long files come in pages; pass offset to read on. An image (PNG, JPEG, GIF or WebP) comes back as the picture itself.',
	patch:
		'Read a file with line numbers: each line comes as its number, a tab, then the line (leave the numbers out of a patch). ' +
		'Long files come in pages; pass offset to read on. An image (PNG, JPEG, GIF or WebP) comes back as the picture itself.',
};

const whole = (value: unknown, min: number, max: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : undefined);

/**
 * A repository task's file and shell tools: `read`, `grep` and `glob` of its own, the same schema whether the
 * snapshot or the machine answers, so they never change; the profile's tools that change files (`write` and `edit`,
 * or `apply_patch`) and `bash` as `sandboxTools` has them, waiting for the machine. Paths are taken from the
 * session's folder, which a subagent may be given.
 */
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
				const input = params as ReadInput;
				const offset = whole(input.offset, 1, Number.MAX_SAFE_INTEGER);
				const limit = whole(input.limit, 1, MAX_READ_LINES);
				if (!input.repo && input.path.startsWith(PACKAGED)) return { content: [text(numberedLines(await sandbox.readFile(input.path), offset, limit))], details: { path: input.path } };
				const mimeType = imageType(input.path);
				if (mimeType) return imageResult(input.path, await files.bytes(at(input.path, input.repo) as string, input.repo), mimeType, sight);
				return { content: [text(await files.read({ path: at(input.path, input.repo) as string, offset, limit, repo: input.repo }))], details: { path: input.path } };
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
