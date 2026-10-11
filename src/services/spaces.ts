import type { Reasoning } from '../core/ports.ts';
import type { Session } from '../core/types.ts';
import { announce } from '../core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import { THREAD_STATES, type ThreadState } from '../core/thread-state.ts';
import { getProject, listProjects } from '../db/projects.ts';
import { getSessionRecord, updateSession } from '../db/sessions.ts';
import { type Autonomy, deleteSpaceRecord, getSpace, insertSpace, listSpaces, type Space, type SpaceState, setSpaceRepos, spaceSpend, touchSpace, updateSpace } from '../db/spaces.ts';
import { stopAgent } from './activity.ts';
import { sendToAgent } from './agent-runner.ts';
import { startOfToday } from './budget.ts';
import { logProblem } from './log.ts';
import { findModel } from './models.ts';
import { createSession, getSession, listThreads } from './sessions.ts';

/** Instructions every thread and the coordinator read; long enough for a real brief, short enough to send each turn. */
export const MAX_INSTRUCTIONS = 16_000;
/** Notes the agents save about the project, as for a repository. */
export const MAX_SPACE_MEMORY = 8_000;

export type SpaceRepo = { id: string; repoFullName: string; defaultBranch: string };

/** A project as the page shows it: its repositories by name, and its threads counted by state. */
export type SpaceView = Space & {
	repos: SpaceRepo[];
	counts: Record<ThreadState, number>;
	threads: number;
	/** The newest thread's last activity, or when the project was made. */
	activeAt: string;
};

const emptyCounts = () => Object.fromEntries(THREAD_STATES.map((state) => [state, 0])) as Record<ThreadState, number>;

async function present(space: Space, threads?: Session[]): Promise<SpaceView> {
	const [list, repos] = await Promise.all([threads ?? listThreads(space.id), Promise.all(space.repoIds.map((id) => getProject(id)))]);
	const counts = emptyCounts();
	for (const thread of list) if (thread.threadState) counts[thread.threadState] += 1;
	const times = list.map((thread) => thread.checkpointAt ?? thread.createdAt);
	return {
		...space,
		repos: repos.flatMap((repo) => (repo ? [{ id: repo.id, repoFullName: repo.repoFullName, defaultBranch: repo.defaultBranch }] : [])),
		counts,
		threads: list.length,
		activeAt: [space.updatedAt, ...times].sort().pop() ?? space.createdAt,
	};
}

export async function spacesView(): Promise<SpaceView[]> {
	const spaces = await listSpaces();
	return (await Promise.all(spaces.map((space) => present(space)))).sort((a, b) => b.activeAt.localeCompare(a.activeAt));
}

async function existing(id: string): Promise<Space> {
	const space = await getSpace(id);
	if (!space) throw new NotFoundError('Project not found');
	return space;
}

export async function spaceView(id: string): Promise<SpaceView> {
	return present(await existing(id));
}

/** Only repositories Anton already knows, so every thread can start on one. */
async function knownRepos(ids: string[]): Promise<string[]> {
	const known = new Set((await listProjects()).map((project) => project.id));
	const unknown = ids.filter((id) => !known.has(id));
	if (unknown.length) throw new InvalidInputError('Add each repository in Settings first');
	return [...new Set(ids)];
}

export type SpaceInput = { name: string; icon?: string | null; goal?: string; repoIds: string[]; instructions?: string; autonomy?: Autonomy; maxParallel?: number };

export async function createSpace(input: SpaceInput): Promise<SpaceView> {
	const name = input.name.trim();
	if (!name) throw new InvalidInputError('Name the project');
	const repoIds = await knownRepos(input.repoIds);
	if (repoIds.length === 0) throw new InvalidInputError('Pick at least one repository; every thread works on one');
	const id = await insertSpace({ name, icon: input.icon?.trim() || null, goal: input.goal?.trim() ?? '', instructions: input.instructions, autonomy: input.autonomy, maxParallel: input.maxParallel });
	await setSpaceRepos(id, repoIds);
	return spaceView(id);
}

export type SpaceChange = Partial<{
	name: string;
	icon: string | null;
	goal: string;
	instructions: string;
	memory: string;
	coordinatorModel: string | null;
	coordinatorReasoning: Reasoning | null;
	threadModel: string | null;
	threadReasoning: Reasoning | null;
	maxParallel: number;
	autonomy: Autonomy;
	state: SpaceState;
	repoIds: string[];
}>;

async function checkModel(model: string | null | undefined): Promise<void> {
	if (model && !(await findModel(model))) throw new InvalidInputError(`Unknown model: ${model}`);
}

