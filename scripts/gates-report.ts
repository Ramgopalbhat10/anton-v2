import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createFlueClient } from '@flue/sdk';
import { runTasks } from './tool-mix.ts';

/**
 * How often each check at a reply's end sent a reply back, and how often the
 * agent then changed a file or ran anything: a send-back after which the agent
 * only talked was most likely not needed. Each reply keeps its send-backs in
 * its metadata (`sendBacks`, src/services/send-backs.ts); this reads them from
 * a running Anton, as `tool:mix` does.
 *
 *   npm run gates:report                               # every task
 *   npm run gates:report -- --since 2026-11-01         # tasks made since then
 *   npm run gates:report -- --runs runs.jsonl          # the tasks an anton:run --out file lists
 *   npm run gates:report -- <task id> <task id>        # those tasks
 *
 * It talks to Anton at --url (or ANTON_URL; `npm start` serves http://127.0.0.1:3000).
 */

export type ReplySendBacks = { sendBacks?: Array<{ gate: string; changed: boolean; worked: boolean }> };
export type GateRow = { gate: string; sent: number; changed: number; worked: number };

/** The checks in the order a reply's end runs them. */
const ORDER = ['todo', 'stall', 'jobs', 'check', 'review', 'completion'];

/** The replies' send-backs added up per check, in the order the checks run. */
export function gateRows(replies: ReplySendBacks[]): { replies: number; sentBack: number; rows: GateRow[] } {
	const rows = new Map<string, GateRow>();
	let sentBack = 0;
	for (const reply of replies) {
		if (reply.sendBacks?.length) sentBack++;
		for (const entry of reply.sendBacks ?? []) {
			const row = rows.get(entry.gate) ?? { gate: entry.gate, sent: 0, changed: 0, worked: 0 };
			rows.set(entry.gate, row);
			row.sent++;
			if (entry.changed) row.changed++;
			if (entry.worked) row.worked++;
		}
	}
	const rank = (gate: string) => (ORDER.includes(gate) ? ORDER.indexOf(gate) : ORDER.length);
	return { replies: replies.length, sentBack, rows: [...rows.values()].sort((a, b) => rank(a.gate) - rank(b.gate) || a.gate.localeCompare(b.gate)) };
}

const share = (part: number, whole: number) => `${whole ? Math.round((part / whole) * 100) : 0}%`.padStart(5);

/** The report as text: one line per check, then the total. */
export function gatesText(report: ReturnType<typeof gateRows>): string {
	if (!report.rows.length) return `${report.replies} replies read; no check sent any back.`;
	const lines = report.rows.map(
		(row) => `${row.gate.padEnd(10)}  ${String(row.sent).padStart(5)}  ${String(row.changed).padStart(7)} ${share(row.changed, row.sent)}  ${String(row.worked).padStart(6)} ${share(row.worked, row.sent)}`,
	);
	const total = report.rows.reduce((sum, row) => ({ sent: sum.sent + row.sent, changed: sum.changed + row.changed, worked: sum.worked + row.worked }), { sent: 0, changed: 0, worked: 0 });
	return [
		`${report.replies} replies read, ${report.sentBack} sent back at least once.`,
		'',
		'check        sent  changed         ran',
		...lines,
		`${'all'.padEnd(10)}  ${String(total.sent).padStart(5)}  ${String(total.changed).padStart(7)} ${share(total.changed, total.sent)}  ${String(total.worked).padStart(6)} ${share(total.worked, total.sent)}`,
		'',
		'changed: the agent changed a file after the send-back. ran: it changed a file or ran a command.',
	].join('\n');
}

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
	const replies: ReplySendBacks[] = [];
	for (const task of tasks) {
		// A task that was never sent a message has no conversation.
		const history = await createFlueClient({ url: `${base}/api/agents/coder/${encodeURIComponent(task)}` })
			.history()
			.catch(() => null);
		for (const message of history?.messages ?? []) if (message.role === 'assistant' && message.metadata) replies.push(message.metadata as ReplySendBacks);
	}
	console.log(gatesText(gateRows(replies)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
