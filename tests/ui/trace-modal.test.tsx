import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ModelSpan, Trace } from '../../src/core/trace';
import { renderWithQueries } from './render';

const { TraceModal } = await import('@/components/trace-modal');
const { traceRows, traceStats, traceTree } = await import('@/lib/trace-view');

const usage = (input: number, cacheRead: number, cacheWrite = 0) => ({ input, output: 50, cacheRead, cacheWrite, cost: 0.002 });
const model = (id: string, lane: string, start: number, patch: Partial<ModelSpan> = {}): ModelSpan => ({
	kind: 'model',
	id,
	lane,
	start,
	durationMs: 800,
	error: null,
	purpose: 'agent',
	model: 'openrouter/anthropic/claude-sonnet-5.5',
	usage: usage(200, 4000),
	parts: { systemPrompt: 1000, skills: 0, tools: 2000, mcpTools: 0, messages: 1200 },
	messages: 3,
	added: [{ role: 'user', text: 'Fix the login bug', chars: 17 }],
	addedMore: 0,
	prompt: 'p1',
	toolset: 't1',
	output: { text: '', thinking: '', toolCalls: [] },
	finish: 'toolUse',
	...patch,
});

const trace: Trace = {
	id: 'trace-1',
	sessionId: 's1',
	startedAt: '2026-10-26T10:00:00.000Z',
	durationMs: 6000,
	model: 'openrouter/anthropic/claude-sonnet-5.5',
	prompts: { p1: 'You are Anton.', p2: 'You are Anton, with a sandbox.' },
	toolsets: { t1: [{ name: 'read', tokens: 120 }] },
	dropped: 0,
	spans: [
		model('m1', 'main', 0, { usage: usage(4200, 0, 4000), output: { text: '', thinking: '', toolCalls: [{ id: 'c1', name: 'read' }, { id: 'c2', name: 'task' }] } }),
		{ kind: 'tool', id: 'c1', lane: 'main', start: 900, durationMs: 40, error: null, tool: 'read', input: '{"path":"src/login.ts"}', output: 'export function login() {}', outputChars: 26 },
		{ kind: 'tool', id: 'c2', lane: 'main', start: 950, durationMs: 3000, error: null, tool: 'task', input: '{"prompt":"Find the tests"}', output: 'tests/login.test.ts', outputChars: 19 },
		{ kind: 'agent', id: 'sub', lane: 'sub', start: 960, durationMs: 2900, error: null, agent: 'explorer', parent: 'main', call: 'c2', description: 'Find the tests', prompt: 'Find the tests', result: 'tests/login.test.ts' },
		model('s1', 'sub', 1000, { usage: usage(900, 0) }),
		{ kind: 'tool', id: 'g1', lane: 'sub', start: 1900, durationMs: 1500, error: 'No such file', tool: 'grep', input: '{"pattern":"login"}', output: 'No such file', outputChars: 12 },
		model('m2', 'main', 4000, { prompt: 'p2', usage: usage(4300, 0) }),
	],
};

describe('a reply’s trace', () => {
	it('puts a subagent’s calls under the call that started it, and adds up the reply', () => {
		const rows = traceRows(traceTree(trace), new Set());
		expect(rows.map((row) => `${'  '.repeat(row.depth)}${row.key}`)).toEqual(['reply', '  model:m1', '  tool:c1', '  agent:sub', '    model:s1', '    tool:g1', '  model:m2']);
		expect(traceRows(traceTree(trace), new Set(['agent:sub'])).map((row) => row.key)).not.toContain('model:s1');
		expect(traceRows(traceTree(trace), new Set(), 'login.ts').map((row) => row.key)).toEqual(['reply', 'tool:c1']);
		const stats = traceStats(trace);
		expect([stats.modelCalls, stats.toolCalls, stats.agents, stats.errors, stats.slowest]).toEqual([3, 3, 1, 1, 'c2']);
	});

	it('shows the timeline, and a model call’s context, cache and what it added when picked', async () => {
		renderWithQueries(<TraceModal sessionId="s1" traceId="trace-1" onClose={() => {}} />, [[['trace', 's1', 'trace-1'], trace]]);
		const dialog = screen.getByRole('dialog', { name: 'Reply trace' });
		expect(within(dialog).getAllByRole('treeitem')).toHaveLength(7);
		// The last call's system prompt changed after the sandbox started, so its cache missed.
		fireEvent.click(within(dialog).getAllByRole('treeitem')[6]);
		const card = screen.getByRole('complementary', { name: 'Step details' });
		expect(within(card).getByText('Miss')).toBeTruthy();
		expect(within(card).getByText(/system prompt changed since the previous call/)).toBeTruthy();
		fireEvent.click(within(dialog).getAllByRole('treeitem')[2]);
		expect(within(screen.getByRole('complementary', { name: 'Step details' })).getByText('export function login() {}')).toBeTruthy();
	});
});
