import { randomUUID } from 'node:crypto';
import type { Session, SessionRecord, SessionStatus } from '../core/types.ts';
import { config } from '../config.ts';
import { announce } from '../core/changes.ts';
import { getProject } from '../db/projects.ts';
import { deleteSessionRecord, getSessionRecord, insertSession, listSessionRecords, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { isWorking, stopAgent } from './activity.ts';
import { deleteCheckpoints, saveCheckpoint } from './checkpoints.ts';
import { forgetMachine, isStarting, liveMachine, machineFor } from './workspace.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { Reasoning } from '../core/ports.ts';
import { findModel, reasoningFor } from './models.ts';

/** The sandbox provider is the source of truth for what is running; cached briefly. */
let runningCache: { at: number; keys: Promise<Set<string>> } | undefined;
const RUNNING_CACHE_MS = 5_000;

function runningKeys(): Promise<Set<string>> {
	if (!runningCache || Date.now() - runningCache.at > RUNNING_CACHE_MS) {
		runningCache = { at: Date.now(), keys: getProviders().sandbox.running().catch(() => new Set<string>()) };
	}
	return runningCache.keys;
}

/** Forgets what is running, after a start or stop, and tells open pages the task list changed. */
export function invalidateRunning(): void {
	runningCache = undefined;
	announce({ kind: 'sessions' });
}

/** A failed setup reads as an error even while its machine is still up. */
function statusOf(record: SessionRecord, running: Set<string>): SessionStatus {
	if (isStarting(record.id)) return 'starting';
	if (record.failed) return 'error';
	return running.has(record.id) ? 'running' : 'stopped';
}

function present(record: SessionRecord, running: Set<string>): Session {
	const { failed: _failed, machineState: _state, followState: _follow, legacySetup: _legacy, ...session } = record;
	return { ...session, status: statusOf(record, running), working: isWorking(record.id), workspace: record.machineState !== null };
}

export type ModelChoice = { model: string; reasoning: Reasoning };

/**
 * The agent function renders synchronously, so it reads each session's
 * model and reasoning level from here. Filled before every prompt.
 */
const choices = new Map<string, ModelChoice>();

export function modelFor(id: string): ModelChoice {
	return choices.get(id) ?? { model: config.model, reasoning: 'off' };
}

/** Loads the session's choice and the model list the agent resolves it against. */
export async function primeModel(id: string): Promise<void> {
	const record = await getSessionRecord(id);
	if (!record) return;
	const info = await findModel(record.model).catch(() => undefined);
	choices.set(id, { model: record.model, reasoning: reasoningFor(info, record.reasoning) });
}

async function knownModel(model: string): Promise<string> {
	if (!(await findModel(model))) throw new InvalidInputError(`Unknown model: ${model}`);
	return model;
}

function slug(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 40) || 'task'
	);
}

export async function createSession(input: {
	projectId: string;
	branch?: string;
	model?: string;
	reasoning?: Reasoning;
	title?: string;
	planMode?: boolean;
}): Promise<Session> {
	const project = await getProject(input.projectId);
	if (!project) throw new NotFoundError('Project not found');
	const baseBranch = input.branch || project.defaultBranch;
	const baseSha = await getProviders().git.resolveRef(project.repoFullName, baseBranch);
	const id = randomUUID();
	const title = input.title?.trim() || 'New task';
	const model = input.model ? await knownModel(input.model) : config.model;
	const branch = `anton/${slug(title)}-${id.slice(0, 6)}`;
	await insertSession({ id, projectId: project.id, title, model, reasoning: input.reasoning ?? null, baseBranch, baseSha, branch, planMode: input.planMode ?? false });
	return getSession(id);
}

export async function listSessions(): Promise<Session[]> {
	const [records, running] = await Promise.all([listSessionRecords(), runningKeys()]);
	return records.map((record) => present(record, running));
}

export async function getSession(id: string): Promise<Session> {
	const record = await getSessionRecord(id);
	if (!record) throw new NotFoundError('Session not found');
	return present(record, await runningKeys());
}

export async function isRunning(id: string): Promise<boolean> {
	return (await runningKeys()).has(id);
}

export type SessionChange = { title?: string; model?: string; reasoning?: Reasoning | null; planMode?: boolean };

/** Renames the task, changes its model or reasoning level, or turns plan mode on or off; the agent sees a change from the next prompt. */
export async function editSession(id: string, change: SessionChange): Promise<Session> {
	const model = change.model && (await knownModel(change.model));
	const title = change.title?.trim();
	await updateSession(id, {
		...(title ? { title } : {}),
		...(model ? { model } : {}),
		...('reasoning' in change ? { reasoning: change.reasoning } : {}),
		...(change.planMode !== undefined ? { planMode: change.planMode } : {}),
	});
	return getSession(id);
}

/** Starts or resumes the task's machine. */
export async function resumeSession(id: string): Promise<Session> {
	await machineFor(id);
	invalidateRunning();
	return getSession(id);
}

/** Saves a checkpoint, then stops the machine. Never starts one. */
export async function stopSession(id: string): Promise<Session> {
	const record = await getSessionRecord(id);
	if (!record) throw new NotFoundError('Session not found');
	await stopAgent(id);
	const machine = await liveMachine(id);
	if (machine && record.machineState) {
		await saveCheckpoint(id, machine).catch((error: unknown) => console.warn('[anton] checkpoint before stop failed', error));
		await getProviders().sandbox.stop(record.machineState);
	}
	forgetMachine(id);
	invalidateRunning();
	return getSession(id);
}

/**
 * Stops the task's machine and removes its record and saved checkpoints.
 * The pushed branch and any pull request stay on the git host.
 */
export async function deleteSession(id: string): Promise<void> {
	await stopSession(id);
	await deleteCheckpoints(id);
	await deleteSessionRecord(id);
}
