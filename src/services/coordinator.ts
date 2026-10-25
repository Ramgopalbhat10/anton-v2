import { config } from '../config.ts';
import type { Session } from '../core/types.ts';
import { THREAD_STATE_LABELS } from '../core/thread-state.ts';
import { getProject } from '../db/projects.ts';
import { getSpace, listSpaces } from '../db/spaces.ts';
import { generalSettings } from './general.ts';
import { findModel, reasoningFor } from './models.ts';
import { type ModelChoice, listThreads } from './sessions.ts';
import { agentNow } from './agent-now.ts';
import { minutes, runReport, subagentRuns } from './subagent-runs.ts';

/**
 * What a project's coordinator knows each turn. It never reads a thread's
 * transcript: before every message it gets a fresh state block (the goal,
 * instructions, memory, repositories and a line per thread), so its own
 * conversation can be compacted freely and its context stays small.
 */
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

/** One line per thread: what it is, where it stands, and what it last said or asks. */
export function threadLine(thread: Session): string {
	const parts = [`[${thread.id.slice(0, 8)}] "${thread.title}"`, thread.repo || 'no repository', THREAD_STATE_LABELS[thread.threadState ?? 'idle']];
	if (thread.prUrl) {
		const pr = thread.pullRequest;
		parts.push(`PR #${prNumber(thread.prUrl) ?? '?'}${pr ? ` ${pr.state}${pr.checks ? `, checks ${pr.checks}` : ''}${pr.approved ? ', approved' : ''}` : ''}`);
	}
	if (thread.status === 'error' && thread.errorMessage) parts.push(`failed: ${clip(thread.errorMessage, 160)}`);
	if (thread.asking) parts.push(`asks: "${clip(thread.asking, 200)}"`);
	else if (thread.brief) parts.push(`brief: "${clip(thread.brief, 160)}"`);
	else if (thread.lastReply) parts.push(`last said: "${clip(thread.lastReply, 200)}"`);
	return `- ${parts.join(' · ')}`;
}

/**
 * What a working thread is doing this moment and for how long, and its running subagents' latest steps:
 * enough for the coordinator to say where a quiet thread is, or that it is stuck on one step.
 */
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

/** Open threads all, and the latest few resolved, so a long-lived project's block stays short. */
const RESOLVED_SHOWN = 5;

export async function stateBlock(spaceId: string): Promise<string> {
	const space = await getSpace(spaceId);
	if (!space) return '';
	const [threads, repos] = await Promise.all([listThreads(spaceId), Promise.all(space.repoIds.map((id) => getProject(id)))]);
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
		`\nThreads, newest first (${open.length} open):`,
		...(open.length ? open.map(threadLine) : ['- none yet']),
		...(resolved.length ? [`Recently resolved:`, ...resolved.map(threadLine)] : []),
	];
	return lines.filter(Boolean).join('\n');
}

/** Loads the coordinator's model and its project's state block, before each message it is given. */
export async function primeCoordinator(spaceId: string): Promise<void> {
	const space = await getSpace(spaceId);
	if (!space) return;
	const general = await generalSettings();
	const model = space.coordinatorModel ?? general.model ?? config.model;
	const info = await findModel(model).catch(() => undefined);
	// A coordinator only routes and answers, so it runs at low reasoning unless the project says otherwise.
	const reasoning = reasoningFor(info, space.coordinatorReasoning ?? (info?.reasoning.includes('low') ? 'low' : null));
	briefs.set(spaceId, { model, reasoning, name: space.name, state: await stateBlock(spaceId), propose: space.autonomy === 'propose' });
}

/** Every project's coordinator, for replies the runtime resumes at startup. */
export async function primeAllCoordinators(): Promise<void> {
	for (const space of await listSpaces()) await primeCoordinator(space.id).catch(() => undefined);
}
