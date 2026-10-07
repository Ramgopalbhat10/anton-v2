import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
	budget: vi.fn(async () => ({ limits: { dailyUsd: 10, taskUsd: null }, today: 1.25, task: null, blocked: null })),
	sessions: vi.fn(async () => ({ sessions: [] })),
	usage: vi.fn(async () => ({ since: '2026-10-01T00:00:00Z', today: 1.25, month: 3, byRepo: [], byModel: [], daily: [] })),
	storage: vi.fn(async () => ({ objects: 0, bytes: 0, lastCleanup: null })),
	projects: vi.fn(async () => ({ projects: [] })),
	secrets: vi.fn(async () => ({ shared: ['NPM_TOKEN'], repos: [{ projectId: 'p1', repo: 'acme/web', names: ['API_KEY', 'DB_URL'] }] })),
}));
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
});
