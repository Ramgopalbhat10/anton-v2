import { randomUUID } from 'node:crypto';
import type { ReviewOf, Session, SessionRecord, SessionStatus } from '../core/types.ts';
import { config } from '../config.ts';
import { announce } from '../core/changes.ts';
import { getProject } from '../db/projects.ts';
import { deleteSessionRecord, getSessionRecord, insertSession, listSessionRecords, listThreadRecords, updateSession } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';
import { isWorking, stopAgent } from './activity.ts';
import { copyCheckpoint, deleteCheckpoints, saveCheckpoint } from './checkpoints.ts';
import { forgetMachine, isStarting, liveMachine, machineFor } from './workspace.ts';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { type ModelRoute, routable, routedId } from '../core/model-route.ts';
import type { Reasoning } from '../core/ports.ts';
import { generalSettings } from './general.ts';
import { closeBrowser } from './live-browser.ts';
import { SCRATCH_BASE, SCRATCH_BRANCH } from './git.ts';
import { forgetScriptCalls } from './script-runs.ts';
import { forgetResults } from './tool-results.ts';
import { forgetSubagentRuns } from './subagent-runs.ts';
import { findModel, reasoningFor } from './models.ts';
import { logProblem } from './log.ts';
import { threadState } from '../core/thread-state.ts';
import { nameTask, titleFrom } from './titles.ts';

/** The sandbox provider is the source of truth for what is running; cached briefly. */
let runningCache: { at: number; keys: Promise<Set<string>> } | undefined;
const RUNNING_CACHE_MS = 5_000;

