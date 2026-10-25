import { readFile, appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createFlueClient } from '@flue/sdk';

/**
 * Runs tasks on a running Anton without the UI, one at a time, and records what
 * each cost: for small benchmark runs, and for checking a harness change
 * against the same tasks before and after it.
 *
 *   npm run anton:run -- "Fix the failing test in src/date.ts"
 *   npm run anton:run -- --tasks tasks.jsonl --project <id> --model openrouter/z-ai/glm-5 --out runs.jsonl
 *
 * It talks to Anton at --url (or ANTON_URL; `npm start` serves http://127.0.0.1:3000, `npm run dev` the API at :43128).
 * A tasks file has one JSON object a line: `{"name": "...", "prompt": "...", "project": "...", "model": "..."}`,
 * all but `prompt` optional. Each task is a new task in Anton (open it there to see what it did) and gives one
 * JSON line: how it ended, its reply, how long it took, and its tokens, cost, model calls and largest context.
 */

export type RunTask = { name?: string; prompt: string; project?: string; model?: string; reasoning?: string };
export type RunResult = {
	name: string;
	task: string;
	outcome: 'completed' | 'failed' | 'aborted' | 'timed-out';
	error?: string;
	seconds: number;
	inputTokens: number;
	cachedTokens: number;
	outputTokens: number;
	cost: number;
	calls: number;
	peakContext: number;
	reply: string;
};

type Usage = { inputTokens: number; outputTokens: number; cost: number; cachedTokens?: number };
/** What a run needs from Anton, so a test can stand in for the server. */
export type AntonApi = {
	createTask(task: RunTask): Promise<string>;
	/** Sends the prompt and resolves with the reply once the task's response settles. */
	send(id: string, prompt: string, signal: AbortSignal): Promise<string>;
	stop(id: string): Promise<void>;
	usage(id: string): Promise<Usage>;
	context(id: string): Promise<{ used: number; task: { calls: number } }>;
};

/** Anton's HTTP API at `base`. */
export function httpApi(base: string, fetcher: typeof fetch = fetch): AntonApi {
	const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
		const response = await fetcher(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
		if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	const client = (id: string) => createFlueClient({ url: `${base}/api/agents/coder/${encodeURIComponent(id)}`, fetch: fetcher });
	return {
		createTask: async (task) => {
			const body = { projectId: task.project, model: task.model, reasoning: task.reasoning, titleFrom: task.prompt.slice(0, 40_000), ...(task.name ? { title: task.name } : {}) };
			return (await json<{ id: string }>('/api/sessions', { method: 'POST', body: JSON.stringify(body) })).id;
		},
		send: async (id, prompt, signal) => {
			const conversation = client(id);
			const admission = await conversation.send({ message: { kind: 'user', body: prompt } });
			return (await conversation.read(admission, { signal })).text;
		},
		stop: async (id) => void (await client(id).abort()),
		usage: async (id) => (await json<{ usage: Usage }>(`/api/sessions/${encodeURIComponent(id)}`)).usage,
		context: (id) => json(`/api/sessions/${encodeURIComponent(id)}/context`),
	};
}

/** Runs one task to its end, or until `timeoutMs`, when it is stopped. */
export async function runTask(api: AntonApi, task: RunTask, timeoutMs: number, now = () => Date.now()): Promise<RunResult> {
	const started = now();
	const id = await api.createTask(task);
	let outcome: RunResult['outcome'] = 'completed';
	let error: string | undefined;
	let reply = '';
	const stop = new AbortController();
	const timer = setTimeout(() => stop.abort(new Error(`Timed out after ${timeoutMs / 1000}s`)), timeoutMs);
	const timeout = stop.signal;
	try {
		reply = await api.send(id, task.prompt, timeout);
	} catch (problem) {
		if (timeout.aborted) {
			outcome = 'timed-out';
			await api.stop(id).catch(() => undefined);
		} else {
			const failure = (problem as { failure?: string }).failure;
			outcome = failure === 'aborted' ? 'aborted' : 'failed';
			error = problem instanceof Error ? problem.message : String(problem);
		}
	} finally {
		clearTimeout(timer);
	}
	const seconds = Math.round((now() - started) / 100) / 10;
	const [usage, context] = await Promise.all([api.usage(id).catch(() => null), api.context(id).catch(() => null)]);
	return {
		name: task.name ?? task.prompt.split('\n')[0].slice(0, 60),
		task: id,
		outcome,
		...(error ? { error } : {}),
		seconds,
		inputTokens: usage?.inputTokens ?? 0,
		cachedTokens: usage?.cachedTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0,
		cost: usage?.cost ?? 0,
		calls: context?.task.calls ?? 0,
		peakContext: context?.used ?? 0,
		reply,
	};
}

/** One line on all the runs, for the end of the output. */
export function summary(results: RunResult[]): string {
	const sum = (pick: (result: RunResult) => number) => results.reduce((total, result) => total + pick(result), 0);
	const done = results.filter((result) => result.outcome === 'completed').length;
	const tokens = sum((result) => result.inputTokens + result.outputTokens);
	return `${done}/${results.length} completed in ${Math.round(sum((result) => result.seconds))}s: ${tokens.toLocaleString('en-US')} tokens (${sum((result) => result.cachedTokens).toLocaleString('en-US')} cached), $${sum((result) => result.cost).toFixed(4)}`;
}

/** The tasks a JSON-lines file lists. */
export function parseTasks(text: string): RunTask[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('//'))
		.map((line, index) => {
			const task = JSON.parse(line) as RunTask;
			if (typeof task.prompt !== 'string' || !task.prompt.trim()) throw new Error(`Task ${index + 1} has no prompt`);
			return task;
		});
}

/** `30m`, `90s`, `2h`, or minutes. */
export function parseDuration(text: string): number {
	const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(text.trim());
	if (!match) throw new Error(`Not a duration: ${text}`);
	return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[(match[2] ?? 'm') as 's' | 'm' | 'h'];
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			url: { type: 'string', default: process.env.ANTON_URL ?? 'http://127.0.0.1:3000' },
			tasks: { type: 'string' },
			project: { type: 'string' },
			model: { type: 'string' },
			reasoning: { type: 'string' },
			timeout: { type: 'string', default: '30m' },
			out: { type: 'string' },
		},
	});
	const tasks = values.tasks ? parseTasks(await readFile(values.tasks, 'utf8')) : positionals.length ? [{ prompt: positionals.join(' ') }] : [];
	if (!tasks.length) throw new Error('Give a prompt, or --tasks with a JSON-lines file of them.');
	const api = httpApi(values.url!.replace(/\/$/, ''));
	const results: RunResult[] = [];
	for (const task of tasks) {
		const run = { ...task, project: task.project ?? values.project, model: task.model ?? values.model, reasoning: task.reasoning ?? values.reasoning };
		console.error(`→ ${run.name ?? run.prompt.split('\n')[0].slice(0, 60)}`);
		const result = await runTask(api, run, parseDuration(values.timeout!));
		results.push(result);
		const line = JSON.stringify(result);
		if (values.out) await appendFile(values.out, `${line}\n`);
		else console.log(line);
		console.error(`  ${result.outcome} in ${result.seconds}s, $${result.cost.toFixed(4)}, ${result.calls} calls, task ${result.task}`);
	}
	console.error(summary(results));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
