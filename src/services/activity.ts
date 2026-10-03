import { liveMachine } from './workspace.ts';

/**
 * Which tasks have an agent response in flight, learned from the agent
 * runtime's submission events. In memory only: after a restart the runtime
 * re-emits `submission_running` for each response it recovers.
 */
const inFlight = new Map<string, Set<string>>();

export type AgentEvent = { type: string; instanceId?: string; submissionId?: string };

export function recordAgentEvent({ type, instanceId, submissionId }: AgentEvent): void {
	if (!instanceId || !submissionId) return;
	if (type === 'submission_running') {
		inFlight.set(instanceId, (inFlight.get(instanceId) ?? new Set()).add(submissionId));
	} else if (type === 'submission_settled') {
		inFlight.get(instanceId)?.delete(submissionId);
		if (inFlight.get(instanceId)?.size === 0) inFlight.delete(instanceId);
	}
}

/** True while the task's agent is working on a message. */
export function isWorking(id: string): boolean {
	return inFlight.has(id);
}

/**
 * Sandboxes stop after a stretch with no commands. A single long model call
 * runs none, so a working agent's machine gets a no-op on this cadence,
 * well inside any idle timeout. Never starts a machine.
 */
const KEEPALIVE_MS = 4 * 60_000;

export async function keepWorkingMachinesAlive(): Promise<void> {
	await Promise.all(
		[...inFlight.keys()].map(async (id) => {
			const machine = await liveMachine(id).catch(() => null);
			await machine?.exec('true').catch(() => undefined);
		}),
	);
}

setInterval(() => void keepWorkingMachinesAlive(), KEEPALIVE_MS).unref();
