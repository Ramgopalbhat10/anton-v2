import type { Acquired, Machine, MachineOrigin } from '../core/ports.ts';
import { config } from '../config.ts';
import { announce } from '../core/changes.ts';
import { withEnv } from '../core/machine-env.ts';
import type { Project, SessionRecord } from '../core/types.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { applyFiles, copyLibrary, readCheckpoint } from './checkpoints.ts';
import { isWorking } from './activity.ts';
import { logProblem } from './log.ts';
import { notifySandboxFailed, notifySandboxReady } from './notifications.ts';
import { machineRequest, previewEnv, readMarker, setUpMachine } from './machine-setup.ts';
import { preparedImageFor, renewPreparedImage } from './prepared-images.ts';
import { copySpaceFiles } from './space-files.ts';
import { sandboxSettings } from './sandbox-settings.ts';
import { envFor } from './secrets.ts';
import { claimSpare, finishSpare, parseSpareMarker } from './spares.ts';
import { runnerFor, runnerOf } from './runners.ts';

export { previewHosts, previewPortsFor } from './machine-setup.ts';

/** A chat's project is null: it has no repository, so its sandbox starts from an empty scratch folder. */
type Context = { machine: Machine; session: SessionRecord; project: Project | null };

/**
 * Machines of tasks created before the ready marker existed: their own machine,
 * once it has saved a checkpoint. Newer tasks always get the marker, so a
 * checkpoint saved after a failed or stopped setup never counts as ready.
 */
const setUpBeforeMarker = (session: SessionRecord, origin: MachineOrigin) =>
	session.legacySetup && (origin === 'live' || origin === 'resumed') && session.checkpointAt !== null;

/**
 * Whether the machine is the task's own and set up (its marker holds the task id), a spare set up for it while it
 * was typed, or neither. Images carry the marker of the machine they were made in, so they never count.
 */
type Readiness = { state: 'ready' } | { state: 'spare'; marker: string } | { state: 'unready' };

async function readinessOf(machine: Machine, session: SessionRecord, origin: MachineOrigin): Promise<Readiness> {
	const marker = await readMarker(machine);
	if (marker === null) return { state: setUpBeforeMarker(session, origin) ? 'ready' : 'unready' };
	if (marker === session.id) return { state: 'ready' };
	return parseSpareMarker(marker)?.taskId === session.id ? { state: 'spare', marker } : { state: 'unready' };
}

/** Sets up a machine that is not ready yet: one fresh from an image or the toolchain. */
async function prepare(context: Context, origin: MachineOrigin): Promise<void> {
	const { machine, session, project } = context;
	const from = !project ? 'scratch' : origin === 'image' ? 'image' : 'clone';
	const installed = await setUpMachine(machine, project, { marker: session.id, branch: session.branch, sha: session.baseSha }, from);
	// The repo's image is built in a sandbox of its own, in the background, so no task waits on a snapshot: when it is
	// missing or old, or when this task found the lockfile changed and had to install. A task on this server makes
	// none, as images belong to the sandbox, where the next task on the repo starts.
	if (project && session.runOn !== 'host') renewPreparedImage(project.id, from === 'image' && installed);
	await putBackSavedFiles(machine, session.id);
}

/**
 * A fresh machine for a task that has saved files (a fork, or a task whose
 * sandbox is gone) starts from them. After the image, so no image holds a
 * task's files; a file that cannot be put back is logged, not fatal.
 */
async function putBackSavedFiles(machine: Machine, id: string): Promise<void> {
	const checkpoint = await readCheckpoint(id);
	if (!checkpoint) return;
	const skipped = await applyFiles(machine, checkpoint.files).catch((error: unknown) => {
		logProblem('warn', 'Putting saved files back failed', error, id);
		return [];
	});
	if (skipped.length > 0) logProblem('warn', 'Some saved files were too large to put back', skipped.join(', '), id);
}