/** Keys of the sandboxes running now, asked of the provider at most every few seconds. */
export function runningKeys(): Promise<Set<string>> {
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

export function present(record: SessionRecord, running: Set<string>): Session {
	const { failed: _failed, machineState: _state, followState: _follow, legacySetup: _legacy, reportedState: _reported, ...session } = record;
	const shown = { ...session, status: statusOf(record, running), working: isWorking(record.id), workspace: record.machineState !== null };
	return { ...shown, threadState: threadState(shown) };
}

/** `route` is where the gateway sends the calls, for a model on one; `model` is never routed itself. */
export type ModelChoice = { model: string; reasoning: Reasoning; route?: ModelRoute | null };

/**
 * The agent function renders synchronously, so it reads each session's
 * model, reasoning level and route from here. Filled before every prompt.
 */
const choices = new Map<string, ModelChoice>();

export function modelFor(id: string): ModelChoice {
	return choices.get(id) ?? { model: config.model, reasoning: 'off' };
}

/** The model specifier the session's agent runs: its model, with its route when it has one (`routedId`). */
export function agentModelFor(id: string): ModelChoice {
	const choice = modelFor(id);
	return { ...choice, model: routedId(choice.model, choice.route ?? null) };
}

/** Every routed specifier a session's agent may resolve, for the gateways' providers to list. */
export function routedModels(): string[] {
	return [...choices.values()].filter((choice) => choice.route).map((choice) => routedId(choice.model, choice.route ?? null));
}

/** Loads the session's choice and the model list the agent resolves it against. */
export async function primeModel(id: string): Promise<void> {
	const record = await getSessionRecord(id);
	if (!record) return;
	const info = await findModel(record.model).catch(() => undefined);
	const route = routable(record.model) ? record.route : null;
	choices.set(id, { model: record.model, reasoning: reasoningFor(info, record.reasoning), ...(route ? { route } : {}) });
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

/** Where a new task starts: a repository at a branch's head (or a given commit on it), or, for a chat, the empty scratch folder. */
async function startingPoint(projectId: string | undefined, branch: string | undefined, sha: string | undefined) {
	if (!projectId) return { projectId: null, baseBranch: SCRATCH_BRANCH, baseSha: SCRATCH_BASE };
	const project = await getProject(projectId);
	if (!project) throw new NotFoundError('Project not found');
	const baseBranch = branch || project.defaultBranch;
	return { projectId: project.id, baseBranch, baseSha: sha ?? (await getProviders().git.resolveRef(project.repoFullName, baseBranch)) };
}

/** A task on a repository, or without `projectId` a chat: no repository, and a scratch sandbox if it needs one. */
export async function createSession(input: {
	projectId?: string;
	branch?: string;
	model?: string;
	reasoning?: Reasoning;
	/** Where a gateway sends the model's calls; kept only for a model on a gateway. */
	route?: ModelRoute | null;
	title?: string;
	planMode?: boolean;
	/** The project the task is a thread of. */
	spaceId?: string;
	/** Held until the thread can start, when the project's threads are all busy. */
	brief?: string;
	/** Someone else's pull request the task reviews, starting from `baseSha`, its merge base on `branch`. */
	review?: ReviewOf;
	prUrl?: string;
	baseSha?: string;
	/** The routine that starts it. */
	automationId?: string;
	/** The message to name the task from: a fast model gives it a short title in a moment, in place of `title`. */
	titleFrom?: string;
}): Promise<Session> {
	// GitHub names the commit while the model is checked, rather than one after the other.
	const [{ projectId, baseBranch, baseSha }, general, chosen] = await Promise.all([
		startingPoint(input.projectId, input.branch, input.baseSha),
		generalSettings(),
		input.model ? knownModel(input.model) : null,
	]);
	const id = randomUUID();
	const title = input.title?.trim() || (input.titleFrom && titleFrom(input.titleFrom)) || 'New task';
	// The default reasoning level belongs to the default model; another model starts at its own default.
	const model = chosen ?? general.model ?? config.model;
	const reasoning = input.reasoning ?? (input.model ? null : general.reasoning);
	// Plan mode plans changes to code; a chat has none to plan.
	const planMode = projectId ? (input.planMode ?? general.planMode) : false;
	const branch = projectId ? branchFor(title, id) : SCRATCH_BRANCH;
	await insertSession({
		id,
		projectId,
		title,
		model,
		reasoning,
		baseBranch,
		baseSha,
		branch,
		planMode,
		spaceId: input.spaceId,
		brief: input.brief,
		review: input.review,
		prUrl: input.prUrl,
		automationId: input.automationId,
		route: input.route && routable(model) ? input.route : null,
	});
	if (input.titleFrom) void nameTask(id, input.titleFrom);
	return getSession(id);
}

const branchFor = (title: string, id: string) => `anton/${slug(title)}-${id.slice(0, 6)}`;

/**
 * A new task on the same base, model and plan mode, holding the task's files
 * as they are now on a branch and sandbox of its own, so two approaches can
 * be tried side by side. The conversation and outputs stay with the original.
 * Its sandbox starts right away when there are files, so the agent works on
 * them rather than reading the base.
 */
export async function forkSession(id: string): Promise<Session> {
	const source = await getSessionRecord(id);
	if (!source) throw new NotFoundError('Session not found');
	const machine = await liveMachine(id);
	if (machine) await saveCheckpoint(id, machine).catch((error: unknown) => logProblem('warn', 'Checkpoint before fork failed', error, id));
	const forkId = randomUUID();
	const title = `${source.title.slice(0, 190)} (fork)`;
	const { projectId, model, reasoning, route, baseBranch, baseSha, planMode, spaceId } = source;
	await insertSession({ id: forkId, projectId, title, model, reasoning, route, baseBranch, baseSha, branch: projectId ? branchFor(title, forkId) : SCRATCH_BRANCH, planMode, spaceId });
	if (await copyCheckpoint(id, forkId)) {
		machineFor(forkId).catch((error: unknown) => logProblem('warn', 'The fork\'s sandbox did not start', error, forkId));
	}
	return getSession(forkId);
}

export async function listSessions(): Promise<Session[]> {
	const [records, running] = await Promise.all([listSessionRecords(), runningKeys()]);
	return records.map((record) => present(record, running));
}

/** A project's threads as the page shows them, newest first. */
export async function listThreads(spaceId: string): Promise<Session[]> {
	const [records, running] = await Promise.all([listThreadRecords(spaceId), runningKeys()]);
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

export type SessionChange = {
	title?: string;
	model?: string;
	reasoning?: Reasoning | null;
	route?: ModelRoute | null;
	planMode?: boolean;
	pinned?: boolean;
	resolved?: boolean;
};

/**
 * The route a session keeps after a change: the one asked for, else its own. A provider belongs to its
 * model, so another model leaves it to the gateway; a sort carries over to a model on a gateway.
 */
function routeAfter(record: SessionRecord | null, change: SessionChange, model: string | undefined): ModelRoute | null | undefined {
	if ('route' in change) return change.route ?? null;
	if (!model || !record || model === record.model) return undefined;
	if (!record.route) return undefined;
	return record.route.sort && routable(model) ? record.route : null;
}

/**
 * Renames the task, changes its model or reasoning level, turns plan mode on or off, pins it, or marks it
 * done or open again; the agent sees a change from the next prompt.
 */
export async function editSession(id: string, change: SessionChange): Promise<Session> {
	const model = change.model && (await knownModel(change.model));
	const title = change.title?.trim();
	const record = 'route' in change || model ? await getSessionRecord(id) : null;
	const route = routeAfter(record, change, model || undefined);
	if (route && !routable(model || record?.model || '')) throw new InvalidInputError('Only a model on OpenRouter or Vercel AI Gateway takes a provider or sort.');
	await updateSession(id, {
		...(title ? { title } : {}),
		...(model ? { model } : {}),
		...(route !== undefined ? { routeJson: route ? JSON.stringify(route) : null } : {}),
		...('reasoning' in change ? { reasoning: change.reasoning } : {}),
		// Turning plan mode on or off (approving the plan turns it off) leaves no plan waiting.
		...(change.planMode !== undefined ? { planMode: change.planMode, plan: null } : {}),
		...(change.pinned !== undefined ? { pinnedAt: change.pinned ? new Date().toISOString() : null } : {}),
		...(change.resolved !== undefined ? { resolvedAt: change.resolved ? new Date().toISOString() : null } : {}),
	});
	return getSession(id);
}

/** The default model a failed reply can be sent again on, when the task runs on another one; null when it already runs on it. */
export async function fallbackModel(id: string): Promise<{ model: string; name: string } | null> {
	const [record, general] = await Promise.all([getSessionRecord(id), generalSettings()]);
	if (!record) throw new NotFoundError('Session not found');
	const model = general.model ?? config.model;
	if (model === record.model) return null;
	const info = await findModel(model).catch(() => undefined);
	return info ? { model, name: info.name } : null;
}

/** Moves the task to the default model, at the default reasoning level as a new task would start, so its next message runs there. */
export async function switchToFallbackModel(id: string): Promise<Session> {
	const fallback = await fallbackModel(id);
	if (!fallback) throw new InvalidInputError('This task already runs on the default model.');
	return editSession(id, { model: fallback.model, reasoning: (await generalSettings()).reasoning });
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
		await saveCheckpoint(id, machine).catch((error: unknown) => logProblem('warn', 'Checkpoint before stop failed', error, id));
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
	// Its Browser panel's browser too, which the host would otherwise keep until it idles out.
	await closeBrowser(id).catch((error: unknown) => logProblem('warn', 'Could not close the task browser', error, id));
	await deleteCheckpoints(id);
	await forgetSubagentRuns(id);
	await forgetScriptCalls(id);
	forgetResults(id);
	await deleteSessionRecord(id);
}
