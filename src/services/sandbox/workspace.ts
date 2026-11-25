import type { Acquired, Machine, MachineOrigin } from '../../core/ports.ts';
import { config } from '../../config.ts';
import { announce } from '../../core/changes.ts';
import { withEnv, withSignal } from '../../core/machine-env.ts';
import type { Project, SessionRecord } from '../../core/types.ts';
import { getProject } from '../../db/projects.ts';
import { getSessionRecord, updateSession } from '../../db/sessions.ts';
import { applyFiles, copyLibrary, readCheckpoint } from '../git/checkpoints.ts';
import { isWorking } from '../tasks/activity.ts';
import { logProblem } from '../../core/log.ts';
import { notifySandboxFailed, notifySandboxReady } from '../notify/notifications.ts';
import { machineRequest, previewEnv, readMarker, setUpMachine } from './machine-setup.ts';
import { dropLostImage, preparedImageFor, renewPreparedImage } from './prepared-images.ts';
import { copySpaceFiles } from '../projects/space-files.ts';
import { sandboxSettings } from './sandbox-settings.ts';
import { envFor } from '../secrets/secrets.ts';
import { claimSpare, finishSpare, parseSpareMarker } from './spares.ts';
import { runnerFor, runnerOf } from '../tasks/runners.ts';

export { previewHosts, previewPortsFor } from './machine-setup.ts';

type Context = { machine: Machine; session: SessionRecord; project: Project | null };

/** Tasks from before the ready marker. Newer tasks always get it, so a checkpoint saved after a failed setup never counts as ready. */
const setUpBeforeMarker = (session: SessionRecord, origin: MachineOrigin) =>
	session.legacySetup && (origin === 'live' || origin === 'resumed') && session.checkpointAt !== null;

/** Images carry the marker of the machine they were made in, so they never count. */
type Readiness = { state: 'ready' } | { state: 'spare'; marker: string } | { state: 'unready' };

async function readinessOf(machine: Machine, session: SessionRecord, origin: MachineOrigin): Promise<Readiness> {
	const marker = await readMarker(machine);
	if (marker === null) return { state: setUpBeforeMarker(session, origin) ? 'ready' : 'unready' };
	if (marker === session.id) return { state: 'ready' };
	return parseSpareMarker(marker)?.taskId === session.id ? { state: 'spare', marker } : { state: 'unready' };
}

async function prepare(context: Context, origin: MachineOrigin): Promise<void> {
	const { machine, session, project } = context;
	const from = !project ? 'scratch' : origin === 'image' ? 'image' : 'clone';
	const installed = await setUpMachine(machine, project, { marker: session.id, branch: session.branch, sha: session.baseSha }, from);
	// Built in its own sandbox in the background, so no task waits on a snapshot. Not for a task on this server: images belong to the sandbox.
	if (project && session.runOn !== 'host') renewPreparedImage(project.id, from === 'image' && installed);
	await putBackSavedFiles(machine, session.id);
}

/** After the image, so no image holds a task's files; a file that cannot be put back is logged, not fatal. */
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

/** Setup runs with Anton's credentials, so a machine of its own without the marker (maybe used since) is set aside for a fresh one. */
async function acquireReady(session: SessionRecord, project: Project | null): Promise<{ acquired: Acquired; readiness: Readiness }> {
	const sandbox = runnerFor(session.runOn);
	const settings = await sandboxSettings();
	const request = machineRequest(session.id, project, settings, project && session.runOn !== 'host' ? preparedImageFor(project, settings) : null);
	const acquired = await sandbox.acquire({ ...request, state: session.machineState });
	if (project) await dropLostImage(project, request.image, acquired.origin);
	const readiness = await readinessOf(acquired.machine, session, acquired.origin);
	if (readiness.state !== 'unready' || !isUsed(acquired.origin)) return { acquired, readiness };
	await sandbox.stop(acquired.state);
	return { acquired: await sandbox.acquire({ ...request, state: null }), readiness: { state: 'unready' } };
}

/** Each start under way, so Stop can end its setup rather than leave a clone and an install running for nobody. */
const setups = new Map<string, { controller: AbortController; stopped: Promise<boolean> }>();

/**
 * Ends the task's start if one is under way, once its machine is stopped, and says whether it did. Its record then
 * forgets the machine, so the task's next message reads the repository snapshot again rather than wait for a new setup.
 */
