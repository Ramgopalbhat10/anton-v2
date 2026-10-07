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
	session({ id: 'idle', title: 'Idle task', status: 'running', repo: 'acme/web' }),
	session({ id: 'old', title: 'Old pricey', createdAt: '2026-10-01T00:00:00Z', usage: { inputTokens: 1, outputTokens: 1, cost: 2 } }),
	session({
		id: 'new',
		title: 'New merged',
		createdAt: '2026-10-02T00:00:00Z',
		prUrl: 'https://github.com/acme/demo/pull/12',
		pullRequest: { state: 'merged', checks: null },
		usage: { inputTokens: 1, outputTokens: 1, cost: 0.1 },
	}),
	session({ id: 'pinned', title: 'Pinned oldest', createdAt: '2026-09-01T00:00:00Z', pinnedAt: '2026-10-03T00:00:00Z' }),
	session({
		id: 'red',
		title: 'Red checks',
		createdAt: '2026-09-02T00:00:00Z',
		prUrl: 'https://github.com/acme/demo/pull/7',
		pullRequest: { state: 'open', checks: 'failed' },
	}),
];

function open() {
	const root = createRootRoute({ component: () => <ChatSidebar open onNavigate={() => {}} onCollapse={() => {}} onOpenPalette={() => {}} /> });
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/', component: Outlet }),
		createRoute({ getParentRoute: () => root, path: '/agents/$sessionId', component: () => <div>Task page</div> }),
		createRoute({ getParentRoute: () => root, path: '/tasks', component: () => <div>Task list</div> }),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/'] }) });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
}

/** Task titles in a section, in order. */
const titles = (section: string) =>
	within(screen.getByRole('region', { name: section }))
		.queryAllByRole('link')
		.map((link) => tasks.find((task) => link.textContent?.startsWith(task.title))?.title);
const row = (title: string) => screen.getByText(title).closest('.group') as HTMLElement;

describe('sidebar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		api.sessions.mockResolvedValue({ sessions: tasks });
	});

	it('keeps pinned tasks in a section of their own, with Unpin on hover and no pin mark', async () => {
		open();
		await screen.findByText('Busy task');
		expect(titles('Pinned')).toEqual(['Pinned oldest']);
		expect(titles('Recent')).not.toContain('Pinned oldest');
		expect(titles('Running')).toEqual(['Busy task', 'Idle task']);

		await userEvent.click(within(row('Pinned oldest')).getByRole('button', { name: 'Unpin' }));
		expect(api.editSession).toHaveBeenCalledWith('pinned', { pinned: false });
		expect(within(row('Pinned oldest')).queryByRole('button', { name: 'Pin to top' })).toBeNull();
		await userEvent.click(within(row('Old pricey')).getByRole('button', { name: 'Pin to top' }));
		expect(api.editSession).toHaveBeenCalledWith('old', { pinned: true });
	});

	it('says under each title what the task is doing or how its pull request stands', async () => {
		open();
		await screen.findByText('Busy task');
		expect(within(row('Busy task')).getByText('Working')).toBeTruthy();
		expect(within(row('New merged')).getByText('#12 merged')).toBeTruthy();
		expect(within(row('Red checks')).getByText('Checks failing on #7')).toBeTruthy();
		expect(within(row('Red checks')).getByRole('img', { name: 'Checks failing on #7' })).toBeTruthy();
		expect(within(row('Idle task')).getByText(/web/)).toBeTruthy();
	});

	it('sorts, filters and saves the view from one menu', async () => {
		open();
		await screen.findByText('Busy task');
		await userEvent.click(screen.getByRole('button', { name: 'View options' }));
		await userEvent.click(screen.getByRole('menuitem', { name: /Sort/ }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Highest spend' }));
		expect(titles('Recent').slice(0, 2)).toEqual(['Old pricey', 'New merged']);

		await userEvent.click(screen.getByRole('button', { name: 'View options' }));
		await userEvent.click(screen.getByRole('menuitem', { name: /Filter/ }));
		await userEvent.click(await screen.findByRole('menuitem', { name: /Status/ }));
		await userEvent.click(await screen.findByRole('menuitem', { name: /Needs you/ }));
		await userEvent.keyboard('{Escape}{Escape}{Escape}');
		expect(titles('Recent')).toEqual(['Red checks']);
		expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull();
		expect(screen.getByText('Nothing running matches.')).toBeTruthy();
		expect(JSON.parse(localStorage.getItem('anton.sidebarView') ?? '{}')).toMatchObject({ sort: 'spend', filters: { status: ['attention'] } });

		await userEvent.click(screen.getByRole('button', { name: 'Remove the Needs you filter' }));
		expect(titles('Recent')).toHaveLength(3);
	});

	it('folds a section from its header and keeps it folded', async () => {
		open();
		await screen.findByText('Busy task');
		const header = within(screen.getByRole('region', { name: 'Running' })).getByRole('button', { expanded: true });
		expect(header.getAttribute('aria-expanded')).toBe('true');
		await userEvent.click(header);
		expect(header.getAttribute('aria-expanded')).toBe('false');
		expect(titles('Running')).toEqual([]);
		expect(JSON.parse(localStorage.getItem('anton.sidebarView') ?? '{}')).toMatchObject({ collapsed: ['running'] });
		await userEvent.click(header);
		expect(titles('Running')).toEqual(['Busy task', 'Idle task']);
	});

	it('shows only titles in compact view', async () => {
		open();
		await screen.findByText('Busy task');
		expect(within(row('Busy task')).getByText('Working')).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'View options' }));
		const toggle = screen.getByRole('menuitemcheckbox', { name: 'Compact view' });
		expect(toggle.getAttribute('aria-checked')).toBe('false');
		await userEvent.click(toggle);
		expect(within(row('Busy task')).queryByText('Working')).toBeNull();
	});

	it('searches every section', async () => {
		open();
		await screen.findByText('Busy task');
		await userEvent.click(screen.getByRole('button', { name: 'Search tasks' }));
		await userEvent.type(screen.getByRole('textbox', { name: 'Search tasks' }), 'pinned');
		expect(titles('Pinned')).toEqual(['Pinned oldest']);
		expect(titles('Running')).toEqual([]);
	});

	it('shows a card of details when resting on a task', async () => {
		open();
		await screen.findByText('Red checks');
		await userEvent.hover(screen.getByRole('link', { name: /Red checks/ }));
		const card = await screen.findByText('Pull request', {}, { timeout: 2000 });
		expect(card.parentElement?.textContent).toMatch(/#7 · Open, checks failing/);
		expect(screen.getByText('acme/demo')).toBeTruthy();
	});

	it('forks a running task into a new task', async () => {
		const router = open();
		await screen.findByText('Idle task');
		await userEvent.click(within(row('Idle task')).getByRole('button', { name: 'Task actions' }));
		expect(screen.getByRole('menuitem', { name: 'Copy task link' })).toBeTruthy();
		await userEvent.click(screen.getByRole('menuitem', { name: 'Fork into a new task' }));
		expect(api.forkSession).toHaveBeenCalledWith('idle');
		await waitFor(() => expect(router.state.location.pathname).toBe('/agents/fork'));
	});
});
