import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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
const { NotificationsBell, NotificationsDialog } = await import('@/components/notifications');

function Harness() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<NotificationsBell onOpen={() => setOpen(true)} />
			<NotificationsDialog open={open} onClose={() => setOpen(false)} />
		</>
	);
}

function mount() {
	const root = createRootRoute({ component: () => <><Harness /><Outlet /></> });
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/agents/$sessionId', component: () => <div>Task page</div> }),
		createRoute({ getParentRoute: () => root, path: '/projects/$spaceId/threads/$threadId', component: () => <div>Thread page</div> }),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/'] }) });
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

	it('opens as a dialog with every row, filtered by kind and by unread', async () => {
		const user = userEvent.setup();
		mount();
		await user.click(await screen.findByRole('button', { name: /^Notifications/ }));
		const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
		expect(within(dialog).getByText('Pick a database')).toBeTruthy();
		expect(within(dialog).getByText('Ship billing')).toBeTruthy();
		expect(within(dialog).getByText('Billing v2')).toBeTruthy();
		expect(within(dialog).getByText('api')).toBeTruthy();

		await user.click(within(dialog).getByRole('button', { name: /Failures/ }));
		expect(within(dialog).getByText('Fix login')).toBeTruthy();
		expect(within(dialog).queryByText('Pick a database')).toBeNull();

		await user.click(within(dialog).getByRole('button', { name: 'Clear' }));
		await user.click(within(dialog).getByRole('radio', { name: /Unread/ }));
		expect(within(dialog).queryByText('Ship billing')).toBeNull();
		expect(within(dialog).getByText('Refactor')).toBeTruthy();
	});

	it('opens the task a row is about and marks it read', async () => {
		const user = userEvent.setup();
		const router = mount();
		await user.click(await screen.findByRole('button', { name: /^Notifications/ }));
		await user.click(await screen.findByText('Pick a database'));
		await waitFor(() => expect(router.state.location.pathname).toBe('/agents/ask'));
		expect(api.readNotifications).toHaveBeenCalledWith({ ids: ['ask'] });
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();
	});

	it('marks everything read at once', async () => {
		const user = userEvent.setup();
		mount();
		await user.click(await screen.findByRole('button', { name: /^Notifications/ }));
		const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
		await user.click(within(dialog).getByRole('button', { name: /Mark all read/ }));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications', hidden: true })).toBeTruthy());
		expect(api.readNotifications).toHaveBeenCalledWith({ all: true });
	});
});
