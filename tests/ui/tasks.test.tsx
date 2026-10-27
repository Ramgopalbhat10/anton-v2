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

const { pageNumbers, TasksPage } = await import('@/components/tasks-page');
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
	it('lists every task with where it works, its model and usage, and narrows by search and state', async () => {
		api.sessions.mockResolvedValue({
			sessions: [
				session({ id: 'a', title: 'Fix flaky upload retry', status: 'error', errorMessage: 'Sandbox ran out of memory', usage: { inputTokens: 1, outputTokens: 1, cost: 1.5 } }),
				session({ id: 'b', title: 'Add a tasks page', repo: 'acme/web', model: 'openrouter/anthropic/claude-sonnet-4.5', prUrl: 'https://github.com/acme/web/pull/7', pullRequest: { state: 'merged', checks: 'passed', runs: [] } }),
			],
		});
		open('/tasks');
		expect(await screen.findByText('Fix flaky upload retry')).toBeTruthy();
		const failed = within(screen.getByText('Fix flaky upload retry').closest('a')!);
		expect(failed.getByText('$1.50')).toBeTruthy();
		expect(failed.getByText('2 tok')).toBeTruthy();
		expect(failed.getByRole('img', { name: 'Failed' })).toBeTruthy();
		expect(failed.getByText('Sandbox ran out of memory')).toBeTruthy();
		const merged = within(screen.getByText('Add a tasks page').closest('a')!);
		// A task that has not called a model yet has no usage to show.
		expect(merged.getByText('—')).toBeTruthy();
		expect(merged.getByText('acme/web')).toBeTruthy();
		expect(merged.getByText('claude-sonnet-4.5')).toBeTruthy();
		// The pull request's colour says it merged; no word repeats it.
		expect(merged.getByText(/#7/).textContent).toBe('#7');

		const tabs = screen.getByRole('tablist', { name: 'Tasks by state' });
		expect(within(tabs).getByRole('tab', { name: 'Pull requests 1' })).toBeTruthy();
		fireEvent.click(within(tabs).getByRole('tab', { name: 'Pull requests 1' }));
		expect(screen.queryByText('Fix flaky upload retry')).toBeNull();
		expect(screen.getByText('Add a tasks page')).toBeTruthy();

		fireEvent.click(within(tabs).getByRole('tab', { name: 'All 2' }));
		fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'flaky' } });
		expect(screen.getByText('Fix flaky upload retry')).toBeTruthy();
		expect(screen.queryByText('Add a tasks page')).toBeNull();
		expect(within(tabs).getByRole('tab', { name: 'Needs you 1' })).toBeTruthy();
	});

	it('shows the list a page at a time', async () => {
		api.sessions.mockResolvedValue({ sessions: Array.from({ length: 45 }, (_, index) => session({ id: `t${index}`, title: `Task number ${index + 1}` })) });
		open('/tasks');
		expect(await screen.findByText('Task number 1')).toBeTruthy();
		expect(screen.queryByText('Task number 21')).toBeNull();
		const pages = screen.getByRole('navigation', { name: 'Pages' });
		expect(within(pages).getByText('1–20 of 45')).toBeTruthy();
		fireEvent.click(within(pages).getByRole('button', { name: 'Page 3' }));
		expect(screen.getByText('Task number 45')).toBeTruthy();
		expect(screen.queryByText('Task number 1')).toBeNull();
		expect(within(pages).getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true);
		fireEvent.click(within(pages).getByRole('button', { name: 'Previous page' }));
		expect(within(pages).getByText('21–40 of 45')).toBeTruthy();
		// A new search starts again from the first page.
		fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'Task' } });
		expect(within(pages).getByText('1–20 of 45')).toBeTruthy();
	});

	it('numbers the pages around the one shown', () => {
		expect(pageNumbers(0, 3)).toEqual([0, 1, 2]);
		expect(pageNumbers(5, 12)).toEqual([0, null, 4, 5, 6, null, 11]);
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
		expect(screen.getByLabelText('Pull request #7 open')).toBeTruthy();
		expect(screen.getByText(/2 passed/)).toBeTruthy();
		expect(screen.getByText('3')).toBeTruthy();
		expect(screen.getAllByText('Merged').length).toBeGreaterThan(0);
		expect(screen.queryByText('Failing checks')).toBeNull();
	});
});