async function load(id: string): Promise<{ session: SessionRecord; project: Project | null }> {
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	if (!session || (session.projectId && !project)) throw new Error(`Session ${id} not found`);
	return { session, project };
}

const isUsed = (origin: MachineOrigin) => origin === 'live' || origin === 'resumed';

/**
 * The task's machine, set up or ready to be. A machine of its own that lacks
 * the marker may have been used by the agent or the terminal since, and
 * setup runs with Anton's credentials, so it is set aside for a fresh one.
 */
async function acquireReady(session: SessionRecord, project: Project | null): Promise<{ acquired: Acquired; readiness: Readiness }> {
	const sandbox = runnerFor(session.runOn);
	const settings = await sandboxSettings();
	const request = machineRequest(session.id, project, settings, project && session.runOn !== 'host' ? preparedImageFor(project, settings) : null);
	const acquired = await sandbox.acquire({ ...request, state: session.machineState });
	const readiness = await readinessOf(acquired.machine, session, acquired.origin);
	if (readiness.state !== 'unready' || !isUsed(acquired.origin)) return { acquired, readiness };
	await sandbox.stop(acquired.state);
	return { acquired: await sandbox.acquire({ ...request, state: null }), readiness: { state: 'unready' } };
}

async function provision(id: string): Promise<Machine> {
	const startedAt = Date.now();
	const { session, project } = await load(id);
	// A sandbox woken while the task was typed is set up, or nearly: wait for it rather than start a second one, and
	// keep its open connection rather than look it up again.
	const spare = await claimSpare(session).catch((error: unknown) => {
		logProblem('warn', 'The sandbox woken for this task could not be used', error, id);
		return null;
	});
	const { acquired, readiness } = spare ? { acquired: spare.acquired, readiness: { state: 'spare', marker: spare.marker } as const } : await acquireReady(session, project);
	const ports = await previewEnv(acquired.machine, project);
	// A review task may be on a repo added only by pasting a link, whose own install scripts are its owner's code:
	// it gets the repo's own variables (none unless you set some), never the shared ones, and the code of a
	// pull request whose author cannot push to the repo gets none at all.
	const variables = session.review ? (project?.env ?? {}) : await envFor(project);
	const setupMachine = withEnv(acquired.machine, { ...ports, ...variables });
	const machine = session.review && !session.review.trusted ? withEnv(acquired.machine, ports) : setupMachine;
	await updateSession(id, { machineState: acquired.state, failed: false, errorMessage: null });
	const acquiredAt = Date.now();
	// They sit beside the repo, not in it, so they are copied while it is set up rather than after.
	const files = Promise.all([
		// A project's thread gets the project's files beside its repo, each start, since files can be added at any time.
		session.spaceId ? copySpaceFiles(machine, id).catch((error: unknown) => logProblem('warn', 'Could not copy the project files', error, id)) : null,
		// So do the files attached to its messages before it had a sandbox, and, in a fresh machine, what it saved before.
		copyLibrary(machine, id).catch((error: unknown) => logProblem('warn', 'Could not put the Library back', error, id)),
	]);
	try {
		const context = { machine: setupMachine, session, project };
		if (readiness.state === 'spare') {
			if (!(await finishSpare(setupMachine, readiness.marker, session))) await prepare(context, 'image');
		} else if (readiness.state === 'unready') await prepare(context, acquired.origin);
	} catch (error) {
		await files;
		await updateSession(id, { failed: true, errorMessage: error instanceof Error ? error.message : String(error) });
		notifySandboxFailed(session, error);
		throw error;
	}
	const setUpAt = Date.now();
	await files;
	const how = readiness.state === 'spare' ? 'woken while typed' : readiness.state === 'ready' ? acquired.origin : `${acquired.origin}, set up`;
	console.info(`[anton] Sandbox for ${id} ready in ${Date.now() - startedAt} ms (${how}; machine ${acquiredAt - startedAt} ms, setup ${setUpAt - acquiredAt} ms, files ${Date.now() - acquiredAt} ms)`);
	// A new sandbox is news; one resumed from its saved state, or still running, is not.
	if (readiness.state !== 'ready' || !isUsed(acquired.origin)) notifySandboxReady(session, Date.now() - startedAt);
	return machine;
}

