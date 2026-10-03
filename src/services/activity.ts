import { announce } from '../core/changes.ts';
import { liveMachine } from './workspace.ts';

/**
 * Which tasks have an agent response in flight, learned from the agent
 * runtime's submission events. In memory only: after a restart the runtime
 * re-emits `submission_running` for each response it recovers.
 */
const inFlight = new Map<string, Set<string>>();

export type AgentEvent = { type: string; instanceId?: string; submissionId?: string };

export function recordAgentEvent({ type, instanceId, submissionId }: AgentEvent): void {
	// A finished tool call may have changed the task's files; open pages refetch them.
	if (type === 'tool' && instanceId) announce({ kind: 'task', id: instanceId, what: 'files' });
	if (!instanceId || !submissionId) return;
	if (type === 'submission_running') {
		inFlight.set(instanceId, (inFlight.get(instanceId) ?? new Set()).add(submissionId));
	} else if (type === 'submission_settled') {
		inFlight.get(instanceId)?.delete(submissionId);
		if (inFlight.get(instanceId)?.size === 0) inFlight.delete(instanceId);
	} else return;
	announce({ kind: 'task', id: instanceId, what: 'state' });
}

type Abort = (id: string) => Promise<void>;
let abortAgent: Abort = async () => undefined;

/** The app registers how to stop an agent, so services never import the agent module. */
export function setAgentAbort(abort: Abort): void {
	abortAgent = abort;
}

/** Stops the task's agent if it is working, so nothing keeps running for a stopped or deleted task. */
export async function stopAgent(id: string): Promise<void> {
	if (inFlight.has(id)) await abortAgent(id).catch((error: unknown) => console.warn('[anton] could not stop the agent', error));
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
