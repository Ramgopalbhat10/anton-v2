import { QueryClientProvider } from '@tanstack/react-query';
import type { FlueConversationMessage, UseFlueAgentResult } from '@flue/react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({
	editSession: vi.fn(),
	session: vi.fn(),
	health: vi.fn(),
	budget: vi.fn(),
	models: vi.fn(),
	stopAgent: vi.fn(),
	commands: vi.fn(async () => ({ commands: [] })),
	sessionSkills: vi.fn(async () => ({ skills: [] })),
	subagents: vi.fn(async (): Promise<{ runs: unknown[] }> => ({ runs: [] })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { Thread } = await import('@/components/thread');
const { setPendingPrompt } = await import('@/lib/pending-prompt');

const user = (id: string, text: string) => ({ id, role: 'user', purpose: 'user', display: 'visible', parts: [{ type: 'text', text }] });
const assistant = (id: string, parts: unknown[]) => ({ id, role: 'assistant', purpose: 'assistant', display: 'visible', parts });
const tool = (toolName: string, input: unknown, output?: unknown) => ({
	type: 'dynamic-tool',
	toolName,
	toolCallId: `${toolName}-1`,
	input,
	state: output === undefined ? 'input-available' : 'output-available',
	output,
});

function agent(messages: unknown[], patch: Partial<UseFlueAgentResult> = {}): UseFlueAgentResult {
	return {
		messages: messages as FlueConversationMessage[],
		status: 'idle',
		historyReady: true,
		sendMessage: vi.fn(async () => undefined),
		...patch,
	} as unknown as UseFlueAgentResult;
}

function show(flue: UseFlueAgentResult, patch = {}) {
	return renderWithQueries(<Thread sessionId="s1" agent={flue} />, [
		[['session', 's1'], session(patch)],
		[['health'], { ok: true, openRouter: true }],
		[['budget', 's1'], { limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null }],
		[['models'], { models: [], default: '' }],
	]);
}

describe('Thread', () => {
	beforeEach(() => vi.clearAllMocks());

	it('renders replies as markdown and steps as one card, with a link to the pull request', () => {
		show(
			agent([
				user('u1', 'Open a PR'),
				assistant('a1', [
					tool('bash', { command: 'npm test' }, { output: 'ok' }),
					tool('open_pull_request', { title: 'Fix' }, { output: { url: 'https://github.com/acme/demo/pull/7' } }),
					{ type: 'text', text: '## Done\n\n- one\n- two' },
				]),
			]),
		);
		expect(screen.getByRole('heading', { name: 'Done' })).toBeTruthy();
		expect(screen.getAllByRole('listitem')).toHaveLength(2);
		expect(screen.getByText('2 STEPS')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: /Worked/ }));
		expect(screen.getByRole('link', { name: 'acme/demo/pull/7' }).getAttribute('href')).toBe('https://github.com/acme/demo/pull/7');
	});

	it('shows work handed to subagents as an agents card, not as steps, matched to their runs', async () => {
		api.subagents.mockResolvedValue({
			runs: [
				{
					id: 'run-1', agent: 'browser', prompt: 'Count the posts', description: null, toolCallId: 'task-1', status: 'running', startedAt: new Date().toISOString(),
					durationMs: null, model: 'gpt-6-luna', tokens: 6300, calls: 2,
					steps: [{ id: 's1', tool: 'browser', input: { action: 'click', target: 'text=Blog' }, state: 'running', at: new Date().toISOString(), durationMs: null }],
					writing: null, result: null,
				},
			],
		});
		show(agent([user('u1', 'Count the posts'), assistant('a1', [tool('task', { agent: 'browser', prompt: 'Count the posts', description: 'Count blog posts' }), tool('read', { path: 'README.md' }, { output: 'x' })])]));
		expect(await screen.findByText('1 agent on this reply')).toBeTruthy();
		expect(screen.getByText('Count blog posts')).toBeTruthy();
		expect(screen.queryByText(/Delegated to/)).toBeNull();
		// The latest step, as the thread would describe it, and the run's numbers.
		expect(await screen.findByText(/Clicked/)).toBeTruthy();
		expect(screen.getByText(/1 step · \d+s · 6\.3K tok/)).toBeTruthy();
		// Other tools stay in the steps card.
		expect(screen.getByText('1 STEP')).toBeTruthy();
	});

	it('shows a proposed plan, and approving turns plan mode off before telling the agent to build', async () => {
		const flue = agent([user('u1', 'Plan it'), assistant('a1', [tool('propose_plan', { plan: '1. Change **app.ts**' }, { output: 'shown' })])]);
		const order: string[] = [];
		api.editSession.mockImplementation(async (_id: string, change: object) => {
			order.push('plan mode off');
			return session(change);
		});
		vi.mocked(flue.sendMessage).mockImplementation(async (text: string) => void order.push(text));
		show(flue, { planMode: true });
		expect(screen.getByText('app.ts').tagName).toBe('STRONG');
		fireEvent.click(screen.getByRole('button', { name: 'Approve and build' }));
		await waitFor(() => expect(order).toEqual(['plan mode off', 'Your plan is approved. Go ahead and build it.']));
		expect(api.editSession).toHaveBeenCalledWith('s1', { planMode: false });
	});

	it('offers no approval outside plan mode or while the agent works', () => {
		const messages = [user('u1', 'Plan it'), assistant('a1', [{ type: 'text', text: 'A plan' }])];
		show(agent(messages));
		expect(screen.queryByRole('button', { name: 'Approve and build' })).toBeNull();
		show(agent(messages, { status: 'streaming' }), { planMode: true });
		expect(screen.queryByRole('button', { name: 'Approve and build' })).toBeNull();
	});

	it('says when a turn was stopped', () => {
		show(agent([user('u1', 'Go'), { id: 'x', role: 'assistant', purpose: 'assistant', display: 'visible', parts: [], settlement: { outcome: 'aborted' } }]));
		expect(screen.getByText('The agent turn was stopped. Send the message again to retry.')).toBeTruthy();
	});

	it('sends the prompt typed on the launcher once the history has loaded', async () => {
		setPendingPrompt('s1', 'Start here');
		const flue = agent([]);
		show(flue);
		await waitFor(() => expect(flue.sendMessage).toHaveBeenCalledWith('Start here'));
	});
});

