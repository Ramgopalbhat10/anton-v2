import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createFlueClient } from '@flue/sdk';

/**
 * Which tools each model called, and how often, over a run's replies: after a
 * benchmark, to see whether a tool profile (`ANTON_TOOL_PROFILE`,
 * src/core/tool-profile.ts) changed what the model reaches for, without
 * reading raw events. Each reply keeps its tool calls by model (`tools`) and
 * its profile (`toolProfile`) with its usage; this reads them from a running
 * Anton, as `anton:run` talks to it.
 *
 *   npm run tool:mix                               # every task
 *   npm run tool:mix -- --since 2026-11-01         # tasks made since then
 *   npm run tool:mix -- --runs runs.jsonl          # the tasks an anton:run --out file lists
 *   npm run tool:mix -- <task id> <task id>        # those tasks
 *
 * It talks to Anton at --url (or ANTON_URL; `npm start` serves http://127.0.0.1:3000).
 */

/** What a reply's metadata says of its tools: the calls by model, then by tool, and the profile it ran under. */
export type ReplyTools = { tools?: Record<string, Record<string, number>>; toolProfile?: string };
export type MixRow = { model: string; profile: string; replies: number; tools: Record<string, number> };

/** The replies' tool calls added up by model and profile, the most called first. A reply from before profiles counts under `edit`. */
export function toolMix(replies: ReplyTools[]): MixRow[] {
	const rows = new Map<string, MixRow>();
	for (const reply of replies) {
		const profile = reply.toolProfile ?? 'edit';
		for (const [model, tools] of Object.entries(reply.tools ?? {})) {
			const key = `${model}\n${profile}`;
			const row = rows.get(key) ?? { model, profile, replies: 0, tools: {} };
			rows.set(key, row);
			row.replies++;
			for (const [tool, count] of Object.entries(tools)) row.tools[tool] = (row.tools[tool] ?? 0) + count;
		}
	}
	const total = (row: MixRow) => Object.values(row.tools).reduce((sum, count) => sum + count, 0);
	return [...rows.values()].sort((a, b) => total(b) - total(a));
}

/** The rows as text: a heading per model and profile, then each tool with its count and share. */
export function mixText(rows: MixRow[]): string {
	if (!rows.length) return 'No tool calls in the replies read.';
	return rows
		.map((row) => {
			const tools = Object.entries(row.tools).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
			const total = tools.reduce((sum, [, count]) => sum + count, 0);
			const width = Math.max(...tools.map(([tool]) => tool.length));
			const lines = tools.map(([tool, count]) => `  ${tool.padEnd(width)}  ${String(count).padStart(6)}  ${((count / total) * 100).toFixed(1).padStart(5)}%`);
			return [`${row.model} · ${row.profile} profile · ${row.replies} ${row.replies === 1 ? 'reply' : 'replies'} · ${total} tool calls`, ...lines].join('\n');
		})
		.join('\n\n');
}

/** The task ids an `anton:run --out` file lists, one JSON result a line. */
export const runTasks = (text: string): string[] =>
	text
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => (JSON.parse(line) as { task: string }).task)
		.filter(Boolean);

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { url: { type: 'string', default: process.env.ANTON_URL ?? 'http://127.0.0.1:3000' }, since: { type: 'string' }, runs: { type: 'string' } },
	});
	const base = values.url!.replace(/\/$/, '');
	const since = values.since === undefined ? null : new Date(values.since);
	if (since && Number.isNaN(since.getTime())) throw new Error(`Not a date: ${values.since}`);
	let tasks = [...positionals, ...(values.runs ? runTasks(await readFile(values.runs, 'utf8')) : [])];
	if (!tasks.length) {
		const response = await fetch(`${base}/api/sessions`);
		if (!response.ok) throw new Error(`GET /api/sessions: ${response.status} ${await response.text()}`);
		const { sessions } = (await response.json()) as { sessions: Array<{ id: string; createdAt: string }> };
		tasks = sessions.filter((session) => !since || Date.parse(session.createdAt) >= since.getTime()).map((session) => session.id);
	}
	const replies: ReplyTools[] = [];
	for (const task of tasks) {
		// A task that was never sent a message has no conversation.
		const history = await createFlueClient({ url: `${base}/api/agents/coder/${encodeURIComponent(task)}` })
			.history()
			.catch(() => null);
		for (const message of history?.messages ?? []) if (message.role === 'assistant' && message.metadata) replies.push(message.metadata as ReplyTools);
	}
	console.log(mixText(toolMix(replies)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
