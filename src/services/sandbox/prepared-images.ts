import type { MachineOrigin } from '../../core/ports.ts';
import type { Project } from '../../core/types.ts';
import { config } from '../../config.ts';
import { clearWarmImage, getProject, setWarmImage } from '../../db/projects.ts';
import { getProviders } from '../../providers/index.ts';
import { withEnv } from '../../core/machine-env.ts';
import { logProblem } from '../../core/log.ts';
import { machineRequest, previewEnv, setUpMachine } from './machine-setup.ts';
import { type SandboxSettings, sandboxSettings } from './sandbox-settings.ts';
import { envFor } from '../secrets/secrets.ts';

// A prepared image is built in a sandbox no agent or terminal ever has, so nothing a task does reaches an image.

export function preparedImageFor(project: Project, settings: SandboxSettings, share = 1): string | null {
	const fresh = project.warmedAt && Date.now() - Date.parse(project.warmedAt) < share * settings.warmImageDays * 86_400_000;
	return fresh ? project.warmImage : null;
}

/** Rebuilt past this share of its days while tasks still use it, so no task meets an expired one. */
export const RENEW_SHARE = 0.75;

const IMAGE_MARKER = 'prepared-image';

const building = new Map<string, Promise<string | null>>();

/** One build per repo at a time. A rebuild starts from the image it replaces, so it only fetches and installs what changed. */
export function buildPreparedImage(projectId: string, force = false): Promise<string | null> {
	const pending = building.get(projectId);
	if (pending) return pending;
	const build = (async () => {
		const project = await getProject(projectId);
		if (!project) return null;
		const settings = await sandboxSettings();
		if (!force && preparedImageFor(project, settings, RENEW_SHARE)) return project.warmImage;
		const { sandbox, git } = getProviders();
		const sha = await git.resolveRef(project.repoFullName, project.defaultBranch);
		const request = { ...machineRequest(`image-${project.id}`, project, settings, preparedImageFor(project, settings)), state: null };
		let acquired = await sandbox.acquire(request);
		// One left running by a build that was cut short holds whatever it got to: start over.
		if (acquired.origin === 'live' || acquired.origin === 'resumed') {
			await sandbox.stop(acquired.state);
			acquired = await sandbox.acquire(request);
		}
		try {
			const machine = withEnv(acquired.machine, { ...(await previewEnv(acquired.machine, project)), ...(await envFor(project)) });
			await setUpMachine(machine, project, { marker: IMAGE_MARKER, branch: project.defaultBranch, sha }, acquired.origin === 'image' ? 'image' : 'clone');
			const image = await sandbox.snapshot(acquired.machine);
			await setWarmImage(project.id, image, project.baseImage);
			return image;
		} finally {
			await sandbox.stop(acquired.state).catch((error: unknown) => logProblem('warn', 'Could not stop the image build sandbox', error));
		}
	})().finally(() => building.delete(projectId));
	building.set(projectId, build);
	return build;
}

/**
 * A prepared image asked for but started from the base image could not be loaded (another Modal workspace's, or
 * deleted). It is forgotten so the next build replaces it, instead of every task and build asking for it again.
 */
export async function dropLostImage(project: Project, requested: string | null, origin: MachineOrigin): Promise<void> {
	if (!requested || origin !== 'base' || project.warmImage !== requested) return;
	logProblem('warn', 'The prepared image could not be loaded; building a new one', requested);
	await clearWarmImage(project.id);
	renewPreparedImage(project.id);
}

export function renewPreparedImage(projectId: string, force = false): void {
	if (!config.prepareImages) return;
	void buildPreparedImage(projectId, force).catch((error: unknown) => logProblem('warn', 'Building the prepared image failed', error));
}
