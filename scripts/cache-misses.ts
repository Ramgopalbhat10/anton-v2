import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { type Client, createClient } from '@libsql/client';
import { expandConfig, isInMemoryConfig } from '@libsql/core/config';
import { config } from '../src/config.ts';
import { unrouted } from '../src/core/model-route.ts';
import { type CacheCall, cacheMisses, callsFromTraces, MISS_CLASSES, missSummary, type MissTally } from '../src/core/prompt-cache.ts';
import type { Trace } from '../src/core/trace.ts';

/**
 * Which of the main agent's model calls missed the provider's prompt cache,
 * and why (`missClass`, src/core/prompt-cache.ts): a changed system prompt or
 * tool list is a fault in the render, while a cache that held its prefix and
 * still read nothing is the provider's. It reads the traces Anton keeps of
 * each reply (`response_traces`) from its database, or a benchmark's folder
 * with --run, and makes no model call and starts no sandbox.
 *
 *   npm run cache:misses                               # the 20 tasks traced most recently
 *   npm run cache:misses -- --tasks 50                 # the 50 traced most recently
 *   npm run cache:misses -- --since 2026-11-01         # tasks traced since then
 *   npm run cache:misses -- <task id> <task id>        # those tasks
 *   npm run cache:misses -- --run data/deepswe-20/tasks
 *
 * The database is the one Anton runs on (TURSO_DATABASE_URL, else
 * data/anton.db under ANTON_DATA_DIR), which it only reads. A benchmark
 * folder holds a folder per task with the runtime's events (`events.jsonl`)
 * and the provider's usage of each response (`provider-usage.jsonl`), which
 * counts the system message and the tool list apart: with no keys of the
 * prompt there, a change in their token counts stands for a changed prompt.
 */

type RunEvent = {
	type?: string;
	taskId?: string;
	purpose?: string;
	agentName?: string;
	conversationId?: string;
	submissionId?: string;
	timestamp?: string;
	durationMs?: number;
	request?: { providerId?: string; requestedModel?: string };
	response?: { responseId?: string };
};
type ProviderUsage = {
	id: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		attribution?: { request_fields?: { tools?: { input_tokens?: number } }; items?: Record<string, { input_tokens?: number }> };
	};
};
type Counted = Pick<CacheCall, 'usage' | 'prompt' | 'toolset'>;

/** Each response's usage as the trace keeps it, with its system message's and tool list's token counts standing for their keys. */
export function providerUsage(text: string): Map<string, Counted> {
	const counted = new Map<string, Counted>();
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const { id, usage } = JSON.parse(line) as ProviderUsage;
		if (!id || !usage) continue;
		const read = usage.input_tokens_details?.cached_tokens ?? 0;
		const write = usage.input_tokens_details?.cache_write_tokens ?? 0;
		// The first input item is the system message.
		const system = Object.values(usage.attribution?.items ?? {})[0]?.input_tokens;
		const tools = usage.attribution?.request_fields?.tools?.input_tokens;
		counted.set(id, {
			usage: { input: Math.max(0, (usage.input_tokens ?? 0) - read - write), output: usage.output_tokens ?? 0, cacheRead: read, cacheWrite: write, cost: 0 },
			prompt: system === undefined ? '' : `system ${system} tokens`,
			toolset: tools === undefined ? '' : `tools ${tools} tokens`,
		});
	}
	return counted;
}

/**
 * One benchmark task's main conversations, from its events in order and its provider usage: the calls the provider
 * counted (others failed before it did), with subagents' calls and compaction's summaries left out, as in a trace.
 */
export async function runConversations(task: string, events: AsyncIterable<string> | Iterable<string>, usage: Map<string, Counted>): Promise<{ conversations: CacheCall[][]; uncounted: number }> {
	const conversations = new Map<string, CacheCall[]>();
	const numbers = new Map<string, number>();
	let compacted = false;
	let uncounted = 0;
	for await (const line of events) {
		if (!line.trim()) continue;
		const event = JSON.parse(line) as RunEvent;
		if (event.taskId || (event.agentName && /^reviewer$/i.test(event.agentName))) continue;
		if (event.type === 'compaction') compacted = true;
		if (event.type !== 'turn' || (event.purpose ?? 'agent') !== 'agent') continue;
		const counted = usage.get(event.response?.responseId ?? '');
		if (!counted?.usage || !(counted.usage.input + counted.usage.cacheRead + counted.usage.cacheWrite)) {
			uncounted++;
			continue;
		}
		const reply = event.submissionId ?? 'reply';
		const number = (numbers.get(reply) ?? 0) + 1;
		numbers.set(reply, number);
		const end = Date.parse(event.timestamp ?? '') || 0;
		const conversation = event.conversationId ?? 'main';
		const calls = conversations.get(conversation) ?? conversations.set(conversation, []).get(conversation)!;
		calls.push({ task, reply, number, model: unrouted(`${event.request?.providerId ?? ''}/${event.request?.requestedModel ?? ''}`), ...counted, start: end - (event.durationMs ?? 0), end, compacted });
		compacted = false;
	}
	return { conversations: [...conversations.values()], uncounted };
}

