import { randomUUID } from 'node:crypto';
import type { Session, SessionRecord, SessionStatus } from '../core/types.ts';
import { config } from '../config.ts';
import { getProject } from '../db/projects.ts';
import { getSessionRecord, insertSession, listSessionRecords, updateSession } from '../db/sessions.ts';
import { isKnownModel } from '../lib/models.ts';
import { getProviders } from '../providers/index.ts';
import { saveCheckpoint } from './checkpoints.ts';
import { forgetMachine, isStarting, liveMachine, machineFor } from './workspace.ts';

export class NotFoundError extends Error {}

/** The sandbox provider is the source of truth for what is running; cached briefly. */
let runningCache: { at: number; keys: Promise<Set<string>> } | undefined;
const RUNNING_CACHE_MS = 5_000;

function runningKeys(): Promise<Set<string>> {
	if (!runningCache || Date.now() - runningCache.at > RUNNING_CACHE_MS) {
		runningCache = { at: Date.now(), keys: getProviders().sandbox.running().catch(() => new Set<string>()) };
	}
	return runningCache.keys;
}

export function invalidateRunning(): void {
	runningCache = undefined;
}

function statusOf(record: SessionRecord, running: Set<string>): SessionStatus {
	if (isStarting(record.id)) return 'starting';
	if (running.has(record.id)) return 'running';
	return record.failed ? 'error' : 'stopped';
}

function present(record: SessionRecord, running: Set<string>): Session {
	const { failed: _failed, machineState: _state, ...session } = record;
	return { ...session, status: statusOf(record, running) };
}

/**
 * The agent function renders synchronously, so it reads each session's
 * model from here. Filled on create, on change, and before every prompt.
 */
const models = new Map<string, string>();

export function modelFor(id: string): string {
	return models.get(id) ?? config.model;
}

export async function primeModel(id: string): Promise<void> {
	const record = await getSessionRecord(id);
	if (record) models.set(id, record.model);
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

export async function createSession(input: { projectId: string; branch?: string; model?: string; title?: string }): Promise<Session> {
	const project = await getProject(input.projectId);
	if (!project) throw new NotFoundError('Project not found');
	const baseBranch = input.branch || project.defaultBranch;
	const baseSha = await getProviders().git.resolveRef(project.repoFullName, baseBranch);
	const id = randomUUID();
	const title = input.title?.trim() || 'New task';
	const model = input.model && isKnownModel(input.model) ? input.model : config.model;
	await insertSession({ id, projectId: project.id, title, model, baseBranch, baseSha, branch: `anton/${slug(title)}-${id.slice(0, 6)}` });
	models.set(id, model);
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

export async function setModel(id: string, model: string): Promise<Session> {
	if (!isKnownModel(model)) throw new Error('Unknown model');
	await updateSession(id, { model });
	models.set(id, model);
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
	const machine = await liveMachine(id);
	if (machine && record.machineState) {
		await saveCheckpoint(id, machine).catch((error: unknown) => console.warn('[anton] checkpoint before stop failed', error));
		await getProviders().sandbox.stop(record.machineState);
	}
	forgetMachine(id);
	invalidateRunning();
	return getSession(id);
}