export async function editSpace(id: string, change: SpaceChange): Promise<SpaceView> {
	await existing(id);
	await Promise.all([checkModel(change.coordinatorModel), checkModel(change.threadModel)]);
	const { repoIds, ...fields } = change;
	if (fields.name !== undefined && !fields.name.trim()) throw new InvalidInputError('Name the project');
	if ((fields.instructions?.length ?? 0) > MAX_INSTRUCTIONS) throw new InvalidInputError(`Keep the instructions under ${MAX_INSTRUCTIONS.toLocaleString()} characters`);
	if ((fields.memory?.length ?? 0) > MAX_SPACE_MEMORY) throw new InvalidInputError(`Keep the memory under ${MAX_SPACE_MEMORY.toLocaleString()} characters`);
	if (repoIds) {
		const known = await knownRepos(repoIds);
		if (known.length === 0) throw new InvalidInputError('Keep at least one repository');
		await setSpaceRepos(id, known);
	}
	await updateSpace(id, {
		...fields,
		...(fields.name !== undefined ? { name: fields.name.trim() } : {}),
		...(fields.icon !== undefined ? { icon: fields.icon?.trim() || null } : {}),
		...(fields.memory !== undefined ? { memory: fields.memory.trim() } : {}),
	});
	// Unpausing, or a higher limit, frees slots for queued threads.
	if (change.state === 'active' || change.maxParallel !== undefined) await drainQueue(id);
	return spaceView(id);
}

/** Removes the project and stops its coordinator; its threads stay as tasks of their own. */
export async function removeSpace(id: string): Promise<void> {
	await existing(id);
	await stopAgent(id);
	await deleteSpaceRecord(id);
}

/** A thread named by its id or the start of it, as the coordinator sees them. */
export async function findThread(spaceId: string, ref: string): Promise<Session> {
	const wanted = ref.trim().replace(/^\[|\]$/g, '').replace(/^id:/, '');
	const threads = await listThreads(spaceId);
	const exact = threads.find((thread) => thread.id === wanted);
	if (exact) return exact;
	const matches = wanted.length >= 4 ? threads.filter((thread) => thread.id.startsWith(wanted)) : [];
	if (matches.length === 1) return matches[0];
	const titled = threads.filter((thread) => thread.title.toLowerCase() === wanted.toLowerCase());
	if (titled.length === 1) return titled[0];
	throw new NotFoundError(`No thread ${ref} in this project`);
}

export type ThreadInput = { title: string; brief: string; projectId?: string; repo?: string; model?: string; reasoning?: Reasoning; planMode?: boolean };

/** The repository a new thread works on: the one named, or the project's first. */
async function repoFor(space: Space, input: ThreadInput): Promise<string> {
	if (input.projectId) {
		if (!space.repoIds.includes(input.projectId)) throw new InvalidInputError('That repository is not in this project');
		return input.projectId;
	}
	if (input.repo) {
		const wanted = input.repo.trim().toLowerCase();
		const projects = await Promise.all(space.repoIds.map((id) => getProject(id)));
		const match = projects.find((project) => project && (project.repoFullName.toLowerCase() === wanted || project.repoFullName.split('/').pop()?.toLowerCase() === wanted));
		if (!match) throw new InvalidInputError(`${input.repo} is not one of this project's repositories`);
		return match.id;
	}
	const first = space.repoIds[0];
	if (!first) throw new InvalidInputError('Add a repository to the project first');
	return first;
}

/**
 * Starts a thread: a task on one of the project's repositories, given its
 * brief as its first message. When the project already has as many threads
 * working as it allows, or is paused, the thread waits as queued and starts
 * when a slot frees.
 */
export async function startThread(spaceId: string, input: ThreadInput): Promise<Session> {
	const space = await existing(spaceId);
	if (space.state === 'archived') throw new ConflictError('The project is archived; restore it to start threads');
	const brief = input.brief.trim();
	if (!brief) throw new InvalidInputError('Say what the thread should do');
	const projectId = await repoFor(space, input);
	const title = input.title.trim() || brief.split('\n')[0].slice(0, 60);
	const thread = await createSession({
		projectId,
		title,
		spaceId,
		brief,
		model: input.model ?? space.threadModel ?? undefined,
		reasoning: input.reasoning ?? (input.model ? undefined : (space.threadReasoning ?? undefined)),
		planMode: input.planMode,
	});
	await touchSpace(spaceId);
	await drainQueue(spaceId);
	return getSession(thread.id);
}

/**
 * Threads given their brief that have not shown as working yet: dispatching
 * returns before the runtime says the reply runs, so they hold their slot
 * until then, or a minute at most.
 */
const launching = new Map<string, number>();
const LAUNCH_MS = 60_000;

