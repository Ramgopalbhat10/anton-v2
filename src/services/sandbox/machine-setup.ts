import type { AcquireRequest, Machine } from '../../core/ports.ts';
import { CommandError, quote, run, text } from '../../core/shell.ts';
import type { Project } from '../../core/types.ts';
import { DEFAULT_PREVIEW_PORTS } from '../../db/projects.ts';
import { getProviders } from '../../providers/index.ts';
import { checkoutTaskBranch, cloneRepo, initScratch, repoDir } from '../git/git.ts';
import { logProblem } from '../../core/log.ts';
import { resourcesFrom, type SandboxSettings } from './sandbox-settings.ts';

/** A prepared image or a spare is marked so no task takes it for its own. */
export type SetupTarget = { marker: string; branch: string; sha: string };

export type SetupFrom = 'scratch' | 'image' | 'clone';

/** Written when setup finishes; a machine without it was interrupted, so setup runs again rather than hand over a half-cloned repo. */
export const readyFile = (machine: Machine) => `${machine.root}/.anton-ready`;

const depsFile = (machine: Machine) => `${machine.root}/.anton-deps`;

const INSTALLERS: Array<[lockfile: string, command: string]> = [
	['pnpm-lock.yaml', 'pnpm install'],
	['yarn.lock', 'yarn install'],
	['package-lock.json', 'npm install --no-audit --no-fund'],
	['package.json', 'npm install --no-audit --no-fund'],
];
const DEPENDENCY_FILES = [...new Set(INSTALLERS.map(([file]) => file))];

/** So a changed lockfile can renew the repo's prepared image. */
export const INSTALLED = 'anton:dependencies-installed';
const INSTALL_FAILED = 'anton:dependency-install-failed';

/** Skipped when the dependency files match the last install's: an install with nothing to do still takes seconds. Output goes to stderr. */
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

/** One command, as each command is a round trip to the sandbox. A failed install is logged and setup goes on; a failed setup script fails it. */
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

/** The marker goes last, so a machine with it is fully set up. Git credentials are used only here, before any agent or terminal has the machine. */
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

export async function readMarker(machine: Machine): Promise<string | null> {
	const marker = await machine.exec(`cat ${quote(readyFile(machine))}`);
	return marker.exitCode === 0 ? text(marker.stdout).trim() : null;
}

export const previewPortsFor = (project: Project | null) => project?.previewPorts ?? DEFAULT_PREVIEW_PORTS;

export async function previewHosts(machine: Machine, ports: number[]): Promise<string | null> {
	const urls = await Promise.all(ports.map((port) => machine.previewUrl(port).catch(() => null)));
	const hosts = new Set(urls.flatMap((url) => (url ? [new URL(url).hostname] : [])).filter((host) => host !== 'localhost'));
	return hosts.size > 0 ? [...hosts].join(',') : null;
}

/** Vite's dev server turns away hosts it was not told of, so the first Preview check would fail without the tunnels' names. */
export async function previewEnv(machine: Machine, project: Project | null): Promise<Record<string, string>> {
	const hosts = await previewHosts(machine, previewPortsFor(project));
	return { ANTON_PREVIEW_PORTS: previewPortsFor(project).join(' '), ...(hosts && { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: hosts }) };
}

export function machineRequest(key: string, project: Project | null, settings: SandboxSettings, image: string | null): Omit<AcquireRequest, 'state'> {
	return {
		key,
		image,
		baseImage: project?.baseImage ?? settings.baseImage,
		ports: previewPortsFor(project),
		resources: resourcesFrom(settings, project?.fullVm ? 'vm' : 'container'),
	};
}
