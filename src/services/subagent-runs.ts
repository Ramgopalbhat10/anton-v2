import { announce } from '../core/changes.ts';
import { unrouted } from '../core/model-route.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { logProblem } from './log.ts';
import { toUsage } from './usage.ts';

/**
 * What each task's subagents are doing and did, for the thread and the Agents
 * panel. The runtime never shows a subagent's own conversation to the client,
 * so Anton keeps a record from the runtime's events as they happen: the brief,
 * every tool step, the model, tokens, and the result. Kept in memory while it
 * runs and saved per task, so a reload or restart still shows it.
 */

export type SubagentStep = {
	/** The tool call's id. */
	id: string;
	tool: string;
	/** The tool's input, long strings cut, to describe the step. */
	input: unknown;
	state: 'running' | 'done' | 'failed';
	at: string;
	durationMs: number | null;
	/** What a step the decision model drove did inside it: each action and how sure the model was, and what its calls cost. */
	detail?: StepDetail;
};

export type StepDetail = {
	/** How it ended, such as done or needs_confirmation; null while it works. */
	outcome: string | null;
	actions: Array<{ what: string; p: number | null; failed?: boolean }>;
	decisions: number;
	cost: number;
	/** The step was a run_script program, and the actions are the calls it made. */
	script?: boolean;
};

export type SubagentRun = {
	/** The runtime's task id. */
	id: string;
	agent: string;
	/** The brief the coding agent wrote, as given. */
	prompt: string;
	/** Its short label for the work, when it gave one. */
	description: string | null;
	/** The task tool call that started it, when the runtime said. */
	toolCallId: string | null;
	/** Stopped: the user stopped it, alone or with the whole reply. */
	status: 'running' | 'done' | 'failed' | 'stopped';
	startedAt: string;
	durationMs: number | null;
	model: string | null;
	tokens: number;
	calls: number;
	steps: SubagentStep[];
	/** What it is writing now, while it writes. */
	writing: string | null;
	/** Its final answer, or why it failed. */
	result: string | null;
};

type Event = {
	type: string;
	instanceId?: string;
	taskId?: string;
	agent?: string;
	prompt?: string;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	isError?: boolean;
	result?: unknown;
	durationMs?: number;
	timestamp?: string;
	message?: { role?: string; content?: unknown };
	request?: { requestedModel?: string };
	response?: { usage?: Parameters<typeof toUsage>[0] };
};

/** A task keeps its latest runs; each run its latest steps. */
const MAX_RUNS = 40;
const MAX_STEPS = 200;
const MAX_STRING = 1000;
const MAX_RESULT = 8000;

const key = (id: string) => `subagents.${id}`;
const runs = new Map<string, SubagentRun[]>();
const loading = new Map<string, Promise<SubagentRun[]>>();

/** A task's runs, read from storage once and kept. */
function runsOf(id: string): Promise<SubagentRun[]> {
	const known = runs.get(id);
	if (known) return Promise.resolve(known);
	let pending = loading.get(id);
	if (!pending) {
		pending = getSetting<SubagentRun[]>(key(id), [])
			.catch(() => [])
			.then((stored) => {
				const list = runs.get(id) ?? stored;
				runs.set(id, list);
				loading.delete(id);
				return list;
			});
		loading.set(id, pending);
	}
	return pending;
}

/** Long strings cut, so a step that wrote a big file does not make the record big. */
function trimmed(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
	if (depth > 4 || value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.slice(0, 50).map((item) => trimmed(item, depth + 1));
	return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, trimmed(item, depth + 1)]));
}

function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : '')).join('');
}

// Changes are told to open pages, and saved, at most this often per task while runs go on.
const SETTLE_MS = 400;
const SAVE_MS = 2000;
const announcing = new Map<string, ReturnType<typeof setTimeout>>();
const saving = new Map<string, ReturnType<typeof setTimeout>>();

function changed(id: string, now = false) {
	if (!announcing.has(id)) {
		announcing.set(
			id,
			setTimeout(() => {
				announcing.delete(id);
				announce({ kind: 'task', id, what: 'subagents' });
			}, SETTLE_MS),
		);
	}
	clearTimeout(saving.get(id));
	saving.set(
		id,
		setTimeout(() => void save(id), now ? 0 : SAVE_MS),
	);
}

async function save(id: string) {
	saving.delete(id);
	const list = runs.get(id);
	if (list) await setSetting(key(id), list).catch((error: unknown) => logProblem('warn', 'Could not keep the subagents record', error, id));
}

/**
 * The `task` calls that are about to start a run, by task and brief: the
 * runtime's start event names neither the call nor the label the agent gave it.
 */
const delegating = new Map<string, { toolCallId: string; description: string | null }>();
const delegation = (instanceId: string, prompt: string) => `${instanceId}\n${prompt}`;