/** The thread finished a reply, so it no longer holds a slot as launching. */
export function launched(threadId: string): void {
	launching.delete(threadId);
}

const draining = new Map<string, Promise<void>>();

/** Starts queued threads, oldest first, while the project has free slots; one pass at a time per project. */
export function drainQueue(spaceId: string): Promise<void> {
	const previous = draining.get(spaceId) ?? Promise.resolve();
	const next = previous.then(() => drain(spaceId)).catch((error: unknown) => logProblem('warn', 'Could not start queued threads', error));
	draining.set(spaceId, next);
	return next;
}

async function drain(spaceId: string): Promise<void> {
	const space = await getSpace(spaceId);
	if (!space || space.state !== 'active') return;
	const threads = await listThreads(spaceId);
	const now = Date.now();
	const busy = threads.filter((thread) => {
		if (thread.threadState === 'working') return true;
		const at = launching.get(thread.id);
		return at !== undefined && now - at < LAUNCH_MS;
	}).length;
	const queued = threads.filter((thread) => thread.brief && !thread.resolvedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	for (const thread of queued.slice(0, Math.max(0, space.maxParallel - busy))) {
		const brief = thread.brief!;
		launching.set(thread.id, now);
		await updateSession(thread.id, { brief: null });
		try {
			await sendToAgent(thread.id, brief);
		} catch (error) {
			// Put the brief back, so the thread starts once the reason (a spending cap, a restore) is gone.
			launching.delete(thread.id);
			await updateSession(thread.id, { brief });
			logProblem('warn', 'A queued thread could not start', error, thread.id);
			return;
		}
	}
	announce({ kind: 'space', id: spaceId, what: 'threads' });
}

/** Sends a thread a message as if you typed it: the card's next-step buttons, and the coordinator's follow-ups. */
export async function nudgeThread(spaceId: string, threadId: string, text: string): Promise<Session> {
	const record = await getSessionRecord(threadId);
	if (!record || record.spaceId !== spaceId) throw new NotFoundError('No such thread in this project');
	const message = text.trim();
	if (!message) throw new InvalidInputError('Say what to send');
	// A queued thread has not started yet: the note joins its brief.
	if (record.brief) {
		await updateSession(threadId, { brief: `${record.brief}\n\n${message}` });
		return getSession(threadId);
	}
	if (record.resolvedAt) await updateSession(threadId, { resolvedAt: null });
	await updateSession(threadId, { asking: null });
	await sendToAgent(threadId, message);
	return getSession(threadId);
}

/** Moves a task into a project as a thread, or out of one; the repository must be one of the project's. */
export async function moveToSpace(threadId: string, spaceId: string | null): Promise<Session> {
	const record = await getSessionRecord(threadId);
	if (!record) throw new NotFoundError('Session not found');
	if (spaceId) {
		const space = await existing(spaceId);
		if (!space.repoIds.includes(record.projectId)) await setSpaceRepos(spaceId, [...space.repoIds, record.projectId]);
	}
	await updateSession(threadId, { spaceId, brief: null, reportedState: null });
	announce({ kind: 'sessions' });
	if (record.spaceId) announce({ kind: 'space', id: record.spaceId, what: 'threads' });
	if (spaceId) announce({ kind: 'space', id: spaceId, what: 'threads' });
	return getSession(threadId);
}

export type SpaceUsage = {
	today: number;
	month: number;
	/** Each thread's spend this month; the coordinator's under the project's own id. */
	byThread: Array<{ id: string; title: string; tokens: number; cost: number }>;
	byModel: Array<{ key: string | null; tokens: number; cost: number }>;
	daily: Array<{ day: string; cost: number }>;
};

/** What the project has spent this month, by thread and model, and each day. */
export async function spaceUsage(id: string, now = new Date()): Promise<SpaceUsage> {
	await existing(id);
	const month = startOfToday(now);
	month.setDate(1);
	const [spend, threads] = await Promise.all([spaceSpend(id, month), listThreads(id)]);
	const titles = new Map(threads.map((thread) => [thread.id, thread.title]));
	const todayKey = startOfToday(now).toISOString().slice(0, 10);
	return {
		today: spend.daily.filter((day) => day.day >= todayKey).reduce((sum, day) => sum + day.cost, 0),
		month: spend.byThread.reduce((sum, row) => sum + row.cost, 0),
		byThread: spend.byThread.map((row) => ({ id: row.key, title: row.key === id ? 'Coordinator' : (titles.get(row.key) ?? 'Removed thread'), tokens: row.tokens, cost: row.cost })),
		byModel: spend.byModel,
		daily: spend.daily,
	};
}
