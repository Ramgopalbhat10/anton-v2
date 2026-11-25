import type { Project } from '../../core/types.ts';
import { HOST_TAGS_ONLY, outsideHostTags, todoBrief, type SpaceTodo } from '../../core/space-todos.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../../core/errors.ts';
import { logProblem } from '../../core/log.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { getSpace, type Space } from '../../db/spaces.ts';
import { getSpaceTodo, todoIdOfThread, todoIdsOfThread } from '../../db/space-todos.ts';
import { changes } from '../git/git.ts';
import { readCheckpoint } from '../git/checkpoints.ts';
import { choiceOf, decide } from '../models/decisions.ts';
import { liveMachine } from '../sandbox/workspace.ts';
import { forgetRepoContext, sendToAgent } from '../tasks/agent-runner.ts';
import { moveToRepo } from '../tasks/sessions.ts';
import { findSpaceRepo, spaceRepos } from './spaces.ts';

/*
 * A thread works in one repository. A to-do started as a thread goes to the repositories the user tagged it with, one
 * thread each; untagged, the decision model picks one from its words, and when it cannot tell the thread starts with none
 * and asks. Either way the thread checks the fit before changing anything and can move with `set_repo` while it has
 * changed nothing.
 */

/** Below this the decision model's pick counts as a guess, and the thread asks instead. */
export const PICK_AT = 0.6;
const REQUEST_CHARS = 4_000;
const GOAL_CHARS = 600;

const names = (projects: Project[]) => projects.map((project) => project.repoFullName).join(', ');

const CHECK_FIT =
	"Before you change anything, check that the request belongs in this repository. If it fits, go ahead without asking. If it clearly belongs in another of the project's repositories, or you cannot tell, use ask to confirm with the user, offering the likely repositories as options, then call set_repo with their answer.";

/** Null when there is no decision model, it fails, or it is not sure. Usage counts against the project. */
export async function pickRepo(space: Space, todo: Pick<SpaceTodo, 'title' | 'description'>, repos: Project[]): Promise<Project | null> {
	const options: Record<string, string> = Object.fromEntries(repos.map((project, index) => [`r${index}`, `The work is in the ${project.repoFullName} repository`]));
	options.unclear = 'The request does not say or clearly imply which one of these repositories the work is in';
	const answers = await decide(
		space.id,
		{ project: space.name, goal: space.goal.slice(0, GOAL_CHARS), repositories: repos.map((project) => project.repoFullName), request: todoBrief(todo).slice(0, REQUEST_CHARS) },
		{ repo: { type: 'choice', instructions: "A coding agent is about to work on this project to-do in one of the project's repositories. Which repository is the work in?", options } },
	);
	const pick = choiceOf(answers?.repo);
	if (!pick || pick.choice === 'unclear' || pick.p < PICK_AT) return null;
	return repos[Number(pick.choice.slice(1))] ?? null;
}

/** Where a to-do started as a thread goes: one entry per thread, with what that thread is told about its repository. */
export type RepoPlan = { projectId: string | null; repo: string | null; context?: string; part?: string };

export async function todoThreadPlan(space: Space, todo: SpaceTodo): Promise<RepoPlan[]> {
	const repos = await spaceRepos(space);
	const tagged = todo.repos.flatMap((id) => repos.filter((project) => project.id === id));
	if (tagged.length) {
		return tagged.map((project) => ({
			projectId: project.id,
			repo: project.repoFullName,
			context:
				tagged.length > 1
					? `The user tagged this to-do with ${names(tagged)}; each has a thread of its own, and this one works only in ${project.repoFullName}. ${CHECK_FIT}`
					: `The user tagged this to-do with ${project.repoFullName}. ${CHECK_FIT}`,
			...(tagged.length > 1 ? { part: `its changes in ${project.repoFullName}` } : {}),
		}));
	}
	if (repos.length <= 1) return [{ projectId: repos[0]?.id ?? null, repo: repos[0]?.repoFullName ?? null }];
	const picked = await pickRepo(space, todo, repos);
	if (picked) {
		return [{ projectId: picked.id, repo: picked.repoFullName, context: `No repository was tagged on this to-do, so Anton picked ${picked.repoFullName} from its words. The project's repositories: ${names(repos)}. ${CHECK_FIT}` }];
	}
	return [
		{
			projectId: null,
			repo: null,
			context: `No repository was tagged on this to-do and Anton could not tell which of the project's repositories it belongs in: ${names(repos)}. This thread has no repository yet. Before any other work, use ask to have the user pick, offering the likeliest ones (they can type another, or name more than one). Then call set_repo with the repositories they chose.`,
		},
	];
}

