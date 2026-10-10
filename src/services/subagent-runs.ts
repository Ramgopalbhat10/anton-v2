import { announce } from '../core/changes.ts';
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
	status: 'running' | 'done' | 'failed';
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
			run.model = event.request?.requestedModel ?? run.model;
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
			run.status = event.isError ? 'failed' : 'done';
			run.durationMs = event.durationMs ?? Date.now() - Date.parse(run.startedAt);
			const result = typeof event.result === 'string' ? event.result : event.result == null ? '' : JSON.stringify(event.result);
			run.result = result.slice(0, MAX_RESULT) || null;
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

/** For tests: forget everything kept in memory. */
export function resetSubagentRunsForTests(): void {
	runs.clear();
	loading.clear();
}
