import type { Project } from '../core/types.ts';
import { config } from '../config.ts';
import { getProject, setWarmImage } from '../db/projects.ts';
import { getProviders } from '../providers/index.ts';
import { withEnv } from '../core/machine-env.ts';
import { logProblem } from './log.ts';
import { machineRequest, previewEnv, setUpMachine } from './machine-setup.ts';
import { type SandboxSettings, sandboxSettings } from './sandbox-settings.ts';
import { envFor } from './secrets.ts';

/*
 * A repo's prepared image: its sandbox's filesystem with the repo cloned, its packages installed and its setup script
 * run, at the base branch's head. Tasks start from it rather than cloning. It is built in a sandbox of its own that
 * no agent or terminal ever has, so nothing a task does reaches an image, and no task waits while one is saved.
 */

/** The repo's prepared image while it is younger than `share` of its days, else null. */
export function preparedImageFor(project: Project, settings: SandboxSettings, share = 1): string | null {
	const fresh = project.warmedAt && Date.now() - Date.parse(project.warmedAt) < share * settings.warmImageDays * 86_400_000;
	return fresh ? project.warmImage : null;
}

/**
 * An image past this share of its days is built again while tasks still use it, so no task meets an expired one and
 * waits on clone and install.
 */
export const RENEW_SHARE = 0.75;

/** Marks the machine an image is built in, so no task takes it for its own. */
const IMAGE_MARKER = 'prepared-image';

const building = new Map<string, Promise<string | null>>();

/**
 * Builds the repo's prepared image unless a fresh one exists (`force` builds it anyway, as a changed lockfile asks),
 * and returns it. One build per repo at a time; a second ask waits for the first. A rebuild starts from the image it
 * replaces, so it only fetches, checks out and installs what changed.
 */
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

/** Starts a build in the background when the repo needs one; a failure is logged, and the next ask tries again. */
export function renewPreparedImage(projectId: string, force = false): void {
	if (!config.prepareImages) return;
	void buildPreparedImage(projectId, force).catch((error: unknown) => logProblem('warn', 'Building the prepared image failed', error));
}
