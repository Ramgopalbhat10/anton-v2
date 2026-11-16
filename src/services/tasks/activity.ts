import { announce } from '../../core/changes.ts';
import { stopReplyJobs } from '../sandbox/background-jobs.ts';
import { stopRepoCheck } from '../sandbox/repo-check.ts';
import { liveMachine } from '../sandbox/workspace.ts';
import { logProblem } from '../../core/log.ts';
import { noteRepliesStopping } from './subagent-runs.ts';

/** In memory only: after a restart the runtime re-emits `submission_running` for each response it recovers. */
const inFlight = new Map<string, Set<string>>();

/**
 * Counted as working from the moment a message arrives, before it is checked and primed (seconds) and the runtime picks it up.
 * Cleared when the runtime starts or settles a response, when the message is turned away, or after a minute.
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

/** Runs `run` once every response in flight has settled, so work that follows a reply never holds the reply open. */
export function whenIdle(id: string, run: () => void): void {
	if (!inFlight.has(id)) return run();
	afterIdle.set(id, [...(afterIdle.get(id) ?? []), run]);
}

export function onIdle(listener: (id: string) => void): () => void {
	idleListeners.add(listener);
	return () => idleListeners.delete(listener);
}

type Abort = (id: string) => Promise<void>;
let abortAgent: Abort = async () => undefined;

/** Registered by the app, so services never import the agent module. */
export function setAgentAbort(abort: Abort): void {
	abortAgent = abort;
}

export async function stopAgent(id: string): Promise<void> {
	if (!inFlight.has(id)) return;
	noteRepliesStopping(id);
	// Its suites and builds stop with it, so a stopped reply leaves nothing running in the sandbox.
	void stopReplyJobs(id).catch((error: unknown) => logProblem('warn', 'Could not stop the background jobs', error, id));
	void stopRepoCheck(id).catch((error: unknown) => logProblem('warn', "Could not stop the repository's check", error, id));
	await abortAgent(id).catch((error: unknown) => logProblem('warn', 'Could not stop the agent', error, id));
}

export function isWorking(id: string): boolean {
	return inFlight.has(id) || sending.has(id);
}

/** A single long model call runs no command, so a working agent's machine gets a no-op this often, well inside any idle timeout. Never starts a machine. */
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
