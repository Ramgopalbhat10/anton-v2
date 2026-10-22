import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { api, iPhone } = vi.hoisted(() => {
	const iPhone = { id: 'd1', name: 'iPhone', addedAt: '2026-10-14T08:00:00Z', lastSentAt: null, lastError: 'No answer timed out' };
	return { iPhone, api: {
	budget: vi.fn(async () => ({ limits: { dailyUsd: 10, taskUsd: null }, today: 1.25, task: null, blocked: null })),
	sessions: vi.fn(async () => ({ sessions: [] })),
	usage: vi.fn(async () => ({ since: '2026-10-01T00:00:00Z', today: 1.25, month: 3, byRepo: [], byModel: [], daily: [] })),
	storage: vi.fn(async () => ({ objects: 0, bytes: 0, lastCleanup: null })),
	projects: vi.fn(async () => ({ projects: [] })),
	secrets: vi.fn(async () => ({ shared: ['NPM_TOKEN'], repos: [{ projectId: 'p1', repo: 'acme/web', names: ['API_KEY', 'DB_URL'] }] })),
	push: vi.fn(async () => ({ publicKey: 'BKey', finished: false, devices: [iPhone] })),
	savePushOptions: vi.fn(async (options: { finished: boolean }) => ({ publicKey: 'BKey', finished: options.finished, devices: [iPhone] })),
	removePushDevice: vi.fn(async () => ({ publicKey: 'BKey', finished: false, devices: [] })),
	} };
});
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { SectionPage, SettingsLayout } = await import('@/components/settings/layout');
const { SettingsOverview } = await import('@/components/settings/overview');

/** The settings routes as main.tsx mounts them, without the app shell around them. */
function open(path: string) {
	const root = createRootRoute({ component: Outlet });
	const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsLayout });
	const tree = root.addChildren([
		settings.addChildren([
			createRoute({ getParentRoute: () => settings, path: '/', component: SettingsOverview }),
			createRoute({ getParentRoute: () => settings, path: '$section', component: SectionPage }),
		]),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe('Settings', () => {
	it('lists every section by group on the overview, with what was spent today', async () => {
		open('/settings');
		expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
		expect(await screen.findByLabelText('$1.25')).toBeTruthy();
		const nav = screen.getByRole('navigation', { name: 'Settings' });
		for (const label of ['All settings', 'Usage and limits', 'Storage', 'Repositories', 'Commands']) expect(within(nav).getByText(label)).toBeTruthy();
	});

	it('opens a section with its breadcrumb, and says when one does not exist', async () => {
		open('/settings/usage');
		expect(await screen.findByRole('heading', { name: 'Usage and limits' })).toBeTruthy();
		expect(await screen.findByDisplayValue('10')).toBeTruthy();

		document.body.innerHTML = '';
		open('/settings/nope');
		expect(await screen.findByText('No such settings page')).toBeTruthy();
	});

	it('shows secret names, never values, for every repository and each one', async () => {
		open('/settings/secrets');
		expect(await screen.findByDisplayValue('NPM_TOKEN')).toBeTruthy();
		expect(screen.getByPlaceholderText('Saved. Type to replace')).toBeTruthy();
		expect(screen.getByText('acme/web').closest('a')?.getAttribute('href')).toBe('/settings/repos/p1');
		expect(screen.getByText('API_KEY · DB_URL')).toBeTruthy();
	});

	it('lists the devices that get notifications, removes one, and saves what they hear about', async () => {
		open('/settings/notifications');
		expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeTruthy();
		expect(await screen.findByText('iPhone')).toBeTruthy();
		expect(screen.getByText('Last send failed: No answer timed out')).toBeTruthy();
		// A browser with no push support says so rather than offering a button that cannot work.
		expect(screen.getByText('This browser cannot get notifications from Anton.')).toBeTruthy();
		fireEvent.click(screen.getByRole('switch', { name: 'Notify when a task finishes' }));
		await waitFor(() => expect(api.savePushOptions.mock.calls[0]?.[0]).toEqual({ finished: true }));
		fireEvent.click(screen.getByRole('button', { name: 'Remove iPhone' }));
		await waitFor(() => expect((api.removePushDevice.mock.calls[0] as unknown[] | undefined)?.[0]).toBe('d1'));
		expect(await screen.findByText(/None yet/)).toBeTruthy();
	});

	it('folds a breakdown’s long tail under 1% into one row that opens it', async () => {
		const row = (key: string, tokens: number, cost = 0) => ({ key, tokens, cost });
		api.usage.mockResolvedValueOnce({
			since: '2026-10-01T00:00:00Z',
			today: 0,
			month: 0.4,
			byRepo: [],
			byModel: [row('a', 40_000_000), row('b', 20_000_000), row('c', 15_000_000), row('d', 10_000_000), row('e', 5_000_000), row('f', 300_000, 0.006), row('g', 200_000), row('h', 100_000, 0.001)],
			daily: [],
		} as never);
		open('/settings/usage');
		const more = await screen.findByRole('button', { name: /3 more under 1% each/ });
		expect(more.textContent).toContain('600K tokens · $0.007');
		expect(screen.queryByText(/^300K tokens/)).toBeNull();
		fireEvent.click(more);
		expect(screen.getByText(/^300K tokens/)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe('true');
	});

	it('lists repositories with their branch, task count and whether an image is prepared', async () => {
		const repo = (id: string, repoFullName: string, warmedAt: string | null) => ({ id, repoFullName, defaultBranch: 'main', memory: '', warmedAt, baseImage: null, env: {}, envKeys: [], setup: '', ports: [], fullVm: false });
		api.projects.mockResolvedValueOnce({ projects: [repo('p1', 'acme/web', new Date(Date.now() - 3 * 3600_000).toISOString()), repo('p2', 'acme/api', null)] } as never);
		api.sessions.mockResolvedValueOnce({ sessions: [{ id: 's1', projectId: 'p1' }, { id: 's2', projectId: 'p1' }] } as never);
		open('/settings/repos');
		const web = (await screen.findByText('web')).closest('a') as HTMLElement;
		expect(web.getAttribute('href')).toBe('/settings/repos/p1');
		expect(within(web).getByText('acme/')).toBeTruthy();
		expect(within(web).getByText('2').nextSibling?.textContent).toBe('tasks');
		expect(within(web).getByText('image · 3h old')).toBeTruthy();
		const api_ = screen.getByText('api').closest('a') as HTMLElement;
		expect(within(api_).getByText('no prepared image')).toBeTruthy();
	});
});
