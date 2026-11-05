import type { Acquired, Machine, MachineOrigin } from '../core/ports.ts';
import { config } from '../config.ts';
import { announce } from '../core/changes.ts';
import { withEnv } from '../core/machine-env.ts';
import { quote, run, text } from '../core/shell.ts';
import type { Project, SessionRecord } from '../core/types.ts';
import { DEFAULT_PREVIEW_PORTS, getProject, setWarmImage } from '../db/projects.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { applyFiles, copyLibrary, readCheckpoint } from './checkpoints.ts';
import { checkoutTaskBranch, cloneRepo, initScratch, repoDir } from './git.ts';
import { isWorking } from './activity.ts';
import { logProblem } from './log.ts';
import { copySpaceFiles } from './space-files.ts';
import { resourcesFrom, type SandboxSettings, sandboxSettings } from './sandbox-settings.ts';
import { envFor } from './secrets.ts';
import { runnerFor, runnerOf } from './runners.ts';

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

/** The repo's warm image while it is younger than `share` of its days, else null. */
function warmImageFor(project: Project, settings: SandboxSettings, share = 1): string | null {
	const fresh = project.warmedAt && Date.now() - Date.parse(project.warmedAt) < share * settings.warmImageDays * 86_400_000;
	return fresh ? project.warmImage : null;
}

/**
 * A task that starts from an image past this share of its days saves a new one,
 * so the image is renewed while tasks still use it and no task meets an expired
 * one and waits on clone, install and snapshot.
 */
const RENEW_SHARE = 0.75;

/**
 * Saves a reusable image of the set-up repo once setup has finished. Waited
 * for, so nothing the agent does can end up in the image: later tasks start
 * from it, and their setup runs there with Anton's credentials.
 */
async function refreshWarmImage(machine: Machine, project: Project): Promise<void> {
	if (warmImageFor(project, await sandboxSettings(), RENEW_SHARE)) return;
	await getProviders()
		.sandbox.snapshot(machine)
		.then((image) => setWarmImage(project.id, image, project.baseImage))
		.catch((error: unknown) => logProblem('warn', 'Warm image failed', error));
}

/** A chat's project is null: it has no repository, so its sandbox starts from an empty scratch folder. */
type Context = { machine: Machine; session: SessionRecord; project: Project | null };

/** The repo's own setup, after dependencies and on the task branch. A failure fails the task's setup. */
async function runSetupScript(machine: Machine, project: Project | null): Promise<void> {
	if (!project?.setupScript.trim()) return;
	await run(machine, project.setupScript, { cwd: repoDir(machine), timeoutMs: 15 * 60_000 });
}

/** Puts the repo on the task branch: from a prepared image, or cloned from scratch; a chat gets its empty folder. */
const setup: Record<'image' | 'clone' | 'scratch', (context: Context) => Promise<void>> = {
	async scratch({ machine }) {
		await initScratch(machine);
	},
	async image({ machine, session }) {
		await checkoutTaskBranch(machine, session.branch, session.baseSha, getProviders().git.gitAuthEnv());
		await installDependencies(machine);
	},
	async clone({ machine, session, project }) {
		if (!project) throw new Error('A chat has no repository to clone');
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
	await setup[!context.project ? 'scratch' : origin === 'image' ? 'image' : 'clone'](context);
	await runSetupScript(machine, context.project);
	await run(machine, `printf %s ${quote(session.id)} > ${quote(readyFile(machine))}`);
	// Taken only now, so the image never holds a half-run setup. Its marker names this task, so other tasks still set up.
	// A task on this server makes none: warm images belong to the sandbox, where the next task on the repo starts.
	// A task started from an image renews it only once it is old (`RENEW_SHARE`), so most image starts take none.
	if (context.project && session.runOn !== 'host') await refreshWarmImage(machine, context.project);
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

/** The ports a task's sandbox serves previews on: its repository's, or the usual ones for a chat. */
export const previewPortsFor = (project: Project | null) => project?.previewPorts ?? DEFAULT_PREVIEW_PORTS;

/** The hostnames the user's browser opens the machine's previews on, comma-separated, or null when all are localhost. */
export async function previewHosts(machine: Machine, ports: number[]): Promise<string | null> {
	const urls = await Promise.all(ports.map((port) => machine.previewUrl(port).catch(() => null)));
	const hosts = new Set(urls.flatMap((url) => (url ? [new URL(url).hostname] : [])).filter((host) => host !== 'localhost'));
	return hosts.size > 0 ? [...hosts].join(',') : null;
}

const isUsed = (origin: MachineOrigin) => origin === 'live' || origin === 'resumed';

/**
 * The task's machine, set up or ready to be. A machine of its own that lacks
 * the marker may have been used by the agent or the terminal since, and
 * setup runs with Anton's credentials, so it is set aside for a fresh one.
 */
async function acquireReady(session: SessionRecord, project: Project | null): Promise<{ acquired: Acquired; ready: boolean }> {
	const sandbox = runnerFor(session.runOn);
	const settings = await sandboxSettings();
	const request = {
		key: session.id,
		image: project && session.runOn !== 'host' ? warmImageFor(project, settings) : null,
		baseImage: project?.baseImage ?? settings.baseImage,
		ports: previewPortsFor(project),
		resources: resourcesFrom(settings, project?.fullVm ? 'vm' : 'container'),
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
	// Vite's dev server turns away hosts it was not told of, so its first Preview check would fail without the tunnels' names.
	const hosts = await previewHosts(acquired.machine, previewPortsFor(project));
	const ports = {
		ANTON_PREVIEW_PORTS: previewPortsFor(project).join(' '),
		...(hosts && { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: hosts }),
	};
	// A review task may be on a repo added only by pasting a link, whose own install scripts are its owner's code:
	// it gets the repo's own variables (none unless you set some), never the shared ones, and the code of a
	// pull request whose author cannot push to the repo gets none at all.
	const variables = session.review ? (project?.env ?? {}) : await envFor(project);
	const setupMachine = withEnv(acquired.machine, { ...ports, ...variables });
	const machine = session.review && !session.review.trusted ? withEnv(acquired.machine, ports) : setupMachine;
	await updateSession(id, { machineState: acquired.state, failed: false, errorMessage: null });
	try {
		if (!ready) await prepare({ machine: setupMachine, session, project }, acquired.origin);
	} catch (error) {
		await updateSession(id, { failed: true, errorMessage: error instanceof Error ? error.message : String(error) });
		throw error;
	}
	await Promise.all([
		// A project's thread gets the project's files beside its repo, each start, since files can be added at any time.
		session.spaceId ? copySpaceFiles(machine, id).catch((error: unknown) => logProblem('warn', 'Could not copy the project files', error, id)) : null,
		// So do the files attached to its messages before it had a sandbox, and, in a fresh machine, what it saved before.
		copyLibrary(machine, id).catch((error: unknown) => logProblem('warn', 'Could not put the Library back', error, id)),
	]);
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
 * Starts a repository task's machine as its agent starts a reply, so `start_workspace` finds it started or starting.
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
