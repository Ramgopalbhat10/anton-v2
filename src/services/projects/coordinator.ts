import { registerRoutedModels } from '../../core/routed-models.ts';
import { config } from '../../config.ts';
import type { Session } from '../../core/types.ts';
import { THREAD_STATE_LABELS } from '../../core/thread-state.ts';
import { getProject } from '../../db/projects.ts';
import { getSpace, listSpaces } from '../../db/spaces.ts';
import { listSpaceTodos } from '../../db/space-todos.ts';
import { shortTodoId, type SpaceTodo } from '../../core/space-todos.ts';
import { generalSettings } from '../models/general.ts';
import { findModel, reasoningFor } from '../models/models.ts';
import { type ModelChoice, listThreads } from '../tasks/sessions.ts';
import { agentNow } from '../tasks/agent-now.ts';
import { deletedThreads } from './deleted-threads.ts';
import { minutes, runReport, subagentRuns } from '../tasks/subagent-runs.ts';

/** The coordinator never reads a thread's transcript: a fresh state block each message lets its own conversation compact freely. */
export type CoordinatorBrief = ModelChoice & { name: string; state: string; propose: boolean };

const briefs = new Map<string, CoordinatorBrief>();

/** The coordinator renders synchronously, so it reads its project from here; filled before every message. */
export function coordinatorBrief(spaceId: string): CoordinatorBrief {
	return briefs.get(spaceId) ?? { model: config.model, reasoning: 'low', name: 'this project', state: '', propose: false };
}

const clip = (text: string, length: number) => {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

const prNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1];

export function threadLine(thread: Session): string {
	const parts = [`[${thread.id.slice(0, 8)}] "${thread.title}"`, thread.repo || 'no repository', THREAD_STATE_LABELS[thread.threadState ?? 'idle']];
	if (thread.prUrl) {
		const pr = thread.pullRequest;
		parts.push(`PR #${prNumber(thread.prUrl) ?? '?'}${pr ? ` ${pr.state}${pr.checks ? `, checks ${pr.checks}` : ''}${pr.approved ? ', approved' : ''}` : ''}`);
	}
	if (thread.status === 'error' && thread.errorMessage) parts.push(`failed: ${clip(thread.errorMessage, 160)}`);
	else if (thread.stoppedAt && thread.threadState === 'waiting') parts.push('stopped by the user before it finished');
	if (thread.asking) parts.push(`asks: "${clip(thread.asking, 200)}"`);
	else if (thread.brief) parts.push(`brief: "${clip(thread.brief, 160)}"`);
	else if (thread.lastReply) parts.push(`last said: "${clip(thread.lastReply, 200)}"`);
	return `- ${parts.join(' · ')}`;
}

/** Enough for the coordinator to say where a quiet thread is, or that it is stuck on one step. */
export async function threadActivity(threadId: string, now = Date.now()): Promise<string> {
	const lines: string[] = [];
	const live = agentNow(threadId);
	if (live) {
		const what = [live.what, live.tool, live.detail ? `(${clip(live.detail, 120)})` : ''].filter(Boolean).join(' ');
		lines.push(`Doing now: ${what}, for ${minutes(Math.max(0, now - Date.parse(live.since)))}.`);
	}
	for (const run of (await subagentRuns(threadId).catch(() => [])).filter((entry) => entry.status === 'running')) {
		lines.push(runReport(run, now));
		const step = run.steps.at(-1);
		if (step?.state === 'running') lines.push(`Its current step has run for ${minutes(Math.max(0, now - Date.parse(step.at)))}.`);
	}
	return lines.join('\n');
}

const RESOLVED_SHOWN = 5;

const todoLine = (todo: SpaceTodo, repoNames: Map<string, string>) =>
	`- [todo:${shortTodoId(todo.id)}] "${todo.title}" · ${todo.status === 'open' ? 'open' : todo.threads ? `in progress (${todo.threads} thread${todo.threads === 1 ? '' : 's'})` : 'started, no thread yet'}${todo.threadModel ? ` · main thread model: ${todo.threadModel.model}` : ''}${todo.runOn === 'host' ? ' · runs on: this server' : ''}${taggedLine(todo, repoNames)}${todo.attachments.length ? ` · files: ${todo.attachments.map((file) => file.path).join(', ')}` : ''}`;

