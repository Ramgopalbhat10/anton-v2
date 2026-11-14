import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { session } from './render';

const api = vi.hoisted(() => ({
	sessions: vi.fn(async (): Promise<{ sessions: unknown[] }> => ({ sessions: [] })),
	reviews: vi.fn(async (): Promise<{ reviews: unknown[] }> => ({ reviews: [] })),
	pulls: vi.fn(async (_id: string): Promise<{ pulls: unknown[] }> => ({ pulls: [] })),
	pull: vi.fn(async (_id: string, _number: number): Promise<unknown> => {
		throw new Error('no pull request');
	}),
	pullDiff: vi.fn(async (_id: string, _number: number): Promise<{ patch: string }> => ({ patch: '' })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { TasksPage } = await import('@/components/tasks-page');
const { ReviewsPage } = await import('@/components/reviews-page');

function open(path: string) {
	const root = createRootRoute({ component: Outlet });
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/tasks', component: TasksPage }),
		createRoute({ getParentRoute: () => root, path: '/reviews', component: ReviewsPage }),
		createRoute({ getParentRoute: () => root, path: '/agents/$sessionId', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe('Tasks and Reviews', () => {
	it('lists tasks in state groups with where each works, its model, cost and age', async () => {
		api.sessions.mockResolvedValue({
			sessions: [
				session({ id: 'a', title: 'Fix flaky upload retry', status: 'error', errorMessage: 'Sandbox ran out of memory', usage: { inputTokens: 1, outputTokens: 1, cost: 1.5 } }),
				session({ id: 'b', title: 'Add a tasks page', repo: 'acme/web', model: 'openrouter/anthropic/claude-sonnet-4.5', prUrl: 'https://github.com/acme/web/pull/7', pullRequest: { state: 'merged', checks: 'passed', runs: [] } }),
				session({ id: 'c', title: 'Chat about the deploy', projectId: null, repo: '', model: '', resolvedAt: '2026-10-04T00:00:00Z' }),
			],
		});
		open('/tasks');
		expect(await screen.findByText('Fix flaky upload retry')).toBeTruthy();
		const failed = within(screen.getByText('Fix flaky upload retry').closest('a')!);
		expect(failed.getByText('$1.50')).toBeTruthy();
		expect(failed.getByRole('img', { name: 'Failed' })).toBeTruthy();
		const merged = within(screen.getByText('Add a tasks page').closest('a')!);
		expect(merged.getByText('web')).toBeTruthy();
		expect(merged.getByText('claude-sonnet-4.5')).toBeTruthy();
		// The pull request's colour says it merged; no word repeats it.
		expect(merged.getByText(/#7/).textContent).toBe('#7');
		const chat = within(screen.getByText('Chat about the deploy').closest('a')!);
		expect(chat.getByText('Chat')).toBeTruthy();

		// The groups say what each state is, with how many are in it: the failed
		// task needs you, the merged pull request's task sits idle, the chat is done.
		const needs = screen.getByRole('region', { name: 'Needs you' });
		expect(within(needs).getByText('Fix flaky upload retry')).toBeTruthy();
		const idle = screen.getByRole('region', { name: 'Idle' });
		expect(within(idle).getByText('Add a tasks page')).toBeTruthy();
		const done = screen.getByRole('region', { name: 'Done' });
		expect(within(done).getByText('Chat about the deploy')).toBeTruthy();

		// The kind tabs count what they would show and narrow the list.
		const tabs = screen.getByRole('tablist', { name: 'Kind of tasks' });
		expect(within(tabs).getByRole('tab', { name: 'Chats 1' })).toBeTruthy();
		fireEvent.click(within(tabs).getByRole('tab', { name: 'Chats 1' }));
		expect(screen.queryByText('Fix flaky upload retry')).toBeNull();
		expect(screen.getByText('Chat about the deploy')).toBeTruthy();
	});

	it('narrows by search and folds a group away', async () => {
		api.sessions.mockResolvedValue({
			sessions: [
				session({ id: 'a', title: 'Fix flaky upload retry', status: 'error' }),
				session({ id: 'b', title: 'Add a tasks page', repo: 'acme/web', prUrl: 'https://github.com/acme/web/pull/7', pullRequest: { state: 'open', checks: 'passed', runs: [] }, resolvedAt: '2026-10-04T00:00:00Z' }),
			],
		});
		open('/tasks');
		expect(await screen.findByText('Fix flaky upload retry')).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'flaky' } });
		expect(screen.getByText('Fix flaky upload retry')).toBeTruthy();
		expect(screen.queryByText('Add a tasks page')).toBeNull();
		expect(screen.getByText('1 of 2')).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: /Needs you/ }));
		expect(screen.queryByText('Fix flaky upload retry')).toBeNull();
		expect(screen.getByText('Add a tasks page')).toBeTruthy();
	});

	it('groups pull requests by what each waits on and opens the selected one beside the list', async () => {
		const item = { repo: 'acme/web', draft: false, comments: 0, createdAt: '2026-10-03T00:00:00Z', reviewing: null };
		const pull = (sessionId: string, number: number, title: string, state: string) => ({
			url: `https://github.com/acme/web/pull/${number}`,
			repo: 'acme/web',
			number,
			title,
			head: 'anton/work',
			base: 'main',
			state,
			openedAt: '2026-10-03T00:00:00Z',
			mergedAt: null,
			current: true,
			sessionId,
		});
		api.reviews.mockResolvedValue({
			reviews: [
				{ ...item, sessionId: 'a', title: 'Ready one', url: 'https://github.com/acme/web/pull/7', group: 'ready', checks: { passed: 2, failed: 0, pending: 0 }, comments: 3 },
				{ ...item, sessionId: 'b', title: 'Merged one', url: 'https://github.com/acme/web/pull/5', group: 'merged', checks: { passed: 0, failed: 0, pending: 0 } },
			],
		});
		api.pulls.mockImplementation(async (id: string) => ({
			pulls: id === 'a' ? [pull('a', 7, 'Ready one', 'open')] : [pull('b', 5, 'Merged one', 'merged')],
		}));
		api.pull.mockImplementation(async (_id: string, number: number) => ({
			url: `https://github.com/acme/web/pull/${number}`,
			number,
			repo: 'acme/web',
			title: number === 7 ? 'Ready one' : 'Merged one',
			body: '',
			author: 'anton',
			state: number === 7 ? 'open' : 'merged',
			draft: false,
			headBranch: 'anton/work',
			headSha: 'abc123',
			baseBranch: 'main',
			createdAt: '2026-10-03T00:00:00Z',
			mergedAt: number === 7 ? null : '2026-10-04T00:00:00Z',
			mergedBy: number === 7 ? null : 'anton',
			closedAt: null,
			additions: 10,
			deletions: 2,
			changedFiles: 3,
			mergeable: true,
			approved: false,
			commits: [],
			checks: [],
			discussion: [],
		}));
		open('/reviews');
		expect(await screen.findByText('Waiting on you')).toBeTruthy();
		const row = await screen.findByRole('button', { name: /Ready one/ });
		expect(within(row).getByText(/2 passed/)).toBeTruthy();
		// The first open pull request is selected, and the panel shows it as the task's PR view.
		expect(await screen.findByText('anton/work')).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Open task' })).toBeTruthy();

		// The merged pull request waits under its own tab, and the panel follows the selection.
		fireEvent.click(screen.getByRole('tab', { name: /Merged/ }));
		expect((await screen.findAllByText('Merged one')).length).toBeGreaterThan(0);
		expect(await screen.findByText(/Merged by anton/)).toBeTruthy();
	});
});
