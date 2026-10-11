import type { Acquired, Machine, MachineOrigin } from '../core/ports.ts';
import { announce } from '../core/changes.ts';
import { withEnv } from '../core/machine-env.ts';
import { quote, run, text } from '../core/shell.ts';
import type { Project, SessionRecord } from '../core/types.ts';
import { getProject, setWarmImage } from '../db/projects.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { applyFiles, readCheckpoint } from './checkpoints.ts';
import { checkoutTaskBranch, cloneRepo, repoDir } from './git.ts';
import { logProblem } from './log.ts';
import { copySpaceFiles } from './space-files.ts';
import { resourcesFrom, type SandboxSettings, sandboxSettings } from './sandbox-settings.ts';
import { envFor } from './secrets.ts';

/** First lockfile found decides how dependencies are installed. */
const INSTALLERS: Array<[lockfile: string, command: string]> = [
	['pnpm-lock.yaml', 'pnpm install'],
	['yarn.lock', 'yarn install'],
	['package-lock.json', 'npm install --no-audit --no-fund'],
	['package.json', 'npm install --no-audit --no-fund'],
];

async function installDependencies(machine: Machine): Promise<void> {
	const script = INSTALLERS.map(([file, command]) => `if [ -f ${quote(file)} ]; then ${command}; exit $?; fi`).join('\n');
	const result = await machine.exec(script, { cwd: repoDir(machine), timeoutMs: 15 * 60_000 });
	if (result.exitCode !== 0) logProblem('warn', 'Dependency install failed', result.stderr.slice(-500));
}

function warmImageFor(project: Project, settings: SandboxSettings): string | null {
	const fresh = project.warmedAt && Date.now() - Date.parse(project.warmedAt) < settings.warmImageDays * 86_400_000;
	return fresh ? project.warmImage : null;
}

/**
 * Saves a reusable image of the set-up repo once setup has finished. Waited
 * for, so nothing the agent does can end up in the image: later tasks start
 * from it, and their setup runs there with Anton's credentials.
 */
async function refreshWarmImage(machine: Machine, project: Project): Promise<void> {
	if (warmImageFor(project, await sandboxSettings())) return;
	await getProviders()
		.sandbox.snapshot(machine)
		.then((image) => setWarmImage(project.id, image, project.baseImage))
		.catch((error: unknown) => logProblem('warn', 'Warm image failed', error));
}

type Context = { machine: Machine; session: SessionRecord; project: Project };

/** The repo's own setup, after dependencies and on the task branch. A failure fails the task's setup. */
async function runSetupScript(machine: Machine, project: Project): Promise<void> {
	if (!project.setupScript.trim()) return;
	await run(machine, project.setupScript, { cwd: repoDir(machine), timeoutMs: 15 * 60_000 });
}

/** Puts the repo on the task branch: from a prepared image, or cloned from scratch. */
const setup: Record<'image' | 'clone', (context: Context) => Promise<void>> = {
	async image({ machine, session }) {
		await checkoutTaskBranch(machine, session.branch, session.baseSha, getProviders().git.gitAuthEnv());
		await installDependencies(machine);
	},
	async clone({ machine, session, project }) {
		const { git } = getProviders();
		await cloneRepo(machine, git.cloneUrl(project.repoFullName), git.gitAuthEnv());
		await installDependencies(machine);
		await checkoutTaskBranch(machine, session.branch, session.baseSha, git.gitAuthEnv());
	},
};

/**
 * Written when setup finishes, holding the task id. A machine without it was
 * interrupted mid-setup (a failure or a restart), so setup runs again rather
 * than handing the agent a half-cloned repo. Images made from another task
 * carry that task's id, so they never count.
 */
const readyFile = (machine: Machine) => `${machine.root}/.anton-ready`;

/**
 * Machines of tasks created before the marker existed: their own machine,
 * once it has saved a checkpoint. Newer tasks always get the marker, so a
 * checkpoint saved after a failed or stopped setup never counts as ready.
 */