/** Records one runtime event if it is about a subagent. Runs in the event observer; never throws. */
export function recordSubagentEvent(event: Event): void {
	if (!event.instanceId) return;
	if (event.type === 'tool_start' && event.toolName === 'task' && event.toolCallId) {
		const args = (event.args ?? {}) as { prompt?: unknown; description?: unknown };
		if (typeof args.prompt === 'string') {
			delegating.set(delegation(event.instanceId, args.prompt), { toolCallId: event.toolCallId, description: typeof args.description === 'string' ? args.description : null });
			// A call that never starts a run (an agent not on offer) is not kept for long.
			for (const stale of [...delegating.keys()].slice(0, Math.max(0, delegating.size - 50))) delegating.delete(stale);
		}
		return;
	}
	if (!event.taskId) return;
	const id = event.instanceId;
	void runsOf(id)
		.then((list) => apply(id, list, event))
		.catch((error: unknown) => logProblem('warn', 'Could not record a subagent step', error, id));
}

function apply(id: string, list: SubagentRun[], event: Event) {
	const at = event.timestamp ?? new Date().toISOString();
	if (event.type === 'task_start') {
		if (list.some((run) => run.id === event.taskId)) return;
		const call = delegating.get(delegation(id, event.prompt ?? ''));
		delegating.delete(delegation(id, event.prompt ?? ''));
		list.push({
			id: event.taskId!,
			agent: event.agent ?? 'flue-general',
			prompt: event.prompt ?? '',
			description: call?.description ?? null,
			toolCallId: call?.toolCallId ?? event.toolCallId ?? null,
			status: 'running',
			startedAt: at,
			durationMs: null,
			model: null,
			tokens: 0,
			calls: 0,
			steps: [],
			writing: null,
			result: null,
		});
		list.splice(0, Math.max(0, list.length - MAX_RUNS));
		return changed(id);
	}
	const run = list.find((entry) => entry.id === event.taskId);
	if (!run) return;
	switch (event.type) {
		case 'turn_request':
			run.model = event.request?.requestedModel ? unrouted(event.request.requestedModel) : run.model;
			break;
		case 'turn':
			if (event.response?.usage) {
				const usage = toUsage(event.response.usage);
				run.tokens += usage.inputTokens + usage.outputTokens;
				run.calls += 1;
			}
			break;
		case 'tool_start': {
			if (!event.toolCallId || run.steps.some((step) => step.id === event.toolCallId)) return;
			const detail = notes.get(event.toolCallId);
			notes.delete(event.toolCallId);
			run.steps.push({ id: event.toolCallId, tool: event.toolName ?? 'tool', input: trimmed(event.args), state: 'running', at, durationMs: null, ...(detail ? { detail } : {}) });
			run.steps.splice(0, Math.max(0, run.steps.length - MAX_STEPS));
			run.writing = null;
			break;
		}
		case 'tool': {
			const step = run.steps.find((entry) => entry.id === event.toolCallId);
			if (!step) return;
			step.state = event.isError ? 'failed' : 'done';
			step.durationMs = event.durationMs ?? null;
			break;
		}
		case 'message_end':
			if (event.message?.role !== 'assistant') return;
			run.writing = textOf(event.message.content).trim().slice(-400) || run.writing;
			break;
		case 'task': {
			const stopped = stopping.delete(run.id);
			run.status = stopped ? 'stopped' : event.isError ? 'failed' : 'done';
			run.durationMs = event.durationMs ?? Date.now() - Date.parse(run.startedAt);
			const result = typeof event.result === 'string' ? event.result : event.result == null ? '' : JSON.stringify(event.result);
			// Stopped alone, the result is what the agent was told; stopped with the reply, only the abort's own error.
			run.result = stopped && event.isError ? STOPPED_WITH_REPLY : result.slice(0, MAX_RESULT) || null;
			run.writing = null;
			// Steps the runtime never closed (an interrupted batch) end with the run.
			for (const step of run.steps) if (step.state === 'running') step.state = run.status === 'failed' ? 'failed' : 'done';
			return changed(id, true);
		}
		default:
			return;
	}
	changed(id);
}

/** Details a tool gave for its step before the runtime's start event was recorded, by tool call. */
const notes = new Map<string, StepDetail>();
const MAX_ACTIONS_KEPT = 40;

/**
 * Records what a tool did inside one step (a browser step the decision model
 * drove, say), so the Agents panel can show it as it happens.
 */
export async function noteStep(id: string, toolCallId: string, detail: StepDetail): Promise<void> {
	const kept: StepDetail = { ...detail, actions: detail.actions.slice(-MAX_ACTIONS_KEPT).map((action) => ({ ...action, what: action.what.slice(0, 300) })) };
	const list = await runsOf(id).catch(() => null);
	const step = list?.flatMap((run) => run.steps).find((entry) => entry.id === toolCallId);
	if (!step) {
		notes.set(toolCallId, kept);
		for (const stale of [...notes.keys()].slice(0, Math.max(0, notes.size - 50))) notes.delete(stale);
		return;
	}
	step.detail = kept;
	changed(id);
}

/** The brief of the task's latest running subagent of this kind, for tools that judge a page against its job. */
export async function currentBrief(id: string, agent: string): Promise<string | null> {
	const list = await runsOf(id);
	for (let index = list.length - 1; index >= 0; index--) if (list[index].agent === agent && list[index].status === 'running') return list[index].prompt;
	return null;
}

