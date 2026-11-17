import type { IconComponent } from '@/lib/icons';
import { AppWindow, Bot, FlaskConical, Monitor, Telescope } from '@/lib/icons';
import type { SubagentRun } from '@/lib/api';

type Look = { icon: IconComponent; tone: string; label: string };

const LOOKS: Record<string, Look> = {
	browser: { icon: AppWindow, tone: 'var(--data-3)', label: 'Browser' },
	computer: { icon: Monitor, tone: 'var(--data-3)', label: 'Computer' },
	explorer: { icon: Telescope, tone: 'var(--data-1)', label: 'Explorer' },
	tester: { icon: FlaskConical, tone: 'var(--data-2)', label: 'Tester' },
	'flue-general': { icon: Bot, tone: 'var(--data-5)', label: 'General' },
};

export function lookOf(agent: string): Look {
	return LOOKS[agent] ?? { icon: Bot, tone: 'var(--data-5)', label: agent.replace(/[-_]+/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase()) };
}

/** The work in a few words: the label the agent gave it, or the brief's first line. */
export function titleOf(prompt: string, description?: string): string {
	return (description?.trim() || prompt.trim().split('\n')[0] || 'Working').replace(/^#+\s*/, '');
}

export function plainLine(text: string | null | undefined): string {
	const line = (text ?? '').split('\n').find((entry) => entry.trim()) ?? '';
	return line
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
		.replace(/^#+\s*/, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[*_`]+/g, '')
		.trim();
}

export function runElapsed(run: SubagentRun, now: number): number {
	return run.durationMs ?? Math.max(0, now - Date.parse(run.startedAt));
}

export type WorkKind = 'read' | 'search' | 'run' | 'edit' | 'browse' | 'other';

export const WORK: Record<WorkKind, { label: string; doing: string; tone: string }> = {
	read: { label: 'Read', doing: 'reading', tone: 'var(--text-2)' },
	search: { label: 'Searched', doing: 'searching', tone: 'var(--text-4)' },
	run: { label: 'Ran', doing: 'running commands', tone: 'var(--data-1)' },
	edit: { label: 'Edited', doing: 'editing', tone: 'var(--data-2)' },
	browse: { label: 'Browsed', doing: 'browsing', tone: 'var(--data-3)' },
	other: { label: 'Other', doing: 'other tools', tone: 'var(--data-5)' },
};

export function workKind(tool: string): WorkKind {
	if (tool === 'read' || tool === 'read_file') return 'read';
	if (['grep', 'search_code', 'glob', 'list_files'].includes(tool)) return 'search';
	if (tool === 'bash' || tool === 'run_script') return 'run';
	if (tool === 'edit' || tool === 'write' || tool === 'apply_patch') return 'edit';
	if (tool === 'browser' || tool === 'screenshot' || tool === 'computer') return 'browse';
	return 'other';
}

export type Delegation = { toolCallId: string; agent: string; prompt: string; description: string; running: boolean; failed: boolean; output: string };

/** The run a task call started: by its call id when the runtime gave one, else by who was asked what. */
export function runFor(runs: SubagentRun[], call: Delegation): SubagentRun | undefined {
	return runs.find((run) => run.toolCallId === call.toolCallId) ?? runs.find((run) => run.agent === call.agent && run.prompt === call.prompt);
}

export function runEnd(run: SubagentRun, now: number): number {
	return Date.parse(run.startedAt) + runElapsed(run, now);
}

export function decisionsOf(run: SubagentRun): { decisions: number; cost: number } {
	return run.steps.reduce((sum, step) => ({ decisions: sum.decisions + (step.detail?.decisions ?? 0), cost: sum.cost + (step.detail?.cost ?? 0) }), { decisions: 0, cost: 0 });
}

export function spanOf(runs: SubagentRun[], now: number): { from: number; to: number } {
	if (!runs.length) return { from: now, to: now };
	const from = Math.min(...runs.map((run) => Date.parse(run.startedAt)));
	const to = Math.max(...runs.map((run) => runEnd(run, now)));
	return { from, to: Math.max(to, from + 1000) };
}
