import { QueryClientProvider } from '@tanstack/react-query';
import type { FlueConversationMessage, UseFlueAgentResult } from '@flue/react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({
	editSession: vi.fn(),
	session: vi.fn(),
	health: vi.fn(),
	budget: vi.fn(),
	models: vi.fn(),
	stopAgent: vi.fn(),
	stopSubagent: vi.fn(async () => undefined),
	commands: vi.fn(async () => ({ commands: [] })),
	sessionSkills: vi.fn(async () => ({ skills: [] })),
	subagents: vi.fn(async (): Promise<{ runs: unknown[] }> => ({ runs: [] })),
	scripts: vi.fn(async (): Promise<{ scripts: Record<string, unknown[]> }> => ({ scripts: {} })),
	now: vi.fn(async (): Promise<{ now: unknown }> => ({ now: null })),
	joins: vi.fn(async (): Promise<{ joins: unknown[] }> => ({ joins: [] })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
// The thread is shown without a router here; a page's link to Artifacts is a plain link to where it goes.
vi.mock('@tanstack/react-router', async (original) => ({
	...(await original<typeof import('@tanstack/react-router')>()),
	// The file viewer closes when the page changes; here there is one page.
	useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) => select({ location: { pathname: '/agents/s1' } }),
	Link: ({ to, params, search, ...rest }: { to: string; params?: Record<string, string>; search?: Record<string, string> } & Record<string, unknown>) => {
		const href = `${Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}${search ? `?${new URLSearchParams(search)}` : ''}`;
		return <a href={href} {...rest} />;
	},
}));

