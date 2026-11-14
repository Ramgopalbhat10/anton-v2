import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotification, NotificationsView } from '@/lib/api';
import { session } from './render';

const now = new Date();
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const row = (patch: Partial<AppNotification>): AppNotification => ({
	id: 'n',
	kind: 'replied',
	category: 'replies',
	sessionId: 's1',
	spaceId: null,
	title: 'Task',
	body: 'Said something.',
	url: '/agents/s1',
	createdAt: minutesAgo(5),
	read: false,
	...patch,
});

const rows: AppNotification[] = [
	row({ id: 'ask', kind: 'question', category: 'needs-you', sessionId: 'ask', title: 'Pick a database', body: 'Postgres or SQLite?', url: '/agents/ask', createdAt: minutesAgo(1) }),
	row({ id: 'red', kind: 'checks-failed', category: 'failures', sessionId: 'red', title: 'Fix login', body: 'Checks failed on pull request #7: test', url: '/agents/red', createdAt: minutesAgo(2) }),
	row({ id: 'box', kind: 'sandbox-stopped', category: 'sandboxes', sessionId: 'box', title: 'Refactor', body: 'Sandbox stopped after 5 idle minutes.', url: '/agents/box', createdAt: minutesAgo(3) }),
	row({ id: 'done', kind: 'done', category: 'done', sessionId: 'thread', spaceId: 'sp1', title: 'Ship billing', body: 'Done: shipped.', url: '/projects/sp1/threads/thread', createdAt: minutesAgo(4), read: true }),
];

function viewOf(list: AppNotification[]): NotificationsView {
	const unread = { 'needs-you': 0, replies: 0, done: 0, failures: 0, sandboxes: 0 };
	for (const item of list) if (!item.read) unread[item.category] += 1;
	return { notifications: list, unread };
}

const api = vi.hoisted(() => ({
	notifications: vi.fn(),
	readNotifications: vi.fn(),
	sessions: vi.fn(),
	spaces: vi.fn(async () => ({ spaces: [{ id: 'sp1', name: 'Billing v2', state: 'active', counts: {} }] })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
const { NotificationsBell } = await import('@/components/notifications');
const { InboxPage } = await import('@/components/inbox-page');

function mount(path = '/') {
	const root = createRootRoute({
		component: () => (
			<>
				<NotificationsBell onOpen={() => {}} />
				<Outlet />
			</>
		),
	});
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/inbox', component: InboxPage }),
		createRoute({ getParentRoute: () => root, path: '/agents/$sessionId', component: () => <div>Task page</div> }),
		createRoute({ getParentRoute: () => root, path: '/projects/$spaceId/threads/$threadId', component: () => <div>Thread page</div> }),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
}

describe('Notifications', () => {
	beforeEach(() => {
		localStorage.clear();
		let current = rows.map((item) => ({ ...item }));
		api.notifications.mockImplementation(async () => viewOf(current));
		api.readNotifications.mockImplementation(async (which: { ids?: string[]; all?: boolean; read?: boolean }) => {
			const read = which.read ?? true;
			current = current.map((item) => (which.all || which.ids?.includes(item.id) ? { ...item, read } : item));
			return viewOf(current);
		});
		api.sessions.mockResolvedValue({ sessions: [session({ id: 'ask', repo: 'acme/api' }), session({ id: 'red', repo: 'acme/web' })] });
	});

	it('counts unread rows on the bell, leaving out sandboxes starting and stopping', async () => {
		mount();
		expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeTruthy();
	});

	it('lists every row under its day, filtered by kind and by unread', async () => {
		const user = userEvent.setup();
		mount('/inbox');
		const list = await screen.findByRole('region', { name: 'Today' });
		expect(within(list).getByText('Pick a database')).toBeTruthy();
		expect(within(list).getByText('Ship billing')).toBeTruthy();
		expect(within(list).getByText('Billing v2')).toBeTruthy();
		expect(within(list).getByText('api')).toBeTruthy();

		await user.click(screen.getByRole('button', { name: /Failures/ }));
		expect(within(list).getByText('Fix login')).toBeTruthy();
		expect(within(list).queryByText('Pick a database')).toBeNull();

		await user.click(screen.getByRole('button', { name: 'Clear' }));
		await user.click(screen.getByRole('button', { name: 'Unread, 3' }));
		expect(within(list).queryByText('Ship billing')).toBeNull();
		expect(within(list).getByText('Refactor')).toBeTruthy();
	});

	it('opens the task a row is about and marks it read', async () => {
		const user = userEvent.setup();
		const router = mount('/inbox');
		await user.click(await screen.findByRole('button', { name: /Pick a database/ }));
		// The picked row shows beside the list; its way there opens the task.
		const open = await screen.findByRole('button', { name: 'Open task' });
		await user.click(open);
		await waitFor(() => expect(router.state.location.pathname).toBe('/agents/ask'));
		expect(api.readNotifications).toHaveBeenCalledWith({ ids: ['ask'] });
	});

	it('marks everything read at once', async () => {
		const user = userEvent.setup();
		mount('/inbox');
		await screen.findByRole('button', { name: /Pick a database/ });
		await user.click(screen.getByRole('button', { name: /Mark all read/ }));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications', hidden: true })).toBeTruthy());
		expect(api.readNotifications).toHaveBeenCalledWith({ all: true });
	});
});