const taggedLine = (todo: SpaceTodo, repoNames: Map<string, string>) => {
	const names = todo.repos.flatMap((id) => repoNames.get(id) ?? []);
	return names.length ? ` · repositories: ${names.join(', ')}` : '';
};

export async function stateBlock(spaceId: string): Promise<string> {
	const space = await getSpace(spaceId);
	if (!space) return '';
	const [threads, repos, deleted, todos] = await Promise.all([
		listThreads(spaceId),
		Promise.all(space.repoIds.map((id) => getProject(id))),
		deletedThreads(spaceId),
		listSpaceTodos(spaceId),
	]);
	const pending = todos.filter((todo) => todo.status !== 'done');
	const repoNames = new Map(repos.flatMap((repo) => (repo ? [[repo.id, repo.repoFullName] as const] : [])));
	const open = threads.filter((thread) => thread.threadState !== 'resolved');
	const resolved = threads.filter((thread) => thread.threadState === 'resolved').slice(0, RESOLVED_SHOWN);
	const working = open.filter((thread) => thread.threadState === 'working').length;
	const queued = open.filter((thread) => thread.threadState === 'queued').length;
	const lines = [
		`Project: ${space.name}${space.state !== 'active' ? ` (${space.state}: no thread starts until it is active again)` : ''}`,
		space.goal ? `Goal: ${space.goal}` : '',
		`Repositories: ${repos.flatMap((repo) => (repo ? [repo.repoFullName] : [])).join(', ') || 'none, so threads start as chats with no repository (add_repo adds one Anton knows)'}`,
		`Parallel limit: ${space.maxParallel} threads working at once; now ${working} working, ${queued} queued.`,
		space.instructions ? `\nProject instructions from the user:\n${space.instructions}` : '',
		space.memory ? `\nProject memory (notes saved earlier; they may be out of date):\n${space.memory}` : '',
		...(pending.length ? [`\nTo-dos not done (${pending.length}):`, ...pending.map((todo) => todoLine(todo, repoNames))] : []),
		`\nThreads, newest first (${open.length} open):`,
		...(open.length ? open.map(threadLine) : ['- none yet']),
		...(resolved.length ? [`Recently resolved:`, ...resolved.map(threadLine)] : []),
		...(deleted.length
			? [
					`Deleted by the user (gone: they take no messages; a follow-up to one goes to a new thread whose brief carries what it found, and its saved files are in the Library under From threads/<its title>/):`,
					...deleted.map((thread) => `- [${thread.id.slice(0, 8)}] "${thread.title}" · deleted ${thread.at.slice(0, 10)}${thread.lastReply ? ` · last said: "${clip(thread.lastReply, 200)}"` : ''}`),
				]
			: []),
	];
	return lines.filter(Boolean).join('\n');
}

export async function coordinatorModel(space: { coordinatorModel: string | null }): Promise<string> {
	return space.coordinatorModel ?? (await generalSettings()).model ?? config.model;
}

export async function primeCoordinator(spaceId: string): Promise<void> {
	const space = await getSpace(spaceId);
	if (!space) return;
	const model = await coordinatorModel(space);
	const info = await findModel(model).catch(() => undefined);
	// A coordinator only routes and answers, so it runs at low reasoning unless the project says otherwise.
	const reasoning = reasoningFor(info, space.coordinatorReasoning ?? (info?.reasoning.includes('low') ? 'low' : null));
	registerRoutedModels(`coordinator:${spaceId}`, [model]);
	briefs.set(spaceId, { model, reasoning, name: space.name, state: await stateBlock(spaceId), propose: space.autonomy === 'propose' });
}

export async function primeAllCoordinators(): Promise<void> {
	for (const space of await listSpaces()) await primeCoordinator(space.id).catch(() => undefined);
}
