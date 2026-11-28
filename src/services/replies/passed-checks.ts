import { FILE_CHANGE_TOOLS } from '../../core/tool-profile.ts';
import { STILL_RUNNING } from '../../providers/acp/workspace-bridge.ts';

/*
 * Prod, Nov 2026: sent back to check its change, a Devin reply that had already passed its tests, type check and lint ran a
 * production build and compiled Tailwind by hand to confirm one class; across 53 such rounds Devin and Antigravity changed
 * a file in 7. The send-backs now name the checks that passed since the last file change, so the agent can leave them be.
 */

/** Commands that read as a check (tests, types, lint, a build), not a look around such as git status or ls. */
const CHECK = /\b(?:test|tests|vitest|jest|mocha|pytest|unittest|tsc|typecheck|check|lint|eslint|biome|ruff|mypy|clippy|build|cargo|go\s+(?:test|vet|build)|gradle|mvn|playwright)\b/i;
/** As many as a line of the send-back can name. */
const MAX_SHOWN = 8;
const MAX_COMMAND = 160;

/** The ACP workspace bridge's step scripts (`workspace-bridge.ts`) open with a line naming the agent's own command. */
const STEP_LABEL = /^# (?:waiting for: |output so far: )?(.+)$/;

type Passed = { command: string; at: number };
type Task = { passed: Passed[]; changedAt: number };

const tasks = new Map<string, Task>();

const taskOf = (id: string): Task => {
	let task = tasks.get(id);
	if (!task) tasks.set(id, (task = { passed: [], changedAt: 0 }));
	return task;
};

/** At a reply's start: what passed in an earlier reply may not hold for this one's change. */
export function startPassedChecks(id: string): void {
	tasks.delete(id);
}

/** The command a bash step ran, as the agent wrote it. */
export function commandOf(command: string): string {
	const first = command.split('\n', 1)[0] ?? '';
	const label = STEP_LABEL.exec(first)?.[1];
	return (label ?? command).replace(/^export NO_COLOR=1 FORCE_COLOR=0; /, '').trim();
}

type Result = { content?: Array<{ type: string; text?: string }>; details?: unknown };

/** Each tool's result as it comes back. A file change marks what passed before it as no longer shown. */
export function noteToolResult(id: string, tool: string, params: unknown, result: Result, now = Date.now()): void {
	if (FILE_CHANGE_TOOLS.has(tool)) {
		taskOf(id).changedAt = now;
		return;
	}
	if (tool !== 'bash') return;
	const exitCode = (result.details as { exitCode?: unknown } | undefined)?.exitCode;
	const text = (result.content ?? []).map((part) => part.text ?? '').join('');
	if (exitCode !== 0 || text.includes(STILL_RUNNING)) return;
	const command = commandOf(String((params as { command?: unknown } | undefined)?.command ?? ''));
	if (command && CHECK.test(command)) taskOf(id).passed.push({ command, at: now });
}

/** Background jobs that ended with exit 0, started after the last file change, add to these. */
export function passedChecks(id: string, jobs: readonly Passed[] = []): string[] {
	const task = tasks.get(id);
	const since = task?.changedAt ?? 0;
	const all = [...(task?.passed ?? []), ...jobs.filter((job) => CHECK.test(job.command))].filter((entry) => entry.at > since).sort((a, b) => a.at - b.at);
	const shown = [...new Set(all.map((entry) => (entry.command.length > MAX_COMMAND ? `${entry.command.slice(0, MAX_COMMAND - 1)}…` : entry.command)))];
	return shown.slice(-MAX_SHOWN);
}

/** The lines a send-back closes with, so checks that passed are not run again for nothing. */
export function passedNote(passed: readonly string[]): string {
	const rule = 'Run a check again only after you change code it covers, and start no build or new check unless you find a gap to close.';
	if (!passed.length) return rule;
	return `These passed since your last file change, and still stand: ${passed.map((command) => `\`${command}\``).join(', ')}. ${rule}`;
}
