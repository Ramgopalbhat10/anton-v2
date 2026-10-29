import { uploadName } from '../core/upload-name.ts';
import { readMachineFile } from '../core/machine-fs.ts';
import { safeRelativePath, text } from '../core/shell.ts';
import { deletedOutputs, deletePage, noteDeletedOutput } from '../db/pages.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import type { SessionRecord } from '../core/types.ts';
import { hasCommit } from './host-commits.ts';
import { logProblem } from './log.ts';
import { getProviders } from '../providers/index.ts';
import { type Checkpoint, type SavedOutput, deleteOutput, readBlob, readCheckpoint, readCheckpointPatch, readOutput, readUnpushedPatch, saveOutput, savedOutputs } from './checkpoints.ts';
import { announce } from '../core/changes.ts';
import { writeMachineFile } from '../core/machine-fs.ts';
import { quote, run } from '../core/shell.ts';
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
/**
 * What Changes shows. `unpushed` (the default) is the work the host lacks: the diff from the commit Anton last
 * pushed, or the whole branch before any push, so it empties once a pull request has everything. `branch` is
 * everything since the task began, pushed or not.
 */
export type ChangesScope = 'unpushed' | 'branch';
export type ChangesView = {
	source: Source;
	at: string | null;
	branch: string;
	baseBranch: string;
	scope: ChangesScope;
	/** The commit the unpushed diff starts from; null before anything was pushed. */
	pushedSha: string | null;
	patch: string;
	log: LogEntry[];
};
export type OutputsView = {
	source: Source;
	at: string | null;
	outputs: Array<Omit<SavedOutput, 'key'>>;
	/** Files you deleted that the Library no longer has, so a reply that showed one says so. */
	deleted: string[];
};

type Context = {
	id: string;
	/** Empty for a chat, whose scratch folder starts empty. */
	repo: string;
	baseSha: string;
	pushedSha: string | null;
	branch: string;
	baseBranch: string;
	checkpoint: Checkpoint | null;
	machine: Machine | null;
	source: Source;
};

/** Tasks whose pushed commit was looked up on the host, so a task that has none is asked once. */
const lookedUp = new Set<string>();

/**
 * Where the task's branch stands on the host, for a pull request opened before Anton kept what it pushed:
 * the branch's head, or the pull request's once a merge deleted the branch. Kept, so it is asked once.
 */
async function pushedHead(session: SessionRecord, repo: string): Promise<string | null> {
	if (!session.prUrl || session.review || !repo || lookedUp.has(session.id)) return null;
	lookedUp.add(session.id);
	const { git } = getProviders();
	try {
		const head = (await git.branchHead(repo, session.branch)) ?? (await git.pullRequest(session.prUrl)).headSha;
		await updateSession(session.id, { pushedSha: head });
		return head;
	} catch (error) {
		logProblem('warn', 'Could not read what was pushed', error, session.id);
		return null;
	}
}

async function context(id: string): Promise<Context> {
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	if (!session || (session.projectId && !project)) throw new NotFoundError('Session not found');
	const [machine, checkpoint] = await Promise.all([liveMachine(id), readCheckpoint(id)]);
	const source: Source = machine ? 'live' : checkpoint ? 'saved' : 'base';
	return {
		id,
		repo: project?.repoFullName ?? '',
		baseSha: session.baseSha,
		pushedSha: session.pushedSha ?? (await pushedHead(session, project?.repoFullName ?? '')),
		branch: session.branch,
		baseBranch: session.baseBranch,
		checkpoint,
		machine,
		source,
	};
}

/** The repo tree at a commit, cached forever because commits never change; a chat's starts with none. */
async function baseTree(repo: string, sha: string): Promise<string[]> {
	if (!repo) return [];
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
	if (!ctx.repo) throw new NotFoundError('File not found');
	return getProviders().git.file(ctx.repo, ctx.baseSha, path);
}

export async function readFile(id: string, rawPath: string): Promise<Uint8Array> {
	const path = safeRelativePath(rawPath);
	const ctx = await context(id);
	if (!ctx.machine) return savedOrBase(ctx, path);
	return readMachineFile(ctx.machine, `${repoDir(ctx.machine)}/${path}`);
}

/** Marks the commits a checkpoint saved before it kept which were pushed: the pushed one and every one older. */
function markPushed(log: LogEntry[], pushedSha: string | null): LogEntry[] {
	if (!pushedSha || log.some((entry) => entry.pushed !== undefined)) return log;
	const at = log.findIndex((entry) => entry.sha === pushedSha);
	return at === -1 ? log : log.map((entry, index) => ({ ...entry, pushed: index >= at }));
}

/** The checkpoint's unpushed work, when it was saved knowing what was pushed. */
async function savedUnpushed(ctx: Context): Promise<string> {
	const checkpoint = ctx.checkpoint;
	if (!checkpoint) return '';
	if (checkpoint.unpushed && checkpoint.unpushed.pushedSha === ctx.pushedSha) return readUnpushedPatch(ctx.id, checkpoint);
	// Saved before it kept unpushed work: a checkpoint whose branch ends at the pushed commit had nothing more, as
	// a push commits everything first; otherwise there is no telling, so the whole branch shows.
	if (ctx.pushedSha && checkpoint.log[0]?.sha === ctx.pushedSha) return '';
	return readCheckpointPatch(ctx.id);
}

