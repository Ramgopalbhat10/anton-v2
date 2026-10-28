import { announce } from '../core/changes.ts';
import { liveMachine } from './workspace.ts';
import { logProblem } from './log.ts';
import { noteRepliesStopping } from './subagent-runs.ts';

/**
 * Which tasks have an agent response in flight, learned from the agent
 * runtime's submission events. In memory only: after a restart the runtime
 * re-emits `submission_running` for each response it recovers.
 */
const inFlight = new Map<string, Set<string>>();

/**
 * Tasks a message was just sent to, counted as working from the moment it
 * arrives: before it is checked and the agent is primed (which can take
 * seconds) and before the runtime picks it up. Cleared when the runtime
 * starts or settles a response for the task, when the message is turned
 * away, or after a minute in case neither ever comes.
 */
const sending = new Map<string, ReturnType<typeof setTimeout>>();
const SENDING_MS = 60_000;

function stopSending(id: string): boolean {
	const timer = sending.get(id);
	if (!timer) return false;
	clearTimeout(timer);
	sending.delete(id);
	return true;
}

/**
 * Marks a task working as soon as a message for it arrives, so the task list moves it to Running at once.
 * Returns what to call if the message is turned away.
 */
export function noteSending(id: string): () => void {
	if (inFlight.has(id)) return () => undefined;
	const already = stopSending(id);
	const timer = setTimeout(() => {
		if (sending.get(id) === timer && stopSending(id)) announce({ kind: 'task', id, what: 'state' });
	}, SENDING_MS);
	timer.unref?.();
	sending.set(id, timer);
	if (!already) announce({ kind: 'task', id, what: 'state' });
	return () => {
		if (sending.get(id) === timer && stopSending(id) && !inFlight.has(id)) announce({ kind: 'task', id, what: 'state' });
	};
}

export type AgentEvent = { type: string; instanceId?: string; submissionId?: string };

export function recordAgentEvent({ type, instanceId, submissionId }: AgentEvent): void {
	// A finished tool call may have changed the task's files; open pages refetch them.
	if (type === 'tool' && instanceId) announce({ kind: 'task', id: instanceId, what: 'files' });
	if (!instanceId || !submissionId) return;
	if (type === 'submission_running' || type === 'submission_settled') stopSending(instanceId);
	if (type === 'submission_running') {
		inFlight.set(instanceId, (inFlight.get(instanceId) ?? new Set()).add(submissionId));
	} else if (type === 'submission_settled') {
		inFlight.get(instanceId)?.delete(submissionId);
		if (inFlight.get(instanceId)?.size === 0) {
			inFlight.delete(instanceId);
			for (const listener of idleListeners) listener(instanceId);
			const queued = afterIdle.get(instanceId) ?? [];
			afterIdle.delete(instanceId);
			for (const run of queued) run();
		}
	} else return;
	announce({ kind: 'task', id: instanceId, what: 'state' });
}

const idleListeners = new Set<(id: string) => void>();

const afterIdle = new Map<string, (() => void)[]>();

/**
 * Runs `run` once the task's agent has settled every response in flight, at once if none is, so
 * work that follows a reply never holds the reply open: the page shows it finished as soon as it is.
 */
export function whenIdle(id: string, run: () => void): void {
	if (!inFlight.has(id)) return run();
	afterIdle.set(id, [...(afterIdle.get(id) ?? []), run]);
}

/** Calls `listener` each time an agent finishes its last response for a task (or project), so work it held back can go now. */
export function onIdle(listener: (id: string) => void): () => void {
	idleListeners.add(listener);
	return () => idleListeners.delete(listener);
}

type Abort = (id: string) => Promise<void>;
let abortAgent: Abort = async () => undefined;

/** The app registers how to stop an agent, so services never import the agent module. */
export function setAgentAbort(abort: Abort): void {
	abortAgent = abort;
}

/** Stops the task's agent if it is working, so nothing keeps running for a stopped or deleted task. */
export async function stopAgent(id: string): Promise<void> {
	if (!inFlight.has(id)) return;
	noteRepliesStopping(id);
	await abortAgent(id).catch((error: unknown) => logProblem('warn', 'Could not stop the agent', error, id));
}

/** True while the task's agent is working on a message. */
export function isWorking(id: string): boolean {
	return inFlight.has(id) || sending.has(id);
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
