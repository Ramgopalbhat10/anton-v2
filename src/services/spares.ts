import type { Acquired, Machine, SandboxProvider } from '../core/ports.ts';
import { config } from '../config.ts';
import { NotFoundError } from '../core/errors.ts';
import { withEnv } from '../core/machine-env.ts';
import { quote, run } from '../core/shell.ts';
import type { Project, SessionRecord } from '../core/types.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord, wasDeleted } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { repoDir } from './git.ts';
import { logProblem } from './log.ts';
import { machineRequest, previewEnv, readMarker, readyFile, setUpMachine } from './machine-setup.ts';
import { preparedImageFor, renewPreparedImage } from './prepared-images.ts';
import { sandboxSettings } from './sandbox-settings.ts';
import { envFor } from './secrets.ts';

/*
 * A spare is a sandbox started while a new task is still being typed, so it is set up by the time you send it.
 * The page chooses the task's id before the task exists, and the spare runs under that id: when the task is made,
 * its machine is already there to be found. It is set up to the base branch's head and marked as a spare, and the
 * task only moves it to its own branch. Nothing but Anton's setup ever runs on a spare, as no task has its id yet.
 * One the page stops asking for (cleared, sent elsewhere, the tab gone) is stopped after `config.spareWaitMs`.
 */

/**
 * A set-up spare: the machine as acquired (its connection open, so the task's first command is quick) and its marker.
 * `released` is set when it is let go, so a setup still under way stops rather than finishing for nobody.
 */
export type SetUpSpare = { acquired: Acquired; marker: string };
type Spare = { projectId: string; seenAt: number; ready: Promise<SetUpSpare | null>; released: boolean };

const spares = new Map<string, Spare>();
/** Task ids whose spare was let go, so a late ask for one starts nothing. The page picks a new id after it lets one go. */
const released = new Set<string>();
const RELEASED_KEPT = 500;
/** No more than this many sandboxes wait on drafts at a time, whatever the pages ask. */
const MAX_SPARES = 3;
const SWEEP_MS = 15_000;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PREFIX = 'spare:';
/** The ready marker of a spare for `taskId`, set up at `sha`. */
export const spareMarker = (taskId: string, sha: string) => `${PREFIX}${taskId}:${sha}`;

export function parseSpareMarker(marker: string): { taskId: string; sha: string } | null {
	if (!marker.startsWith(PREFIX)) return null;
	const [taskId, sha] = marker.slice(PREFIX.length).split(':');
	return taskId && sha ? { taskId, sha } : null;
}

const sandbox = (): SandboxProvider => getProviders().sandbox;

/**
 * Starts a spare for a task about to be sent on the repo, or keeps the one it has: the page asks again while the
 * draft stays. Returns whether one is starting or ready. A second draft on the same repo lets the first one's go.
 */
export async function wakeSpare(input: { projectId: string; taskId: string; branch?: string }): Promise<{ waking: boolean }> {
	const { projectId, taskId } = input;
	if (!config.wakeSandbox || !TASK_ID.test(taskId) || released.has(taskId)) return { waking: false };
	const known = spares.get(taskId);
	if (known) {
		known.seenAt = Date.now();
		return { waking: known.projectId === projectId };
	}
	const [project, taken] = await Promise.all([getProject(projectId), getSessionRecord(taskId).then((record) => record !== null || wasDeleted(taskId))]);
	if (!project) throw new NotFoundError('Project not found');
	// An id a task has, or had, is never a draft's.
	if (taken) return { waking: false };
	if (spares.has(taskId)) return wakeSpare(input);
	for (const [other, spare] of spares) if (spare.projectId === projectId) releaseSpare(other);
	if (spares.size >= MAX_SPARES) return { waking: false };
	const spare: Spare = { projectId, seenAt: Date.now(), ready: Promise.resolve(null), released: false };
	spares.set(taskId, spare);
	spare.ready = startSpare(project, taskId, input.branch, spare).catch((error: unknown) => {
		logProblem('warn', 'A sandbox woken for a draft did not start', error);
		if (spares.get(taskId) === spare) spares.delete(taskId);
		return null;
	});
	sweepSoon();
	return { waking: true };
}

