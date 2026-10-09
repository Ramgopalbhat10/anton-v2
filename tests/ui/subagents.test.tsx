import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentRun } from '@/lib/api';
import { renderWithQueries } from './render';

const { AgentsCard, plainLine } = await import('@/components/subagents');
const { AgentsTab } = await import('@/components/agents-tab');
const { ShowPanel, focusRun } = await import('@/lib/workspace');

const now = Date.now();
const run = (patch: Partial<SubagentRun>): SubagentRun => ({
	id: 'run-1',
	agent: 'browser',
	prompt: 'Open news.ycombinator.com and report the top 3 stories.\nUse the comments pages.',
	description: 'Check top Hacker News stories',
	toolCallId: 'call-1',
	status: 'running',
	startedAt: new Date(now - 25_000).toISOString(),
	durationMs: null,
	model: 'gpt-6-luna',
	tokens: 15_000,
	calls: 3,
	steps: [
		{ id: 's1', tool: 'browser', input: { action: 'open', url: 'https://news.ycombinator.com' }, state: 'done', at: new Date(now - 20_000).toISOString(), durationMs: 1200 },
		{ id: 's2', tool: 'browser', input: { action: 'back' }, state: 'running', at: new Date(now - 5_000).toISOString(), durationMs: null },
	],
	writing: null,
	result: null,
	...patch,
});
const finished = run({
	id: 'run-0',
	agent: 'tester',
	prompt: 'Run the tests',
	description: null,
	toolCallId: 'call-0',
	status: 'failed',
	durationMs: 9000,
	tokens: 2000,
	steps: [{ id: 't1', tool: 'bash', input: { command: 'npm test' }, state: 'failed', at: new Date(now).toISOString(), durationMs: 8000 }],
	result: '**npm test** exited 1',
});

describe('Agents card in the thread', () => {
	it('says who is working, shows each one live, and opens the Agents panel on the run', () => {
		const showPanel = vi.fn();
		renderWithQueries(
			<ShowPanel.Provider value={showPanel}>
				<AgentsCard
					sessionId="s1"
					calls={[
						{ toolCallId: 'call-1', agent: 'browser', prompt: run({}).prompt, description: 'Check top Hacker News stories', running: true, failed: false, output: '' },
						{ toolCallId: 'call-0', agent: 'tester', prompt: 'Run the tests', description: '', running: false, failed: true, output: '' },
					]}
				/>
			</ShowPanel.Provider>,
			[[['subagents', 's1'], { runs: [run({}), finished] }]],
		);
		expect(screen.getByText('1 of 2 agents working')).toBeTruthy();
		expect(screen.getByText('1 failed')).toBeTruthy();
		expect(screen.getByText('Went back')).toBeTruthy();
		// A finished run's answer reads as plain words.
		expect(screen.getByText('npm test exited 1')).toBeTruthy();
		fireEvent.click(screen.getByText('Check top Hacker News stories'));
		expect(showPanel).toHaveBeenCalledWith('Agents');
	});

	it('turns a Markdown line into plain words for a preview', () => {
		expect(plainLine('\n- **Page title:** [Example](https://example.com) `x`')).toBe('Page title: Example x');
		expect(plainLine('## Done')).toBe('Done');
	});
});

describe('Agents panel', () => {
	it('lists runs by whether they work, and opens one into its live transcript', () => {
		focusRun('s2', null);
		renderWithQueries(<AgentsTab sessionId="s2" />, [[['subagents', 's2'], { runs: [run({}), finished] }]]);
		const working = screen.getByRole('region', { name: 'Working' });
		const done = screen.getByRole('region', { name: 'Finished' });
		expect(within(working).getByText('Check top Hacker News stories')).toBeTruthy();
		expect(within(done).getByText('Run the tests')).toBeTruthy();
		expect(within(done).getByText('Failed')).toBeTruthy();

		fireEvent.click(within(working).getByRole('button'));
		expect(screen.getByText('Brief from the agent')).toBeTruthy();
		expect(screen.getByText(/Use the comments pages/)).toBeTruthy();
		const steps = screen.getByRole('region', { name: 'Steps' });
		expect(within(steps).getAllByRole('listitem').map((item) => item.textContent)).toEqual([expect.stringContaining('Opened https://news.ycombinator.com'), expect.stringContaining('Went back')]);
		expect(screen.getByText('15K')).toBeTruthy();
		expect(screen.getByText('gpt-6-luna')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
		expect(screen.getByRole('region', { name: 'Working' })).toBeTruthy();
	});

	it('shows a failed run with why', () => {
		focusRun('s3', 'run-0');
		renderWithQueries(<AgentsTab sessionId="s3" />, [[['subagents', 's3'], { runs: [finished] }]]);
		const why = screen.getByRole('region', { name: 'Why it failed' });
		expect(why.textContent).toContain('npm test exited 1');
	});

	it('says what will show before any subagent runs', () => {
		renderWithQueries(<AgentsTab sessionId="s4" />, [[['subagents', 's4'], { runs: [] }]]);
		expect(screen.getByText('No subagents yet')).toBeTruthy();
	});
});
