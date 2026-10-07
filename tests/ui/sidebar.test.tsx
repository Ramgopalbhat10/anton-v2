import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from './render';

const api = vi.hoisted(() => ({
	sessions: vi.fn(),
	profile: vi.fn(async () => ({ name: 'Ada' })),
	budget: vi.fn(async () => ({ today: 0, limits: { dailyUsd: null }, blocked: false })),
	editSession: vi.fn(async (id: string, change: { pinned?: boolean }) => ({ id, pinnedAt: change.pinned ? 'now' : null })),
	forkSession: vi.fn(async () => ({ id: 'fork' })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
const { ChatSidebar } = await import('@/components/chat-sidebar');

const tasks = [
	session({ id: 'busy', title: 'Busy task', status: 'running', working: true }),
	session({ id: 'idle', title: 'Idle task', status: 'running' }),
	session({ id: 'old', title: 'Old pricey', createdAt: '2026-10-01T00:00:00Z', usage: { inputTokens: 1, outputTokens: 1, cost: 2 } }),
	session({ id: 'new', title: 'New cheap', createdAt: '2026-10-02T00:00:00Z', usage: { inputTokens: 1, outputTokens: 1, cost: 0.1 } }),
	session({ id: 'pinned', title: 'Pinned oldest', createdAt: '2026-09-01T00:00:00Z', pinnedAt: '2026-10-03T00:00:00Z' }),
];

function open() {
	const root = createRootRoute({ component: () => <ChatSidebar open onNavigate={() => {}} onCollapse={() => {}} onOpenPalette={() => {}} /> });
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/', component: Outlet }),
		createRoute({ getParentRoute: () => root, path: '/agents/$sessionId', component: () => <div>Task page</div> }),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/'] }) });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
}

const RECENT = ['Old pricey', 'New cheap', 'Pinned oldest'];
/** Recent task titles in the order the sidebar lists them. */
const recentTitles = () =>
	screen
		.getAllByRole('link')
		.map((link) => RECENT.find((title) => link.textContent?.startsWith(title)))
		.filter(Boolean);

describe('sidebar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		api.sessions.mockResolvedValue({ sessions: tasks });
	});

	it('keeps pinned tasks on top, sorts Recent by spend, and filters Running by what it is doing', async () => {
		open();
		await screen.findByText('Busy task');
		expect(recentTitles()).toEqual(['Pinned oldest', 'New cheap', 'Old pricey']);

		await userEvent.click(screen.getByRole('button', { name: 'Recent options' }));
		await userEvent.click(screen.getByRole('menuitem', { name: 'Highest spend first' }));
		expect(localStorage.getItem('anton.recentSort')).toBe('spend');
		expect(recentTitles()).toEqual(['Pinned oldest', 'Old pricey', 'New cheap']);

		await userEvent.click(screen.getByRole('button', { name: 'Filter running tasks' }));
		await userEvent.click(screen.getByRole('menuitem', { name: 'Idle' }));
		expect(screen.queryByText('Busy task')).toBeNull();
		expect(screen.getByText('Idle task')).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'Clear the Idle filter' }));
		expect(screen.getByText('Busy task')).toBeTruthy();
	});

	it('pins a stopped task from its row, and forks a running one into a new task', async () => {
		const router = open();
		await screen.findByText('Old pricey');
		const row = (title: string) => screen.getByText(title).closest('.group') as HTMLElement;

		await userEvent.click(within(row('Old pricey')).getByRole('button', { name: 'Pin to top' }));
		expect(api.editSession).toHaveBeenCalledWith('old', { pinned: true });

		await userEvent.click(within(row('Idle task')).getByRole('button', { name: 'Task actions' }));
		expect(screen.getByRole('menuitem', { name: 'Copy task link' })).toBeTruthy();
		expect(screen.getByText('Spend')).toBeTruthy();
		await userEvent.click(screen.getByRole('menuitem', { name: 'Fork into a new task' }));
		expect(api.forkSession).toHaveBeenCalledWith('idle');
		await waitFor(() => expect(router.state.location.pathname).toBe('/agents/fork'));
	});
});