/** Every task of a benchmark folder, each read a line at a time: a task's events run to megabytes. */
async function runFolder(folder: string): Promise<{ conversations: CacheCall[][]; uncounted: number }> {
	const all: CacheCall[][] = [];
	let uncounted = 0;
	for (const task of readdirSync(folder, { withFileTypes: true })) {
		const dir = path.join(folder, task.name);
		if (!task.isDirectory() || !existsSync(path.join(dir, 'events.jsonl')) || !existsSync(path.join(dir, 'provider-usage.jsonl'))) continue;
		const usage = providerUsage(readFileSync(path.join(dir, 'provider-usage.jsonl'), 'utf8'));
		const read = await runConversations(task.name, createInterface({ input: createReadStream(path.join(dir, 'events.jsonl')), crlfDelay: Infinity }), usage);
		all.push(...read.conversations);
		uncounted += read.uncounted;
	}
	return { conversations: all, uncounted };
}

export type TraceQuery = { tasks?: string[]; since?: Date | null; latest?: number };

/** The main conversations of the tasks traced most recently (or those named, or traced since a date), each task's traces oldest first. */
export async function traceConversations(db: Client, query: TraceQuery = {}): Promise<CacheCall[][]> {
	const table = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'response_traces'");
	if (!table.rows.length) return [];
	let tasks = query.tasks ?? [];
	if (!tasks.length) {
		const since = query.since ? 'WHERE created_at >= ?' : '';
		const latest = await db.execute({
			sql: `SELECT session_id, MAX(created_at) AS last FROM response_traces ${since} GROUP BY session_id ORDER BY last DESC LIMIT ?`,
			args: [...(query.since ? [query.since.toISOString()] : []), query.latest ?? 20],
		});
		tasks = latest.rows.map((row) => String(row.session_id));
	}
	const conversations: CacheCall[][] = [];
	for (const task of tasks) {
		const rows = await db.execute({ sql: 'SELECT trace_json FROM response_traces WHERE session_id = ? ORDER BY created_at', args: [task] });
		const calls = callsFromTraces(
			task,
			rows.rows.map((row) => JSON.parse(String(row.trace_json)) as Trace),
		);
		if (calls.length) conversations.push(calls);
	}
	return conversations;
}

const count = (value: number) => value.toLocaleString('en-US');
const percent = (part: number, whole: number) => `${whole ? ((part / whole) * 100).toFixed(1) : '0.0'}%`;

function tallyText(tally: MissTally): string[] {
	const classes = MISS_CLASSES.filter((kind) => tally.byClass[kind]).map((kind) => `  ${String(tally.byClass[kind]).padStart(5)}  ${kind}`);
	return [`${count(tally.calls)} calls, ${count(tally.misses)} ${tally.misses === 1 ? 'miss' : 'misses'} (${percent(tally.misses, tally.calls)})`, ...classes, `  ${count(tally.uncached)} input tokens the misses sent uncached`];
}

/** Each miss on a line (its task, its number in its reply, the gap, the tokens either side, its class), then the summary. */
export function missesText(conversations: CacheCall[][]): string {
	const summary = missSummary(conversations);
	if (!summary.calls) return 'No model calls of the main agent to read.';
	const misses = conversations.flatMap(cacheMisses);
	const head = ['task', 'call', 'gap s', 'previous', 'input', 'cached', 'next cached', 'class'];
	const rows = misses.map((miss) => {
		const input = (call: CacheCall) => (call.usage ? call.usage.input + call.usage.cacheRead + call.usage.cacheWrite : 0);
		return [
			miss.call.task,
			`#${miss.call.number}`,
			(miss.gapMs / 1000).toFixed(1),
			count(input(miss.previous)),
			count(input(miss.call)),
			count(miss.call.usage?.cacheRead ?? 0),
			miss.next ? count(miss.next.usage?.cacheRead ?? 0) : '-',
			miss.class,
		];
	});
	const widths = head.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
	// Text columns read from the left, numbers from the right.
	const line = (cells: string[]) => cells.map((cell, column) => (column === 0 || column === cells.length - 1 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  ').trimEnd();
	const table = misses.length
		? ['Calls that read under half of the previous call’s input from the cache:', '', line(head), ...rows.map(line), '']
		: ['No call missed the cache.', ''];
	const models = summary.models.length > 1 ? summary.models.flatMap((model) => ['', `${model.model}:`, ...tallyText(model)]) : [];
	return [...table, ...tallyText(summary), ...models].join('\n');
}

/** Anton's database, which this only reads (it is not migrated, as the server's is); null when it is a file not made yet. */
function openDatabase(): Client | null {
	const options = { url: config.databaseUrl, authToken: config.databaseToken || undefined };
	const expanded = expandConfig(options, true);
	if (expanded.scheme === 'file' && !isInMemoryConfig(expanded) && !existsSync(expanded.path)) return null;
	return createClient(options);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { run: { type: 'string' }, since: { type: 'string' }, tasks: { type: 'string', default: '20' } },
	});
	if (values.run) {
		const { conversations, uncounted } = await runFolder(values.run);
		console.log(missesText(conversations));
		if (uncounted) console.log(`\n${uncounted} main ${uncounted === 1 ? 'call' : 'calls'} with no usage from the provider (failed calls) left out.`);
		return;
	}
	const since = values.since === undefined ? null : new Date(values.since);
	if (since && Number.isNaN(since.getTime())) throw new Error(`Not a date: ${values.since}`);
	const latest = Number(values.tasks);
	if (!Number.isInteger(latest) || latest < 1) throw new Error(`Not a number of tasks: ${values.tasks}`);
	const db = openDatabase();
	const conversations = db ? await traceConversations(db, { tasks: positionals, since, latest }) : [];
	db?.close();
	console.log(conversations.length ? missesText(conversations) : 'No traces to read: Anton keeps one for each reply of a task once it has run.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