const machines = new Map<string, Promise<Machine>>();
const starting = new Set<string>();
/**
 * Machines stay cached briefly so a burst of UI requests resolves one sandbox, and for as long as the task's
 * agent works and the machine runs, since each of its computer steps and messages asks for it again.
 */
const CACHE_MS = 20_000;

/** The task's machine, started or resumed if it is not running. */
export function machineFor(id: string): Promise<Machine> {
	const cached = machines.get(id);
	if (cached) return cached;
	const pending = provision(id);
	machines.set(id, pending);
	starting.add(id);
	announce({ kind: 'task', id, what: 'state' });
	// Only this start's own entry is cleared: after Stop and Resume a newer start may own the id.
	const current = () => machines.get(id) === pending;
	const expire = (): void => {
		setTimeout(async () => {
			if (!current()) return;
			if (isWorking(id) && (await findMachine(id).catch(() => null))) return expire();
			if (current()) machines.delete(id);
		}, CACHE_MS).unref();
	};
	pending
		.then(expire, () => current() && machines.delete(id))
		.finally(() => {
			if (current() || !machines.has(id)) starting.delete(id);
			announce({ kind: 'task', id, what: 'state' });
		});
	return pending;
}

/**
 * Starts a repository task's machine as its agent starts a reply, so its first command or edit (or a routine chat's
 * `start_workspace`) finds it started or starting; its reads need none.
 * Not for a chat (most never need one) unless a routine started it (routine runs mostly run a skill's scripts, and
 * nobody is waiting to see whether they will), a task planning or reviewing (they read first), one that runs on this
 * server, or one that already has a machine. Nothing waits for it, and a start that fails is tried again when the agent asks.
 */
export async function prewarmMachine(id: string): Promise<void> {
	if (!config.prewarmSandbox || machines.has(id)) return;
	const session = await getSessionRecord(id);
	if (!session || (!session.projectId && !session.automationId) || session.machineState || session.planMode || session.review || session.runOn === 'host' || machines.has(id)) return;
	await machineFor(id).catch((error: unknown) => logProblem('warn', 'The sandbox did not start ahead of the agent', error, id));
}

/**
 * Starts a task's machine while a message to it is being typed, so it is up, or nearly, when the message is sent.
 * For a task that has had a machine (it is likely to need it again, and comes back from its saved state), or one
 * `prewarmMachine` would start as the agent replies. Never for a review or a task on this server. One that stays
 * unused stops after its idle minutes. Returns whether a start is under way.
 */
export async function wakeMachine(id: string): Promise<{ waking: boolean }> {
	if (!config.wakeSandbox) return { waking: false };
	if (machines.has(id)) return { waking: true };
	const session = await getSessionRecord(id);
	if (!session || session.review || session.runOn === 'host') return { waking: false };
	if (!session.machineState && ((!session.projectId && !session.automationId) || session.planMode)) return { waking: false };
	void machineFor(id).catch((error: unknown) => logProblem('warn', 'The sandbox did not start while the message was typed', error, id));
	return { waking: true };
}

/** The task's machine only if it is already running. */
export async function liveMachine(id: string): Promise<Machine | null> {
	const cached = machines.get(id);
	if (cached && !starting.has(id)) return cached;
	return findMachine(id);
}

/** The task's running machine, asked of the runner its task names; none for an id that is no task. */
async function findMachine(id: string): Promise<Machine | null> {
	const runner = await runnerOf(id);
	return runner ? runner.find(id) : null;
}

export function isStarting(id: string): boolean {
	return starting.has(id);
}

export function forgetMachine(id: string): void {
	machines.delete(id);
}
