import type { FlueConversationMessage, UseFlueAgentResult } from '@flue/react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({ editSession: vi.fn(), session: vi.fn(), health: vi.fn(), budget: vi.fn(), models: vi.fn(), stopAgent: vi.fn() }));
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
	return { messages: messages as FlueConversationMessage[], status: 'idle', historyReady: true, sendMessage: vi.fn(async () => undefined), ...patch } as unknown as UseFlueAgentResult;
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
		expect(screen.getByRole('link', { name: 'acme/demo/pull/7' }).getAttribute('href')).toBe('https://github.com/acme/demo/pull/7');
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
