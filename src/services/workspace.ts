import type { Machine, MachineOrigin } from '../core/ports.ts';
import { quote } from '../core/shell.ts';
import type { Project, SessionRecord } from '../core/types.ts';
import { config } from '../config.ts';
import { getProject, setWarmImage } from '../db/projects.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { checkoutTaskBranch, cloneRepo, repoDir } from './git.ts';

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
	if (result.exitCode !== 0) console.warn(`[anton] dependency install failed: ${result.stderr.slice(-500)}`);
}

function warmImageFor(project: Project): string | null {
	const fresh = project.warmedAt && Date.now() - Date.parse(project.warmedAt) < config.warmImageMaxAgeMs;
	return fresh ? project.warmImage : null;
}

/** Saves a reusable image of the cloned, installed repo in the background. */
function refreshWarmImage(machine: Machine, project: Project): void {
	if (warmImageFor(project)) return;
	void getProviders()
		.sandbox.snapshot(machine)
		.then((image) => setWarmImage(project.id, image))
		.catch((error: unknown) => console.warn('[anton] warm image failed', error));
}

type Context = { machine: Machine; session: SessionRecord; project: Project };

/** What each kind of new machine still needs before the task can use it. */
const setup: Record<MachineOrigin, (context: Context) => Promise<void>> = {
	live: async () => {},
	resumed: async () => {},
	async image({ machine, session }) {
		await checkoutTaskBranch(machine, session.branch, session.baseSha, getProviders().git.gitAuthEnv());
		await installDependencies(machine);
	},
	async base({ machine, session, project }) {
		const { git } = getProviders();
		await cloneRepo(machine, git.cloneUrl(project.repoFullName), git.gitAuthEnv());
		await installDependencies(machine);
		refreshWarmImage(machine, project);
		await checkoutTaskBranch(machine, session.branch, session.baseSha, git.gitAuthEnv());
	},
};

async function load(id: string): Promise<{ session: SessionRecord; project: Project }> {
	const session = await getSessionRecord(id);
	const project = session && (await getProject(session.projectId));
	if (!session || !project) throw new Error(`Session ${id} not found`);
	return { session, project };
}

async function provision(id: string): Promise<Machine> {
	const { session, project } = await load(id);
	const acquired = await getProviders().sandbox.acquire({
		key: id,
		state: session.machineState,
		image: warmImageFor(project),
	});
	await updateSession(id, { machineState: acquired.state, failed: false, errorMessage: null });
	try {
		await setup[acquired.origin]({ machine: acquired.machine, session, project });
	} catch (error) {
		await updateSession(id, { failed: true, errorMessage: error instanceof Error ? error.message : String(error) });
		throw error;
	}
	return acquired.machine;
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
	pending.then(
		() => setTimeout(() => machines.delete(id), CACHE_MS).unref(),
		() => machines.delete(id),
	).finally(() => starting.delete(id));
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