export async function changesView(id: string, scope: ChangesScope = 'unpushed'): Promise<ChangesView> {
	const ctx = await context(id);
	const header = { source: ctx.source, at: ctx.checkpoint?.at ?? null, branch: ctx.branch, baseBranch: ctx.baseBranch, scope };
	if (ctx.machine) {
		const pushedSha = ctx.pushedSha && (await hasCommit(ctx.machine, ctx.pushedSha)) ? ctx.pushedSha : null;
		const diff = await changes(ctx.machine, ctx.baseSha, scope === 'unpushed' ? pushedSha : null);
		const log = scope === 'unpushed' ? diff.log : (await changes(ctx.machine, ctx.baseSha, pushedSha)).log;
		return { ...header, pushedSha, patch: diff.patch, log };
	}
	const patch = scope === 'unpushed' ? await savedUnpushed(ctx) : await readCheckpointPatch(id);
	return { ...header, pushedSha: ctx.pushedSha, patch, log: markPushed(ctx.checkpoint?.log ?? [], ctx.pushedSha) };
}

/** Outputs come from storage, so they are listed the same way whether or not the machine runs. */
/** What the machine wrote, as its last checkpoint copied it, and what was saved straight to storage. */
function library(checkpoint: Checkpoint | null, saved: SavedOutput[]): OutputsView['outputs'] {
	const fromMachine = checkpoint?.outputs ?? [];
	const all = [...fromMachine, ...saved.filter((output) => !fromMachine.some((other) => other.path === output.path))];
	return all.map(({ key: _key, ...output }) => output);
}

export async function outputsView(id: string): Promise<OutputsView> {
	const [ctx, saved, removed] = await Promise.all([context(id), savedOutputs(id), deletedOutputs(id)]);
	const outputs = library(ctx.checkpoint, saved);
	// One the agent wrote again since is back, and no longer deleted.
	const kept = new Set(outputs.map((output) => output.path));
	return { source: ctx.source, at: ctx.checkpoint?.at ?? null, outputs, deleted: removed.filter((path) => !kept.has(path)) };
}

/** The task's Library as stored, without asking its machine: for the Artifacts page. */
export async function storedOutputs(id: string): Promise<OutputsView['outputs']> {
	const [checkpoint, saved] = await Promise.all([readCheckpoint(id), savedOutputs(id)]);
	return library(checkpoint, saved);
}

/** The largest file the Library takes as an upload. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** The largest output read from a running sandbox before it is saved. */
const MAX_LIVE_OUTPUT_BYTES = 50 * 1024 * 1024;

/**
 * Adds a file you upload to the task's Library, under `uploads/`. With a
 * sandbox running it also goes into the outputs folder there, so the agent
 * can read it.
 */
export async function uploadOutput(id: string, name: string, bytes: Uint8Array, contentType?: string): Promise<string> {
	if (!(await getSessionRecord(id))) throw new NotFoundError('Session not found');
	if (bytes.length > MAX_UPLOAD_BYTES) throw new InvalidInputError('Files up to 20 MB can be added to the Library.');
	const base = uploadName(name);
	const path = safeRelativePath(`uploads/${base}`);
	await saveOutput(id, path, bytes, contentType);
	const machine = await liveMachine(id);
	if (machine) {
		await machine.exec(`mkdir -p ${quote(`${machine.root}/outputs/uploads`)}`);
		await writeMachineFile(machine, `${machine.root}/outputs/${path}`, bytes);
	}
	announce({ kind: 'task', id, what: 'files' });
	return path;
}

/** Removes a file from the task's Library, from its sandbox too when one runs. */
export async function removeOutput(id: string, rawPath: string): Promise<void> {
	const path = safeRelativePath(rawPath);
	const machine = await liveMachine(id);
	if (machine) await machine.exec(`rm -f ${quote(`${machine.root}/outputs/${path}`)}`);
	await deleteOutput(id, path);
	await deletePage(id, path);
	await noteDeletedOutput(id, path);
	announce({ kind: 'task', id, what: 'files' });
}

/**
 * A file in the task's Library. Outputs the agent writes in its sandbox reach
 * storage at the end of its reply (a checkpoint), so one it made this reply,
 * such as a screenshot it just took, is read from the running sandbox until
 * then; a stopped one is never started for it.
 */
export async function readOutputFile(id: string, rawPath: string): Promise<Uint8Array | null> {
	const path = safeRelativePath(rawPath);
	const saved = await readOutput(id, path);
	if (saved) return saved;
	const machine = await liveMachine(id).catch(() => null);
	if (!machine) return null;
	const file = `${machine.root}/outputs/${path}`;
	const size = (await run(machine, `stat -c %s -- ${quote(file)}`).catch(() => '')).trim();
	if (!/^\d+$/.test(size) || Number(size) > MAX_LIVE_OUTPUT_BYTES) return null;
	return readMachineFile(machine, file).catch(() => null);
}