const setUpBeforeMarker = (session: SessionRecord, origin: MachineOrigin) =>
	session.legacySetup && (origin === 'live' || origin === 'resumed') && session.checkpointAt !== null;

async function isReady(machine: Machine, session: SessionRecord, origin: MachineOrigin): Promise<boolean> {
	const marker = await machine.exec(`cat ${quote(readyFile(machine))}`);
	if (marker.exitCode !== 0) return setUpBeforeMarker(session, origin);
	return text(marker.stdout).trim() === session.id;
}

/** Sets up a machine that is not ready yet: one fresh from an image or the toolchain. */
async function prepare(context: Context, origin: MachineOrigin): Promise<void> {
	const { machine, session } = context;
	await setup[origin === 'image' ? 'image' : 'clone'](context);
	await runSetupScript(machine, context.project);
	await run(machine, `printf %s ${quote(session.id)} > ${quote(readyFile(machine))}`);
	// Taken only now, so the image never holds a half-run setup. Its marker names this task, so other tasks still set up.
	if (origin !== 'image') await refreshWarmImage(machine, context.project);
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

async function load(id: string): Promise<{ session: SessionRecord; project: Project }> {
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	if (!session || !project) throw new Error(`Session ${id} not found`);
	return { session, project };
}

const isUsed = (origin: MachineOrigin) => origin === 'live' || origin === 'resumed';

/**
 * The task's machine, set up or ready to be. A machine of its own that lacks
 * the marker may have been used by the agent or the terminal since, and
 * setup runs with Anton's credentials, so it is set aside for a fresh one.
 */
async function acquireReady(session: SessionRecord, project: Project): Promise<{ acquired: Acquired; ready: boolean }> {
	const { sandbox } = getProviders();
	const settings = await sandboxSettings();
	const request = {
		key: session.id,
		image: warmImageFor(project, settings),
		baseImage: project.baseImage ?? settings.baseImage,
		ports: project.previewPorts,
		resources: resourcesFrom(settings),
	};
	const acquired = await sandbox.acquire({ ...request, state: session.machineState });
	const ready = await isReady(acquired.machine, session, acquired.origin);
	if (ready || !isUsed(acquired.origin)) return { acquired, ready };
	await sandbox.stop(acquired.state);
	return { acquired: await sandbox.acquire({ ...request, state: null }), ready: false };
}

async function provision(id: string): Promise<Machine> {
	const { session, project } = await load(id);
	const { acquired, ready } = await acquireReady(session, project);
	// The agent reads ANTON_PREVIEW_PORTS to pick a port the user can preview.
	const machine = withEnv(acquired.machine, { ANTON_PREVIEW_PORTS: project.previewPorts.join(' '), ...(await envFor(project)) });
	await updateSession(id, { machineState: acquired.state, failed: false, errorMessage: null });
	try {
		if (!ready) await prepare({ machine, session, project }, acquired.origin);
	} catch (error) {
		await updateSession(id, { failed: true, errorMessage: error instanceof Error ? error.message : String(error) });
		throw error;
	}
	// A project's thread gets the project's files beside its repo, each start, since files can be added at any time.
	if (session.spaceId) await copySpaceFiles(machine, id).catch((error: unknown) => logProblem('warn', 'Could not copy the project files', error, id));
	return machine;
}

const machines = new Map<string, Promise<Machine>>();
const starting = new Set<string>();
/** Machines stay cached briefly so a burst of UI requests resolves one sandbox. */
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
	pending
		.then(
			() => setTimeout(() => current() && machines.delete(id), CACHE_MS).unref(),
			() => current() && machines.delete(id),
		)
		.finally(() => {
			if (current() || !machines.has(id)) starting.delete(id);
			announce({ kind: 'task', id, what: 'state' });
		});
	return pending;
}

/** The task's machine only if it is already running. */
export async function liveMachine(id: string): Promise<Machine | null> {
	const cached = machines.get(id);
	if (cached && !starting.has(id)) return cached;
	return getProviders().sandbox.find(id);
}

export function isStarting(id: string): boolean {
	return starting.has(id);
}

export function forgetMachine(id: string): void {
	machines.delete(id);
}