/** The task's subagent runs, newest first. */
export async function subagentRuns(id: string): Promise<SubagentRun[]> {
	return [...(await runsOf(id))].reverse();
}

/** Forgets a deleted task's runs. */
export async function forgetSubagentRuns(id: string): Promise<void> {
	runs.delete(id);
	await setSetting(key(id), null);
}

/**
 * Stopping one subagent. The runtime keeps no handle to a running subagent
 * outside itself, so the call that runs one (`src/flue/subagent-stop.ts`)
 * says here how to end it; ending it answers the agent's `task` call with
 * what the run had done, and the agent carries on.
 */
const stoppers = new Map<string, (note: string) => void>();
/** Runs being stopped, by run id, so their end reads Stopped rather than Failed. */
const stopping = new Set<string>();

/** Registers how to end a running subagent; returns what to call once it has ended. */
export function onSubagentStop(runId: string, stop: (note: string) => void): () => void {
	stoppers.set(runId, stop);
	return () => {
		if (stoppers.get(runId) === stop) stoppers.delete(runId);
	};
}

const STOPPED_WITH_REPLY = 'Stopped with the reply.';

/** Stops one of the task's running subagents; false when it is not running here (finished, or from before a restart). */
export async function stopSubagent(id: string, runId: string): Promise<boolean> {
	const run = (await runsOf(id)).find((entry) => entry.id === runId);
	const stop = stoppers.get(runId);
	if (!run || run.status !== 'running' || !stop) return false;
	stoppers.delete(runId);
	stopping.add(runId);
	stop(stoppedNote(run));
	return true;
}

/**
 * Ends a subagent that has run past its time, as a stop does: its task call answers with what it had done,
 * and the agent carries on. False when it is not running here.
 */
export async function endOverTime(id: string, runId: string, budgetMs: number): Promise<boolean> {
	const run = (await runsOf(id)).find((entry) => entry.id === runId);
	const stop = stoppers.get(runId);
	if (!run || run.status !== 'running' || !stop) return false;
	stoppers.delete(runId);
	stopping.add(runId);
	stop(
		[
			`This subagent ran past its ${Math.round(budgetMs / 60_000)} minutes and was ended. Use what it found; if more is needed, brief a narrower job, or read pages yourself with web_fetch.`,
			runReport(run, Date.now(), 'ended'),
		].join('\n'),
	);
	return true;
}

/** The whole reply is being stopped: its running subagents end as stopped, not failed. */
export function noteRepliesStopping(id: string): void {
	for (const run of runs.get(id) ?? []) if (run.status === 'running') stopping.add(run.id);
}

const MAX_NOTE_STEPS = 12;

/** A step in a line: the tool and what it was given, the part that tells most. */
export function stepLine(step: SubagentStep): string {
	const input = (step.input ?? {}) as Record<string, unknown>;
	const named = ['command', 'path', 'url', 'goal', 'action', 'query', 'pattern', 'code'].map((name) => input[name]).find((value) => typeof value === 'string' && value.trim());
	const what = typeof named === 'string' ? named : step.input === undefined ? '' : JSON.stringify(step.input);
	const line = `${step.tool} ${what.replace(/\s+/g, ' ').trim()}`.trim();
	const cut = line.length > 160 ? `${line.slice(0, 160)}…` : line;
	return `${cut}${step.state === 'failed' ? ' (failed)' : step.state === 'running' ? ' (running)' : ''}`;
}

/** A duration as the agent reads it: 45s, or 3m 20s. */
export const minutes = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** What a run did, for the agent: how long, how many steps, the latest of them, and what it wrote last. */
export function runReport(run: SubagentRun, now = Date.now(), status: string = run.status): string {
	const took = run.durationMs ?? Math.max(0, now - Date.parse(run.startedAt));
	const lines = [`${run.agent} subagent, ${status}: "${(run.description ?? run.prompt.split('\n')[0] ?? '').slice(0, 120)}". ${run.steps.length} steps over ${minutes(took)}.`];
	const shown = run.steps.slice(-MAX_NOTE_STEPS);
	if (shown.length) {
		lines.push(run.steps.length > shown.length ? `Its last ${shown.length} steps:` : 'Its steps:');
		for (const step of shown) lines.push(`- ${stepLine(step)}`);
	}
	if (run.status === 'running' && run.writing) lines.push(`What it last wrote: ${run.writing}`);
	if (run.status !== 'running' && run.result) lines.push(`${run.status === 'done' ? 'Its answer' : 'How it ended'}: ${run.result.slice(0, 1500)}`);
	return lines.join('\n');
}

/** What the agent's `task` call answers when the user stops a subagent: that they did, and how far it got. */
function stoppedNote(run: SubagentRun): string {
	return [
		'The user stopped this subagent before it finished. Do not start it again unless they ask; carry on with what you have and their latest message.',
		runReport(run, Date.now(), 'stopped'),
	].join('\n');
}

/** For tests: forget everything kept in memory. */
export function resetSubagentRunsForTests(): void {
	runs.clear();
	loading.clear();
	stoppers.clear();
	stopping.clear();
}
