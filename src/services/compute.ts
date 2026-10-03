import { config } from '../config.ts';
import { listSessionRecords } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { runningKeys, stopSession } from './sessions.ts';

export type RunningTask = { id: string; title: string; repo: string; createdAt: string };

/**
 * Where sandboxes run and which are up now. `others` counts sandboxes in the
 * provider that are no task of this Anton, such as another install's sharing the app.
 */
export type ComputeView = { provider: string; app: string | null; running: RunningTask[]; others: number };

export async function computeView(): Promise<ComputeView> {
	const [keys, records] = await Promise.all([runningKeys(), listSessionRecords()]);
	const running = records.filter((record) => keys.has(record.id));
	return {
		provider: getProviders().sandbox.name,
		app: config.sandbox === 'modal' ? config.modal.app : null,
		running: running.map(({ id, title, repo, createdAt }) => ({ id, title, repo, createdAt })),
		others: keys.size - running.length,
	};
}

/** Stops every task's sandbox, each saving a checkpoint first, as Stop does. */
export async function stopAllSandboxes(): Promise<{ stopped: number }> {
	const { running } = await computeView();
	await Promise.all(running.map((task) => stopSession(task.id)));
	return { stopped: running.length };
}