describe('response details', () => {
	it('shows the recorded response duration rather than the sum of fast tools, including after reload', () => {
		const reply = {
			...assistant('a1', [
				{ type: 'reasoning', text: 'Thinking through the task', state: 'done' },
				{ ...tool('run_script', { code: 'text(42)' }, { output: '42' }), durationMs: 1400 },
			]),
			metadata: { startedAt: 1000, durationMs: 73_500 },
		};
		const view = show(agent([reply]));
		expect(screen.getByRole('button', { name: /Worked for 1m 13s/ })).toBeTruthy();
		view.unmount();
		show(agent([reply]));
		expect(screen.getByRole('button', { name: /Worked for 1m 13s/ })).toBeTruthy();
	});
	it('times reasoning-only responses and shows total response time once across split traces', () => {
		show(
			agent([
				{
					...assistant('a1', [
						{ type: 'reasoning', text: 'First thought', state: 'done' },
						{ type: 'text', text: 'Checking one more thing' },
						{ type: 'reasoning', text: 'Second thought', state: 'done' },
					]),
					metadata: { durationMs: 14_000 },
				},
			]),
		);
		expect(screen.getAllByRole('button', { name: /Worked for 14s/ })).toHaveLength(1);
		expect(screen.getByRole('button', { name: /^Worked 1 STEP$/ })).toBeTruthy();
	});
	it('does not claim full response timing for legacy messages that only have tool durations', () => {
		show(agent([assistant('a1', [{ ...tool('run_script', { code: 'text(42)' }, { output: '42' }), durationMs: 1400 }])]));
		expect(screen.getByRole('button', { name: /^Worked 1 STEP$/ })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Worked for/ })).toBeNull();
	});
	it('collapses script output when completed and the whole reasoning when work ends', async () => {
		const parts = [tool('run_script', { code: 'text(42)' })];
		const view = show(agent([assistant('a1', parts)], { status: 'streaming' }));
		expect(screen.getByRole('button', { name: /Working/ }).getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByRole('button', { name: /Ran a script/ }).getAttribute('aria-expanded')).toBe('true');
		view.rerender(
			<QueryClientProvider client={view.client}>
				<Thread sessionId="s1" agent={agent([assistant('a1', [tool('run_script', { code: 'text(42)' }, { output: '42' })])], { status: 'streaming' })} />
			</QueryClientProvider>,
		);
		await waitFor(() => expect(screen.getByRole('button', { name: /Ran a script/ }).getAttribute('aria-expanded')).toBe('false'));
		fireEvent.click(screen.getByRole('button', { name: /Ran a script/ }));
		expect(screen.getByText(/text\(42\)/)).toBeTruthy();
		view.rerender(
			<QueryClientProvider client={view.client}>
				<Thread sessionId="s1" agent={agent([assistant('a1', [tool('run_script', { code: 'text(42)' }, { output: '42' })])])} />
			</QueryClientProvider>,
		);
		await waitFor(() => expect(screen.getByRole('button', { name: /Worked/ }).getAttribute('aria-expanded')).toBe('false'));
	});
	it('opens and closes completed command output through its trace row', () => {
		show(agent([assistant('a1', [tool('bash', { command: 'npm test' }, { output: 'All tests passed' })])]));
		fireEvent.click(screen.getByRole('button', { name: /Worked/ }));
		const command = screen.getByRole('button', { name: 'Ran npm test' });
		expect(command.getAttribute('aria-expanded')).toBe('false');
		const details = document.getElementById(command.getAttribute('aria-controls')!);
		expect(details?.getAttribute('aria-hidden')).toBe('true');
		fireEvent.click(command);
		expect(command.getAttribute('aria-expanded')).toBe('true');
		expect(details?.textContent).toContain('All tests passed');
		fireEvent.click(command);
		expect(details?.getAttribute('aria-hidden')).toBe('true');
	});
	it('counts a reply with its subagents, says a plan paid, and breaks the count down on hover', () => {
		show(
			agent([
				{
					...assistant('a1', [{ type: 'text', text: 'There are 4 posts.' }]),
					metadata: {
						usage: { inputTokens: 16_419, outputTokens: 276, cost: 0, cachedTokens: 6_000 },
						usageParts: {
							main: { inputTokens: 8_510, outputTokens: 92, cost: 0, cachedTokens: 6_000, calls: 2 },
							subagents: { inputTokens: 7_909, outputTokens: 184, cost: 0, cachedTokens: 0, calls: 4 },
						},
						billing: 'plan',
					},
				},
				{ ...assistant('a2', [{ type: 'text', text: 'Older reply.' }]), metadata: { usage: { inputTokens: 20, outputTokens: 10, cost: 0.01 } } },
			]),
		);
		const line = screen.getByText('17K tokens · plan');
		expect(line.getAttribute('title')).toBe(
			[
				'16,695 tokens used by this reply: 16,419 in, 276 out.',
				"6,000 of the input came from the provider's cache, which costs less.",
				'The agent: 8.6K over 2 calls.',
				'Its subagents: 8.1K over 4 calls.',
				'Run on your plan: no charge per token.',
			].join('\n'),
		);
		// A reply from before the breakdown keeps its plain count and spend.
		expect(screen.getByText('30 tokens · $0.010').getAttribute('title')).toContain('Charged: $0.010.');
	});

	it('copies only the response text, including markdown, before its token count', async () => {
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		show(
			agent([
				{
					...assistant('a1', [{ type: 'text', text: '**Done**' }, tool('bash', { command: 'secret' }, { output: 'private' })]),
					metadata: { usage: { inputTokens: 20, outputTokens: 10, cost: 0.01 } },
				},
			]),
		);
		fireEvent.click(screen.getByRole('button', { name: 'Copy response' }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith('**Done**'));
		expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
	});
});