export async function stopSetup(id: string): Promise<boolean> {
	const setup = setups.get(id);
	if (!setup || setup.controller.signal.aborted) return false;
	setup.controller.abort(new Error('The task was stopped while its workspace was being set up.'));
	// A start that finished before the abort reached it has a machine like any other, for Stop to save and stop.
	return setup.stopped;
}

async function provision(id: string): Promise<Machine> {
	const controller = new AbortController();
	const work = provisionWith(id, controller.signal);
	const setup = { controller, stopped: work.then(() => false, () => true) };
	setups.set(id, setup);
	try {
		return await work;
	} catch (error) {
		// Only while no newer start owns the task, whose record holds its own machine.
		if (controller.signal.aborted && setups.get(id) === setup) await updateSession(id, { machineState: null, failed: false, errorMessage: null });
		throw error;
	} finally {
		if (setups.get(id) === setup) setups.delete(id);
	}
}

async function provisionWith(id: string, signal: AbortSignal): Promise<Machine> {
	const startedAt = Date.now();
	const { session, project } = await load(id);
	// Wait for a spare woken while the task was typed rather than start a second one.
	const spare = await claimSpare(session).catch((error: unknown) => {
		logProblem('warn', 'The sandbox woken for this task could not be used', error, id);
		return null;
	});
	const { acquired, readiness } = spare ? { acquired: spare.acquired, readiness: { state: 'spare', marker: spare.marker } as const } : await acquireReady(session, project);
	const ports = await previewEnv(acquired.machine, project);
	// A review task's repo may be added only by pasting a link and its install scripts are its owner's code: it gets the repo's
	// own variables only, never the shared ones, and a pull request whose author cannot push to the repo gets none.
	const variables = session.review ? (project?.env ?? {}) : await envFor(project);
	const setupMachine = withEnv(acquired.machine, { ...ports, ...variables });
	const machine = session.review && !session.review.trusted ? withEnv(acquired.machine, ports) : setupMachine;
	await updateSession(id, { machineState: acquired.state, failed: false, errorMessage: null });
	const acquiredAt = Date.now();
	// Beside the repo, so copied while it is set up.
	const files = Promise.all([
		// Each start, since project files can be added at any time.
		session.spaceId ? copySpaceFiles(machine, id).catch((error: unknown) => logProblem('warn', 'Could not copy the project files', error, id)) : null,
		// So do the files attached to its messages before it had a sandbox, and, in a fresh machine, what it saved before.
		copyLibrary(machine, id).catch((error: unknown) => logProblem('warn', 'Could not put the Library back', error, id)),
	]);
	try {
		const context = { machine: withSignal(setupMachine, signal), session, project };
		if (readiness.state === 'spare') {
			if (!(await finishSpare(setupMachine, readiness.marker, session))) await prepare(context, 'image');
		} else if (readiness.state === 'unready') await prepare(context, acquired.origin);
	} catch (error) {
		await files;
		if (signal.aborted) {
			await runnerFor(session.runOn).stop(acquired.state).catch((stopError: unknown) => logProblem('warn', 'Could not stop a machine stopped during its setup', stopError, id));
			throw signal.reason ?? error;
		}
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
/** Cached so a burst of UI requests resolves one sandbox, and for as long as the agent works and the machine runs. */
const CACHE_MS = 20_000;

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

/** Not for a chat unless a routine started it, a plan or review (they read first), a task on this server, or one that already has a machine. */
export async function prewarmMachine(id: string): Promise<void> {
	if (!config.prewarmSandbox || machines.has(id)) return;
	const session = await getSessionRecord(id);
	if (!session || (!session.projectId && !session.automationId) || session.machineState || session.planMode || session.review || session.runOn === 'host' || machines.has(id)) return;
	await machineFor(id).catch((error: unknown) => logProblem('warn', 'The sandbox did not start ahead of the agent', error, id));
}

/** For a task that has had a machine or one `prewarmMachine` would start. Never for a review or a task on this server. */
export async function wakeMachine(id: string): Promise<{ waking: boolean }> {
	if (!config.wakeSandbox) return { waking: false };
	if (machines.has(id)) return { waking: true };
	const session = await getSessionRecord(id);
	if (!session || session.review || session.runOn === 'host') return { waking: false };
	if (!session.machineState && ((!session.projectId && !session.automationId) || session.planMode)) return { waking: false };
	void machineFor(id).catch((error: unknown) => logProblem('warn', 'The sandbox did not start while the message was typed', error, id));
	return { waking: true };
}

export async function liveMachine(id: string): Promise<Machine | null> {
	const cached = machines.get(id);
	if (cached && !starting.has(id)) return cached;
	return findMachine(id);
}

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
