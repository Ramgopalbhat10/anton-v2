import type { AcquireRequest, Machine } from '../core/ports.ts';
import { CommandError, quote, run, text } from '../core/shell.ts';
import type { Project } from '../core/types.ts';
import { DEFAULT_PREVIEW_PORTS } from '../db/projects.ts';
import { getProviders } from '../providers/index.ts';
import { checkoutTaskBranch, cloneRepo, initScratch, repoDir } from './git.ts';
import { logProblem } from './log.ts';
import { resourcesFrom, type SandboxSettings } from './sandbox-settings.ts';

/**
 * What setup puts a machine on and the marker it leaves: a task's branch at its base commit, marked with the task's
 * id; or, for a prepared image or a spare, the base branch's head, marked so no task takes it for its own.
 */
export type SetupTarget = { marker: string; branch: string; sha: string };

/** How the machine starts: an empty scratch folder (a chat), a prepared image of the repo, or nothing but the toolchain. */
export type SetupFrom = 'scratch' | 'image' | 'clone';

/**
 * Written when setup finishes. A machine without it was interrupted mid-setup (a failure or a restart), so setup runs
 * again rather than handing the agent a half-cloned repo.
 */
export const readyFile = (machine: Machine) => `${machine.root}/.anton-ready`;

/** The hash of the dependency files the repo's packages were last installed from. */
const depsFile = (machine: Machine) => `${machine.root}/.anton-deps`;

/** First lockfile found decides how dependencies are installed. */
const INSTALLERS: Array<[lockfile: string, command: string]> = [
	['pnpm-lock.yaml', 'pnpm install'],
	['yarn.lock', 'yarn install'],
	['package-lock.json', 'npm install --no-audit --no-fund'],
	['package.json', 'npm install --no-audit --no-fund'],
];
const DEPENDENCY_FILES = [...new Set(INSTALLERS.map(([file]) => file))];

/** Printed when the packages were installed, so a changed lockfile can renew the repo's prepared image. */
export const INSTALLED = 'anton:dependencies-installed';
const INSTALL_FAILED = 'anton:dependency-install-failed';

/**
 * Installs the repo's packages unless the dependency files match the ones they were installed from, as they do in a
 * prepared image whose lockfile has not changed: an install with nothing to do still takes seconds. Its output goes to
 * stderr, so stdout says only what happened.
 */
function dependencyScript(machine: Machine): string {
	const install = INSTALLERS.map(([file, command]) => `if [ -f ${quote(file)} ]; then ${command}; exit $?; fi`).join('\n');
	const saved = quote(depsFile(machine));
	return [
		`hash=$(cat ${DEPENDENCY_FILES.map(quote).join(' ')} 2>/dev/null | sha256sum | cut -d' ' -f1)`,
		`if [ "$hash" != "$(cat ${saved} 2>/dev/null)" ]; then`,
		`rm -f ${saved}`,
		`echo ${INSTALLED}`,
		`if (\n${install}\n) >&2; then printf %s "$hash" > ${saved}; else echo ${INSTALL_FAILED} >&2; fi`,
		'fi',
	].join('\n');
}

/**
 * The repo's packages, its setup script and the ready marker, in one command, as each command is a round trip to the
 * sandbox. A failed install is logged and setup goes on, as before; a failed setup script fails the setup. Returns
 * whether the packages were installed.
 */
async function finishSetup(machine: Machine, project: Project, marker: string): Promise<boolean> {
	const setupScript = project.setupScript.trim();
	const ready = quote(readyFile(machine));
	// The marker an image or an earlier setup left goes first, so a setup that fails here leaves none.
	const script = [`rm -f ${ready}`, dependencyScript(machine), setupScript ? `bash -lc ${quote(setupScript)} || exit $?` : '', `printf %s ${quote(marker)} > ${ready}`]
		.filter(Boolean)
		.join('\n');
	const result = await machine.exec(script, { cwd: repoDir(machine), timeoutMs: 30 * 60_000 });
	if (result.exitCode !== 0) throw new CommandError(setupScript || script, result);
	if (result.stderr.includes(INSTALL_FAILED)) logProblem('warn', 'Dependency install failed', result.stderr.slice(-500));
	return text(result.stdout).includes(INSTALLED);
}

/**
 * Sets up a fresh machine: the repo on the target's branch, its packages, its setup script, and the marker last, so a
 * machine with the marker is fully set up. Git credentials are used only here, before any agent or terminal has the
 * machine. Returns whether the packages were installed.
 */
export async function setUpMachine(machine: Machine, project: Project | null, target: SetupTarget, from: SetupFrom): Promise<boolean> {
	if (!project || from === 'scratch') {
		await initScratch(machine);
		await run(machine, `printf %s ${quote(target.marker)} > ${quote(readyFile(machine))}`);
		return false;
	}
	const { git } = getProviders();
	if (from === 'clone') await cloneRepo(machine, git.cloneUrl(project.repoFullName), git.gitAuthEnv());
	await checkoutTaskBranch(machine, target.branch, target.sha, git.gitAuthEnv());
	return finishSetup(machine, project, target.marker);
}

/** Reads the machine's ready marker; null when setup never finished. */
export async function readMarker(machine: Machine): Promise<string | null> {
	const marker = await machine.exec(`cat ${quote(readyFile(machine))}`);
	return marker.exitCode === 0 ? text(marker.stdout).trim() : null;
}

/** The ports a sandbox serves previews on: its repository's, or the usual ones for a chat. */
export const previewPortsFor = (project: Project | null) => project?.previewPorts ?? DEFAULT_PREVIEW_PORTS;

/** The hostnames the user's browser opens the machine's previews on, comma-separated, or null when all are localhost. */
export async function previewHosts(machine: Machine, ports: number[]): Promise<string | null> {
	const urls = await Promise.all(ports.map((port) => machine.previewUrl(port).catch(() => null)));
	const hosts = new Set(urls.flatMap((url) => (url ? [new URL(url).hostname] : [])).filter((host) => host !== 'localhost'));
	return hosts.size > 0 ? [...hosts].join(',') : null;
}

/**
 * What every command on a repo's machine gets besides the repo's variables. The agent reads ANTON_PREVIEW_PORTS to
 * pick a port the user can preview, and Vite's dev server turns away hosts it was not told of, so its first Preview
 * check would fail without the tunnels' names.
 */
export async function previewEnv(machine: Machine, project: Project | null): Promise<Record<string, string>> {
	const hosts = await previewHosts(machine, previewPortsFor(project));
	return { ANTON_PREVIEW_PORTS: previewPortsFor(project).join(' '), ...(hosts && { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: hosts }) };
}

/** A sandbox for `key` on the repo (or a chat), started from `image` when there is nothing to resume. */
export function machineRequest(key: string, project: Project | null, settings: SandboxSettings, image: string | null): Omit<AcquireRequest, 'state'> {
	return {
		key,
		image,
		baseImage: project?.baseImage ?? settings.baseImage,
		ports: previewPortsFor(project),
		resources: resourcesFrom(settings, project?.fullVm ? 'vm' : 'container'),
	};
}