const moving = new Map<string, string>();

/** The repository a thread moves to once its reply ends; the reply skips its end checks then. */
export const pendingRepoMove = (id: string): string | null => moving.get(id) ?? null;
const applying = new Map<string, string>();
/** The repository a thread is about to move to, from `set_repo` until the move is done. */
export const repoMoveTarget = (id: string): string | null => moving.get(id) ?? applying.get(id) ?? null;

export const dropRepoMove = (id: string): void => void moving.delete(id);

/** Moving leaves the old repository's changes behind, so only a thread that changed and pushed nothing there moves. */
async function assertMovable(id: string, current: string | null): Promise<void> {
	const session = await getSessionRecord(id);
	if (!session) throw new NotFoundError('Thread not found');
	if (session.prUrl || session.pushedSha) throw new ConflictError(`This thread already pushed work to ${current}. Finish it here; the user can start a new thread for the other repository.`);
	if (!session.projectId) return;
	const machine = await liveMachine(id);
	const changed = machine ? await changes(machine, session.baseSha) : await readCheckpoint(id);
	if (changed && (changed.files.length || changed.log.length)) {
		throw new ConflictError(`This thread has changed files in ${current}, which moving would leave behind. Finish here, or ask the user whether to start a new thread for the other repository.`);
	}
}

type StartIn = (todoId: string, repos: Project[], from: string) => Promise<Array<{ id: string; title: string }>>;

/**
 * The first repository is this thread's; each other one gets a thread of its own for the same to-do. A move waits for
 * the reply to end (`applyRepoMove`), since the reply's tools and prompt belong to the repository it started in.
 */
export async function setThreadRepos(id: string, refs: string[], startIn: StartIn): Promise<{ output: string; moving: boolean }> {
	const session = await getSessionRecord(id);
	const space = session?.spaceId ? await getSpace(session.spaceId) : null;
	if (!session || !space) throw new InvalidInputError('Only a thread in a project can choose its repository.');
	const found = await Promise.all(refs.map((ref) => findSpaceRepo(space, ref)));
	const projects = found.filter((project, index) => found.findIndex((other) => other.id === project.id) === index);
	const [first, ...rest] = projects;
	if (!first) throw new InvalidInputError('Name at least one of the project\'s repositories.');
	const todoId = rest.length ? await todoIdOfThread(id) : null;
	if (rest.length && !todoId) throw new InvalidInputError('Only a thread started from a project to-do can start threads for other repositories. Pass one repository.');
	if (session.runOn === 'host') {
		const linked = await Promise.all((await todoIdsOfThread(id)).map((todo) => getSpaceTodo(todo)));
		if (linked.some((todo) => todo && outsideHostTags({ ...todo, runOn: 'host' }, projects.map(({ id: repo }) => repo)))) throw new InvalidInputError(HOST_TAGS_ONLY);
	}
	const current = session.projectId ? ((await spaceRepos(space)).find((project) => project.id === session.projectId)?.repoFullName ?? 'its repository') : null;
	const stays = first.id === session.projectId;
	if (!stays) await assertMovable(id, current);
	const started = todoId ? await startIn(todoId, rest, first.repoFullName) : [];
	const others = started.length ? ` Started ${started.map((thread) => `"${thread.title}"`).join(', ')} for ${names(rest)}; do none of that work here.` : '';
	if (stays) return { moving: false, output: `This thread already works in ${first.repoFullName}.${others}` };
	moving.set(id, first.id);
	return { moving: true, output: `This thread moves to ${first.repoFullName} when this reply ends, and Anton then tells you to carry on there.${others} Stop here; write nothing after this.` };
}

/** Runs once the reply that asked for it has ended. */
export async function applyRepoMove(id: string): Promise<void> {
	const projectId = moving.get(id);
	if (!projectId) return;
	moving.delete(id);
	applying.set(id, projectId);
	try {
		const moved = await moveToRepo(id, projectId);
		applying.delete(id);
		forgetRepoContext(id);
		await sendToAgent(id, `Anton moved this thread to ${moved.repo} (branch ${moved.branch} from ${moved.baseBranch}). Carry on with the request there.`);
	} catch (error) {
		applying.delete(id);
		logProblem('warn', 'Could not move the thread to another repository', error, id);
		await sendToAgent(id, `Anton could not move this thread to the other repository: ${error instanceof Error ? error.message : String(error)}. Tell the user, and carry on where you are only if they say so.`).catch(() => undefined);
	}
}
