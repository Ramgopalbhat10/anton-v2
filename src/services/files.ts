import { readMachineFile } from '../core/machine-fs.ts';
import { safeRelativePath, text } from '../core/shell.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { type Checkpoint, type SavedOutput, readBlob, readCheckpoint, readCheckpointPatch, readOutput } from './checkpoints.ts';
import { type FileChange, type LogEntry, changes, listFiles, repoDir } from './git.ts';
import type { Machine } from '../core/ports.ts';
import { liveMachine } from './workspace.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';

/**
 * Where a task's files are read from, best first: its running machine, its
 * last checkpoint, or the commit it started from. Viewing never starts a
 * machine.
 */
export type Source = 'live' | 'saved' | 'base';

export type FileTree = { source: Source; at: string | null; paths: string[]; changes: FileChange[] };
export type ChangesView = { source: Source; at: string | null; branch: string; baseBranch: string; patch: string; log: LogEntry[] };
export type OutputsView = { source: Source; at: string | null; outputs: Array<Omit<SavedOutput, 'key'>> };

type Context = {
	id: string;
	repo: string;
	baseSha: string;
	branch: string;
	baseBranch: string;
	checkpoint: Checkpoint | null;
	machine: Machine | null;
	source: Source;
};

async function context(id: string): Promise<Context> {
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	if (!session || !project) throw new NotFoundError('Session not found');
	const [machine, checkpoint] = await Promise.all([liveMachine(id), readCheckpoint(id)]);
	const source: Source = machine ? 'live' : checkpoint ? 'saved' : 'base';
	return {
		id,
		repo: project.repoFullName,
		baseSha: session.baseSha,
		branch: session.branch,
		baseBranch: session.baseBranch,
		checkpoint,
		machine,
		source,
	};
}

/** The repo tree at a commit, cached forever because commits never change. */
async function baseTree(repo: string, sha: string): Promise<string[]> {
	const { store, git } = getProviders();
	const key = `trees/${repo}/${sha}.json`;
	const cached = await store.get(key);
	if (cached) return JSON.parse(text(cached)) as string[];
	const paths = await git.tree(repo, sha);
	await store.put(key, JSON.stringify(paths), 'application/json');
	return paths;
}

function overlay(paths: string[], files: FileChange[]): string[] {
	const removed = new Set(files.filter((file) => file.status === 'D').map((file) => file.path));
	const added = files.filter((file) => file.status === 'A').map((file) => file.path);
	return [...paths.filter((path) => !removed.has(path)), ...added].sort();
}

const trees: Record<Source, (ctx: Context) => Promise<Omit<FileTree, 'source' | 'at'>>> = {
	async live(ctx) {
		const machine = ctx.machine as Machine;
		const [paths, diff] = await Promise.all([listFiles(machine), changes(machine, ctx.baseSha)]);
		return { paths, changes: diff.files };
	},
	async saved(ctx) {
		const files = ctx.checkpoint?.files ?? [];
		return { paths: overlay(await baseTree(ctx.repo, ctx.baseSha), files), changes: files };
	},
	base: async (ctx) => ({ paths: await baseTree(ctx.repo, ctx.baseSha), changes: [] }),
};

/** Files offered before a task exists, from the selected repository branch. Never acquires a machine. */
export async function projectFiles(projectId: string, branch?: string): Promise<string[]> {
	const project = await getProject(projectId);
	if (!project) throw new NotFoundError('Project not found');
	const sha = await getProviders().git.resolveRef(project.repoFullName, branch || project.defaultBranch);
	return baseTree(project.repoFullName, sha);
}

export async function fileTree(id: string): Promise<FileTree> {
	const ctx = await context(id);
	return { source: ctx.source, at: ctx.checkpoint?.at ?? null, ...(await trees[ctx.source](ctx)) };
}

async function savedOrBase(ctx: Context, path: string): Promise<Uint8Array> {
	const saved = ctx.checkpoint?.files.find((file) => file.path === path);
	if (saved?.status === 'D') throw new NotFoundError('File was deleted');
	if (saved?.blob) return (await readBlob(saved.blob)) ?? Promise.reject(new NotFoundError('Saved file is missing'));
	if (saved) throw new InvalidInputError('File too large to preview');
	return getProviders().git.file(ctx.repo, ctx.baseSha, path);
}

export async function readFile(id: string, rawPath: string): Promise<Uint8Array> {
	const path = safeRelativePath(rawPath);
	const ctx = await context(id);
	if (!ctx.machine) return savedOrBase(ctx, path);
	return readMachineFile(ctx.machine, `${repoDir(ctx.machine)}/${path}`);
}

export async function changesView(id: string): Promise<ChangesView> {
	const ctx = await context(id);
	const header = { source: ctx.source, at: ctx.checkpoint?.at ?? null, branch: ctx.branch, baseBranch: ctx.baseBranch };
	if (ctx.machine) {
		const diff = await changes(ctx.machine, ctx.baseSha);
		return { ...header, patch: diff.patch, log: diff.log };
	}
	return { ...header, patch: await readCheckpointPatch(id), log: ctx.checkpoint?.log ?? [] };
}

/** Outputs come from storage, so they are listed the same way whether or not the machine runs. */
export async function outputsView(id: string): Promise<OutputsView> {
	const ctx = await context(id);
	const outputs = (ctx.checkpoint?.outputs ?? []).map(({ key: _key, ...output }) => output);
	return { source: ctx.source, at: ctx.checkpoint?.at ?? null, outputs };
}

export async function readOutputFile(id: string, rawPath: string): Promise<Uint8Array | null> {
	return readOutput(id, safeRelativePath(rawPath));
}