async function startSpare(project: Project, taskId: string, branch: string | undefined, spare: Spare): Promise<SetUpSpare | null> {
	const settings = await sandboxSettings();
	const base = branch || project.defaultBranch;
	const sha = await getProviders().git.resolveRef(project.repoFullName, base);
	const image = preparedImageFor(project, settings);
	if (!image) renewPreparedImage(project.id);
	const request = { ...machineRequest(taskId, project, settings, image), state: null };
	let acquired = await sandbox().acquire(request);
	if (acquired.origin === 'live' || acquired.origin === 'resumed') {
		// Running already under this id: a spare Anton set up before it restarted, which is kept, or a setup cut short.
		const marker = await readMarker(acquired.machine);
		if (marker && parseSpareMarker(marker)?.taskId === taskId) return { acquired, marker };
		await sandbox().stop(acquired.state);
		acquired = await sandbox().acquire(request);
	}
	if (spare.released) {
		await sandbox().stop(acquired.state);
		return null;
	}
	const machine = withEnv(acquired.machine, { ...(await previewEnv(acquired.machine, project)), ...(await envFor(project)) });
	const marker = spareMarker(taskId, sha);
	await setUpMachine(machine, project, { marker, branch: base, sha }, acquired.origin === 'image' ? 'image' : 'clone');
	return { acquired, marker };
}

/** Stops a draft's spare, as when its text is cleared or its page closes. */
export function releaseSpare(taskId: string): void {
	const spare = spares.get(taskId);
	released.add(taskId);
	if (released.size > RELEASED_KEPT) released.delete(released.values().next().value as string);
	if (!spare) return;
	spares.delete(taskId);
	spare.released = true;
	void spare.ready
		.then((ready) => ready && sandbox().stop(ready.acquired.state))
		.catch((error: unknown) => logProblem('warn', 'Could not stop a sandbox woken for a draft', error));
}

/**
 * Hands a new task the spare started for it, waiting for its setup if it is still under way, so the task never starts
 * a second sandbox beside it. A spare for another repo, or for a task that runs on this server, is stopped instead.
 */
export async function claimSpare(session: SessionRecord): Promise<SetUpSpare | null> {
	const spare = spares.get(session.id);
	if (!spare) return null;
	spares.delete(session.id);
	const ready = await spare.ready;
	if (!ready) return null;
	if (spare.projectId === session.projectId && session.runOn === 'sandbox' && !session.machineState) return ready;
	await sandbox().stop(ready.acquired.state);
	return null;
}

/**
 * Puts a set-up spare on its task's branch in one command, when the task starts where the spare was set up. Returns
 * false when the base moved since (a newer commit, another branch): the task then sets it up as one from an image.
 */
export async function finishSpare(machine: Machine, marker: string, session: SessionRecord): Promise<boolean> {
	if (parseSpareMarker(marker)?.sha !== session.baseSha) return false;
	await run(machine, `git checkout -q -B ${quote(session.branch)} && printf %s ${quote(session.id)} > ${quote(readyFile(machine))}`, { cwd: repoDir(machine) });
	return true;
}

let sweeping: NodeJS.Timeout | undefined;

/** Stops spares the page stopped asking for; the sweep ends when none are left. */
function sweepSoon(): void {
	sweeping ??= setInterval(() => {
		const now = Date.now();
		for (const [taskId, spare] of spares) if (now - spare.seenAt > config.spareWaitMs) releaseSpare(taskId);
		if (spares.size === 0) {
			clearInterval(sweeping);
			sweeping = undefined;
		}
	}, SWEEP_MS);
	sweeping.unref();
}

/** Drafts with a sandbox waiting, for tests and the Compute view. */
export const sparesWaiting = (): string[] => [...spares.keys()];