const { Thread } = await import('@/components/thread');
const { OutputViewerHost } = await import('@/components/output-viewer');
const { closeViewer } = await import('@/lib/viewer');
const { setPendingPrompt } = await import('@/lib/pending-prompt');
const { taskStatus } = await import('@/lib/working');

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
		settlements: [],
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
		expect(await screen.findByRole('region', { name: '1 agent on this reply' })).toBeTruthy();
		expect(screen.getByText('Count blog posts')).toBeTruthy();
		expect(screen.queryByText(/Delegated to/)).toBeNull();
		// The latest step, as the thread would describe it, and the run's steps.
		expect(await screen.findByText(/Clicked/)).toBeTruthy();
		expect(screen.getByText('1 step')).toBeTruthy();
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
		const messages = [user('u1', 'Plan it'), assistant('a1', [tool('propose_plan', { plan: '1. Change app.ts' }, { output: 'shown' })])];
		show(agent(messages));
		expect(screen.queryByRole('button', { name: 'Approve and build' })).toBeNull();
		show(agent(messages, { status: 'streaming' }), { planMode: true });
		expect(screen.queryByRole('button', { name: 'Approve and build' })).toBeNull();
	});

	it('offers no approval in plan mode until the last reply proposes a plan', () => {
		// Plan mode turned on in a task that has already answered: there is no plan yet.
		show(agent([user('u1', 'Fix the bug'), assistant('a1', [{ type: 'text', text: 'Fixed it.' }])]), { planMode: true });
		expect(screen.queryByRole('button', { name: 'Approve and build' })).toBeNull();
		// A reply that asks something before planning has nothing to approve either.
		show(
			agent([
				user('u1', 'Plan it'),
				assistant('a1', [tool('propose_plan', { plan: '1. Change app.ts' }, { output: 'shown' })]),
				user('u2', 'Use a queue instead'),
				assistant('a2', [{ type: 'text', text: 'Which queue should it use?' }]),
			]),
			{ planMode: true },
		);
		expect(screen.queryByRole('button', { name: 'Approve and build' })).toBeNull();
	});

	it('marks a plan approved once you approved it', () => {
		show(
			agent([
				user('u1', 'Plan it'),
				assistant('a1', [tool('propose_plan', { plan: '1. Change app.ts' }, { output: 'shown' })]),
				user('u2', 'Your plan is approved. Go ahead and build it.'),
				assistant('a2', [{ type: 'text', text: 'Built it.' }]),
			]),
		);
		expect(screen.getByText('Approved')).toBeTruthy();
	});

	it('says once, quietly, that a turn was stopped, however many messages the stop settled', () => {
		const stopped = (id: string) => ({ id, role: 'system', purpose: 'advisory', display: 'visible', parts: [{ type: 'text', text: 'Submission was aborted.' }], settlement: { outcome: 'aborted' } });
		show(agent([user('u1', 'Go'), stopped('x'), stopped('y')]));
		expect(screen.getAllByText('Stopped')).toHaveLength(1);
		expect(screen.queryByText('Submission was aborted.')).toBeNull();
	});

	it('says a message waits for a running subagent, and stops it to have the message read now', async () => {
		api.subagents.mockResolvedValue({
			runs: [{ id: 'run-1', agent: 'browser', prompt: 'Check the page', description: null, toolCallId: 'task-1', status: 'running', startedAt: new Date().toISOString(), durationMs: null, model: null, tokens: 0, calls: 0, steps: [], writing: null, result: null }],
		});
		show(agent([user('u1', 'Check it'), assistant('a1', [tool('task', { agent: 'browser', prompt: 'Check the page' })]), user('u2', 'Why so long?')], { status: 'streaming' }));
		expect(await screen.findByText('Anton reads your message when the browser agent finishes. Stop it to have it read now.')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Stop browser agent' }));
		await waitFor(() => expect(api.stopSubagent).toHaveBeenCalledWith('s1', 'run-1'));
		// The agents card stops it too.
		expect(screen.getByRole('button', { name: 'Stop the browser agent' })).toBeTruthy();
	});

	it('says in the header of the live steps card what the agent is doing, and for how long, with no line below', async () => {
		const since = new Date(Date.now() - 42_000).toISOString();
		api.now.mockResolvedValue({ now: { what: 'writing', tool: 'write', detail: 'outputs/nourish/app.js', chars: 6200, since } });
		show(agent([user('u1', 'Build it'), assistant('a1', [tool('write', { path: 'outputs/nourish/styles.css' }, { output: 'ok' })])], { status: 'streaming' }));
		expect(await screen.findByText('Writing app.js · 6.1 KB')).toBeTruthy();
		expect(screen.getAllByText('Writing app.js · 6.1 KB')).toHaveLength(1);
		expect(screen.getByText('42s')).toBeTruthy();
		// The status is the header of the card, so it shows with the card closed too.
		const header = screen.getByRole('button', { name: /Writing app\.js/ });
		expect(header.getAttribute('aria-expanded')).toBe('true');
		// One mark: the spinner, with the chevron kept for the pointer.
		expect(within(header).getByRole('status')).toBeTruthy();
		expect(header.querySelector('svg.lucide-chevron-down')?.getAttribute('class')).toContain('hidden');
		fireEvent.click(header);
		expect(screen.getByRole('button', { name: /Writing app\.js/ }).getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByRole('button', { name: /Worked/ })).toBeNull();
	});

	it('says Worked once the answer starts streaming, with no line below it while the answer streams', async () => {
		api.now.mockResolvedValue({ now: { what: 'replying', since: new Date().toISOString() } });
		show(agent([user('u1', 'Build it'), assistant('a1', [tool('bash', { command: 'ls' }, { output: 'x' }), { type: 'text', text: 'Here is what I found.' }])], { status: 'streaming' }));
		await waitFor(() => expect(api.now).toHaveBeenCalled());
		expect(screen.getByRole('button', { name: /Worked/ })).toBeTruthy();
		expect(screen.queryByText('Writing the reply')).toBeNull();
	});

	it('keeps the line at the foot when the agent works on after its text with no card to say so', async () => {
		api.now.mockResolvedValue({ now: { what: 'writing', tool: 'bash', since: new Date().toISOString() } });
		show(agent([user('u1', 'Build it'), assistant('a1', [tool('bash', { command: 'ls' }, { output: 'x' }), { type: 'text', text: 'Now the tests.' }])], { status: 'streaming' }));
		expect(await screen.findByText('Writing a command')).toBeTruthy();
	});

	it('says the agent is starting before its reply begins, and keeps a finished reply finished', async () => {
		api.now.mockResolvedValue({ now: null });
		const done = { ...assistant('a1', [tool('bash', { command: 'ls' }, { output: 'x' })]), metadata: { usage: { inputTokens: 1, outputTokens: 1, cost: 0 } } };
		show(agent([user('u1', 'Go'), done, user('u2', 'Now the tests')], { status: 'streaming' }));
		expect(await screen.findByText('Starting the agent')).toBeTruthy();
		expect(screen.queryByText('Live')).toBeNull();
		const worked = screen.getByRole('button', { name: /Worked/ });
		// Done, only the chevron.
		expect(within(worked).queryByRole('status')).toBeNull();
		expect(worked.querySelector('svg.lucide-chevron-down')?.getAttribute('class')).not.toContain('hidden');
	});

	it('counts a task working on the server as busy, though this page sent nothing', () => {
		expect(taskStatus('idle', true)).toBe('streaming');
		expect(taskStatus('connecting', true)).toBe('streaming');
		expect(taskStatus('idle', false)).toBe('idle');
		expect(taskStatus('error', true)).toBe('error');
	});

	it('says a message sent mid-reply joins that reply, rather than reading as unanswered', () => {
		const sent = (id: string, text: string, submissionId: string) => ({ ...user(id, text), submissionId });
		const done = { ...assistant('a1', [{ type: 'text', text: "I'm still working on it." }]), metadata: { usage: { inputTokens: 1, outputTokens: 1, cost: 0 } } };
		const view = show(
			agent([sent('u1', 'Build it', 'sub-1'), done, sent('u2', 'Why did you stop?', 'sub-2')], {
				settlements: [
					{ submissionId: 'sub-1', outcome: 'completed' },
					{ submissionId: 'sub-2', outcome: 'completed', answeredBySubmissionId: 'sub-1' },
				],
			} as Partial<UseFlueAgentResult>),
		);
		expect(screen.getByText('Read while Anton worked on the reply above')).toBeTruthy();
		view.unmount();
		// While the reply is still being written, it says when it will be read.
		show(agent([sent('u1', 'Build it', 'sub-1'), assistant('a1', [tool('bash', { command: 'ls' })]), sent('u2', 'Why did you stop?', 'sub-2')], { status: 'streaming' }));
		expect(screen.getByText('Anton reads this between its steps')).toBeTruthy();
	});

	it('puts a message read mid-reply where Anton read it: the steps before it, the message, then the answer', async () => {
		const sent = (id: string, text: string, submissionId: string) => ({ ...user(id, text), submissionId });
		const reply = {
			...assistant('a1', [
				{ ...tool('task', { agent: 'browser', prompt: 'Check the engine', description: 'Inspect the engine' }), toolCallId: 'task-1', state: 'output-available', output: 'stopped' },
				{ type: 'text', text: 'The review is stopped; packaging the engine now.' },
			]),
			submissionId: 'sub-1',
			metadata: { usage: { inputTokens: 1, outputTokens: 1, cost: 0 } },
		};
		api.joins.mockResolvedValue({ joins: [{ text: 'Why is it taking so long?', afterTool: 'task-1', final: false, at: new Date().toISOString() }] });
		show(
			agent([sent('u1', 'Build it', 'sub-1'), reply, sent('u2', 'Why is it taking so long?', 'sub-2')], {
				settlements: [
					{ submissionId: 'sub-1', outcome: 'completed' },
					{ submissionId: 'sub-2', outcome: 'completed', answeredBySubmissionId: 'sub-1' },
				],
			} as Partial<UseFlueAgentResult>),
		);
		const note = await screen.findByText('Sent while Anton worked, read here');
		const question = screen.getByText('Why is it taking so long?');
		const answer = screen.getByText('The review is stopped; packaging the engine now.');
		expect(question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(note).toBeTruthy();
		expect(screen.queryByText('Read while Anton worked on the reply above')).toBeNull();
		api.joins.mockResolvedValue({ joins: [] });
	});

	it('draws a connector call as the tool it ran', () => {
		show(
			agent([
				assistant('a1', [
					tool('connector_tools', { query: 'mail' }, 'Gmail: on'),
					tool('connector_call', { tool: 'gmail_search', arguments: { query: 'invoice' } }, 'thread_id t1'),
				]),
			]),
		);
		fireEvent.click(screen.getByRole('button', { name: /Worked/ }));
		expect(screen.getByText('Looked up connector tools for')).toBeTruthy();
		expect(screen.getByText('Searched Gmail for')).toBeTruthy();
		expect(screen.getByText('invoice')).toBeTruthy();
		expect(screen.queryByText(/connector_call/)).toBeNull();
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
	it('lists the calls a running script makes, and how many it made', async () => {
		api.scripts.mockResolvedValue({
			scripts: {
				'run_script-1': [
					{ tool: 'mcp__linear__search_issues', input: '{"query":"crash"}', state: 'done', durationMs: 240 },
					{ tool: 'decide', input: '[{"issue":7}]', state: 'running', durationMs: null },
				],
			},
		});
		show(agent([assistant('a1', [tool('run_script', { code: 'await tools.mcp__linear__search_issues({ query: "crash" })' })])], { status: 'streaming' }));
		expect(await screen.findByText('linear · search_issues')).toBeTruthy();
		expect(screen.getByText('{"query":"crash"}')).toBeTruthy();
		expect(screen.getByText('240ms')).toBeTruthy();
		expect(screen.getByText('decide')).toBeTruthy();
		expect(screen.getByRole('button', { name: /Ran a script 2 calls/ })).toBeTruthy();
		expect(api.scripts).toHaveBeenCalledWith('s1');
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

	it('shows a question from the ask tool as options to tap, and once answered only the question and the pick', () => {
		const ask = tool('ask', { question: 'Which database?', options: [{ label: 'Postgres', detail: 'Managed, on Neon' }, { label: 'SQLite' }], recommended: 0 }, 'Stop here.');
		const flue = agent([user('u1', 'Set up storage'), assistant('a1', [ask])]);
		const { unmount } = show(flue);
		expect(screen.getByRole('heading', { name: 'Which database?' })).toBeTruthy();
		expect(screen.getByText('Recommended')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: /SQLite/ }));
		expect(flue.sendMessage).toHaveBeenCalledWith('SQLite');
		unmount();

		const { unmount: done } = show(agent([user('u1', 'Set up storage'), assistant('a1', [ask]), user('u2', 'Postgres'), assistant('a2', [{ type: 'text', text: 'On it.' }])]));
		const answered = screen.getByRole('region', { name: 'Answered question' });
		expect(within(answered).getByRole('heading', { name: 'Which database?' })).toBeTruthy();
		expect(within(answered).getByText('Postgres')).toBeTruthy();
		expect(within(answered).getByText('You chose')).toBeTruthy();
		expect(within(answered).queryByText('SQLite')).toBeNull();
		expect(screen.queryByRole('button', { name: /SQLite/ })).toBeNull();
		done();

		show(agent([user('u1', 'Set up storage'), assistant('a1', [ask]), user('u2', 'Use MySQL instead'), assistant('a2', [{ type: 'text', text: 'On it.' }])]));
		expect(within(screen.getByRole('region', { name: 'Answered question' })).getByText('You answered')).toBeTruthy();
	});

	it('draws a show card: stats, a sortable table, a live formula, and a form that sends its values', () => {
		const card = tool(
			'show',
			{
				title: 'Plan the seats',
				children: [
					{ type: 'stat', label: 'Monthly', value: 1200, format: 'currency', change: '+4%' },
					{ type: 'table', columns: [{ key: 'name' }, { key: 'seats' }], rows: [{ name: 'Ada', seats: 3 }, { name: 'Bo', seats: 9 }, { name: 'Cy', seats: 1 }] },
					{ type: 'number', name: 'seats', label: 'Seats', value: 2, slider: true, min: 1, max: 10 },
					{ type: 'value', label: 'Total', formula: 'seats * 10', format: 'currency' },
					{ type: 'form', title: 'Order', submit: 'Order seats', children: [{ type: 'select', name: 'plan', label: 'Plan', options: [{ label: 'Team', value: 'team' }, { label: 'Business', value: 'biz' }] }] },
				],
			},
			'The user sees this card.',
		);
		const flue = agent([user('u1', 'Seats?'), assistant('a1', [card])]);
		show(flue);
		expect(screen.getByRole('heading', { name: 'Plan the seats' })).toBeTruthy();
		expect(screen.getByText('$1,200.00')).toBeTruthy();
		expect(screen.getByText('$20.00')).toBeTruthy();
		fireEvent.change(screen.getByRole('slider'), { target: { value: '7' } });
		expect(screen.getByText('$70.00')).toBeTruthy();

		const names = () => screen.getAllByRole('row').slice(1).map((row) => row.textContent);
		const sortBySeats = () => fireEvent.click(within(screen.getAllByRole('columnheader')[1]).getByRole('button'));
		sortBySeats();
		expect(names()).toEqual(['Cy1', 'Ada3', 'Bo9']);
		sortBySeats();
		expect(names()).toEqual(['Bo9', 'Ada3', 'Cy1']);

		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'biz' } });
		fireEvent.click(screen.getByRole('button', { name: 'Order seats' }));
		expect(flue.sendMessage).toHaveBeenCalledWith('Submitted "Order":\n- Plan: Business');
	});

	it('keeps a failed card as a step with its error, and shows a page from render_html in its frame', () => {
		const failed = { ...tool('show', { children: [{ type: 'stat' }] }), state: 'output-error', errorText: 'The card is not valid' };
		const page = tool('render_html', { title: 'Explainer', html: '<div>x</div>' }, { output: { path: 'renders/explainer-abc123.html', title: 'Explainer', height: 300 } });
		show(agent([user('u1', 'Explain'), assistant('a1', [failed, page])]));
		expect(screen.getByText('1 STEP')).toBeTruthy();
		const frame = screen.getByTitle('Explainer') as HTMLIFrameElement;
		expect(frame.getAttribute('src')).toBe('/api/sessions/s1/render-frame?path=renders%2Fexplainer-abc123.html');
		expect(frame.style.height).toBe('300px');
		// It opens full size in Artifacts, or in a tab of its own.
		expect(screen.getByRole('link', { name: 'Open Explainer in Artifacts' }).getAttribute('href')).toBe('/artifacts/s1?path=renders%2Fexplainer-abc123.html');
		expect(screen.getByRole('link', { name: 'Open Explainer in a new tab' }).getAttribute('href')).toBe('/api/sessions/s1/render-frame?path=renders%2Fexplainer-abc123.html');
	});

	it('draws an image the agent made where it made it, in its shape while it draws, and not again among the files', async () => {
		closeViewer();
		const drawing = tool('generate_image', { prompt: 'A lighthouse at dusk', aspect_ratio: '16:9' });
		const { unmount } = show(agent([user('u1', 'Draw a lighthouse'), assistant('a1', [drawing])], { status: 'streaming' }));
		const frame = screen.getAllByRole('status').find((status) => status.textContent === 'Making an image')!;
		expect(frame.style.aspectRatio).toBe('16 / 9');
		unmount();

		const made = tool('generate_image', { prompt: 'A lighthouse at dusk', aspect_ratio: '16:9' }, { output: { path: 'images/lighthouse-abc123.png', model: 'OpenAI: GPT Image 2.5 Flare', note: '' } });
		const text = 'Here it is: [lighthouse](../outputs/images/lighthouse-abc123.png)';
		renderWithQueries(
			<>
				<Thread sessionId="s1" agent={agent([user('u1', 'Draw a lighthouse'), assistant('a1', [made, { type: 'text', text }])])} />
				<OutputViewerHost />
			</>,
			[
				[['session', 's1'], session()],
				[['health'], { ok: true, openRouter: true }],
				[['budget', 's1'], { limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null }],
				[['models'], { models: [], default: '' }],
				[['outputs', 's1'], { source: 'saved', at: null, outputs: [{ path: 'images/lighthouse-abc123.png', size: 1, mtimeMs: 1 }] }],
			],
		);
		expect(screen.getByRole('img', { name: 'A lighthouse at dusk' }).getAttribute('src')).toBe('/api/sessions/s1/output?path=images%2Flighthouse-abc123.png');
		expect(screen.getByText('OpenAI: GPT Image 2.5 Flare')).toBeTruthy();
		expect(screen.queryByRole('list', { name: 'Files from this reply' })).toBeNull();
		fireEvent.click(screen.getByRole('img', { name: 'A lighthouse at dusk' }).closest('button')!);
		expect(await screen.findByRole('complementary', { name: 'Viewing lighthouse-abc123.png' })).toBeTruthy();
		fireEvent.keyDown(window, { key: 'Escape' });
	});

	it('shows the files a reply made as cards, and opens a linked one beside the chat, ready to mark up', async () => {
		closeViewer();
		const text = 'Both are in the Library:\n\n- [Editable SVG](../outputs/stream-architecture.svg)\n- [Browser-rendered PNG](../outputs/stream-architecture.png)\n\n![Preview](../outputs/stream-architecture.png)\n\nNotes in [the report](../outputs/reports/notes.md).';
		const shot = tool('screenshot', { url: 'http://localhost:5173' }, { output: { path: '../outputs/screenshots/home-1.png', title: 'Home' } });
		// A check screenshot it deleted before the reply ended is not one of its files.
		const check = tool('screenshot', { url: 'http://localhost:5173' }, { output: { path: '../outputs/check-1.png', title: 'Check' } });
		renderWithQueries(
			<>
				<Thread sessionId="s1" agent={agent([user('u1', 'Draw it'), assistant('a1', [shot, check, { type: 'text', text }])])} />
				<OutputViewerHost />
			</>,
			[
				[['session', 's1'], session()],
				[['health'], { ok: true, openRouter: true }],
				[['budget', 's1'], { limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null }],
				[['models'], { models: [], default: '' }],
				[['outputs', 's1'], { source: 'saved', at: null, outputs: ['screenshots/home-1.png', 'stream-architecture.svg', 'stream-architecture.png', 'reports/notes.md'].map((path) => ({ path, size: 1, mtimeMs: 1 })) }],
			],
		);
		// Its screenshot first, then the files its words link, each once.
		const cards = within(screen.getByRole('list', { name: 'Files from this reply' })).getAllByRole('listitem');
		expect(cards.map((card) => card.getAttribute('title'))).toEqual([
			'Open screenshots/home-1.png',
			'Open stream-architecture.svg',
			'Open stream-architecture.png',
			'Open reports/notes.md',
		]);
		// An image it saved draws in place; links keep the file's own address for a new tab.
		expect(screen.getByRole('img', { name: 'Preview' }).getAttribute('src')).toBe('/api/sessions/s1/output?path=stream-architecture.png');
		const link = screen.getByRole('link', { name: 'Browser-rendered PNG' });
		expect(link.getAttribute('href')).toBe('/api/sessions/s1/output?path=stream-architecture.png');
		fireEvent.click(link);
		const viewer = await screen.findByRole('complementary', { name: 'Viewing stream-architecture.png' });
		expect(within(viewer).getByText('3 of 4')).toBeTruthy();
		expect(within(viewer).getByRole('button', { name: /Mark up/ })).toBeTruthy();
		fireEvent.click(within(viewer).getByRole('button', { name: 'Next file' }));
		expect(await screen.findByRole('complementary', { name: 'Viewing notes.md' })).toBeTruthy();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
	});

	it('says a page, an image or a file you deleted was deleted, instead of drawing it broken', () => {
		closeViewer();
		const page = tool('render_html', { title: 'Explainer', html: '<div>x</div>' }, { output: { path: 'renders/explainer-abc123.html', title: 'Explainer', height: 300 } });
		const made = { ...tool('generate_image', { prompt: 'A lighthouse' }, { output: { path: 'images/lighthouse-abc123.png', model: 'x', note: '' } }), toolCallId: 'image-2' };
		const text = 'See ![Chart](../outputs/chart.png) and [the report](../outputs/reports/notes.md).';
		renderWithQueries(<Thread sessionId="s1" agent={agent([user('u1', 'Make them'), assistant('a1', [page, made, { type: 'text', text }])])} />, [
			[['session', 's1'], session()],
			[['health'], { ok: true, openRouter: true }],
			[['budget', 's1'], { limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null }],
			[['models'], { models: [], default: '' }],
			[
				['outputs', 's1'],
				{ source: 'saved', at: null, outputs: [], deleted: ['renders/explainer-abc123.html', 'images/lighthouse-abc123.png', 'chart.png', 'reports/notes.md'] },
			],
		]);
		expect(screen.queryByTitle('Explainer')).toBeNull();
		expect(screen.getByRole('note', { name: 'Deleted page: explainer-abc123.html' })).toBeTruthy();
		expect(screen.queryByRole('img', { name: 'A lighthouse' })).toBeNull();
		expect(screen.getByRole('note', { name: 'Deleted image: lighthouse-abc123.png' })).toBeTruthy();
		// In the reply's words: no broken picture, and the link struck through rather than opening nothing.
		expect(screen.queryByRole('img', { name: 'Chart' })).toBeNull();
		expect(screen.getByText('Chart').closest('[role="note"]')?.textContent).toContain('This image was deleted');
		expect(screen.queryByRole('link', { name: 'the report' })).toBeNull();
		expect(screen.getByTitle('This file was deleted').textContent).toContain('the report');
		// Its cards stay, saying so, and open nothing.
		const cards = within(screen.getByRole('list', { name: 'Files from this reply' })).getAllByRole('listitem');
		expect(cards.map((card) => card.getAttribute('title'))).toEqual(['chart.png was deleted', 'reports/notes.md was deleted']);
		expect(cards.every((card) => card.tagName === 'DIV')).toBe(true);
	});
});
