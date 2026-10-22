import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { session } from './render';

const api = vi.hoisted(() => ({
	sessions: vi.fn(async () => ({ sessions: [] as unknown[] })),
	reviews: vi.fn(async () => ({ reviews: [] as unknown[] })),
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
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe('Tasks and Reviews', () => {
	it('lists every task with its cost and tokens, and narrows by search and state', async () => {
		api.sessions.mockResolvedValue({
			sessions: [
				session({ id: 'a', title: 'Fix flaky upload retry', status: 'error', usage: { inputTokens: 1, outputTokens: 1, cost: 1.5 } }),
				session({ id: 'b', title: 'Add a tasks page', repo: 'acme/web', prUrl: 'https://github.com/acme/web/pull/7' }),
			],
		});
		open('/tasks');
		expect(await screen.findByText('Fix flaky upload retry')).toBeTruthy();
		const failed = within(screen.getByText('Fix flaky upload retry').closest('a')!);
		expect(failed.getByText('$1.50')).toBeTruthy();
		expect(failed.getByText('2 tok')).toBeTruthy();
		// A task that has not called a model yet has no usage to show.
		expect(within(screen.getByText('Add a tasks page').closest('a')!).getByText('—')).toBeTruthy();
		expect(screen.getAllByText('Failed')).toHaveLength(3); // the filter, the summary's legend and the task's state

		fireEvent.click(screen.getByRole('button', { name: 'Pull request' }));
		expect(screen.queryByText('Fix flaky upload retry')).toBeNull();
		expect(screen.getByText('Add a tasks page')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Pull request' }));
		fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'flaky' } });
		expect(screen.getByText('Fix flaky upload retry')).toBeTruthy();
		expect(screen.queryByText('Add a tasks page')).toBeNull();
	});

	it('groups pull requests by what each waits on', async () => {
		const item = { repo: 'acme/web', draft: false, comments: 0, createdAt: '2026-10-03T00:00:00Z' };
		api.reviews.mockResolvedValue({
			reviews: [
				{ ...item, sessionId: 'a', title: 'Ready one', url: 'https://github.com/acme/web/pull/7', group: 'ready', checks: { passed: 2, failed: 0, pending: 0 }, comments: 3 },
				{ ...item, sessionId: 'b', title: 'Merged one', url: 'https://github.com/acme/web/pull/5', group: 'merged', checks: { passed: 0, failed: 0, pending: 0 } },
			],
		});
		open('/reviews');
		expect(await screen.findByText('Waiting on you')).toBeTruthy();
		expect(screen.getByText(/acme\/web #7 · .* · 2 passed/)).toBeTruthy();
		expect(screen.getByText('3')).toBeTruthy();
		expect(screen.getAllByText('Merged').length).toBeGreaterThan(0);
		expect(screen.queryByText('Failing checks')).toBeNull();
	});

	it('leaves out what no pull request waits on, and the checks when none is open', async () => {
		const item = { repo: 'acme/web', draft: false, reviewing: null, conflicts: false, comments: 0, createdAt: '2026-10-03T00:00:00Z', checks: { passed: 0, failed: 0, pending: 0 } };
		api.reviews.mockResolvedValue({
			reviews: [
				{ ...item, sessionId: 'a', title: 'First', url: 'https://github.com/acme/web/pull/4', group: 'merged' },
				{ ...item, sessionId: 'b', title: 'Second', url: 'https://github.com/acme/web/pull/3', group: 'merged' },
			],
		});
		open('/reviews');
		const bar = await screen.findByRole('img', { name: 'Pull requests by what each waits on' });
		const legend = bar.nextElementSibling as HTMLElement;
		expect(legend.textContent).toBe('Merged2');
		expect(screen.queryByText('checks passed')).toBeNull();
	});
});
