import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@/lib/api';

const api = vi.hoisted(() => ({
	artifacts: vi.fn(),
	session: vi.fn(async () => ({ id: 's1', title: 'Budget task', spaceId: null })),
	outputText: vi.fn(async () => '# Findings\n\nAll good.'),
	outputs: vi.fn(async () => ({ source: 'saved', at: null, outputs: [], deleted: [] as string[] })),
	deleteOutput: vi.fn(async () => undefined),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
const { ArtifactsPage, ArtifactView } = await import('@/components/artifacts-page');
const { CATEGORIES } = await import('@/lib/artifacts');

const now = Date.now();
const artifact = (patch: Partial<Artifact>): Artifact => ({
	sessionId: 's1',
	path: 'x',
	title: 'x',
	size: 100,
	mtimeMs: now,
	task: { title: 'Budget task', spaceId: null, chat: false },
	...patch,
});
const listed = [
	artifact({ path: 'renders/budget-planner-a1b2c3.html', title: 'Budget planner', mtimeMs: now - 1000 }),
	artifact({ path: 'reports/findings.md', title: 'findings.md' }),
	artifact({ sessionId: 's2', path: 'screenshots/home.png', title: 'home.png', task: { title: 'Landing page', spaceId: 'p1', chat: false } }),
];

function open(path: string) {
	api.artifacts.mockResolvedValue({ artifacts: listed });
	const root = createRootRoute({ component: Outlet });
	const tree = root.addChildren([
		createRoute({
			getParentRoute: () => root,
			path: '/artifacts',
			validateSearch: (search: Record<string, unknown>) => ({
				type: CATEGORIES.find((category) => category.key === search.type)?.key,
				q: typeof search.q === 'string' && search.q ? search.q : undefined,
			}),
			component: ArtifactsPage,
		}),
		createRoute({
			getParentRoute: () => root,
			path: '/artifacts/$taskId',
			validateSearch: (search: Record<string, unknown>) => ({ path: typeof search.path === 'string' ? search.path : '' }),
			component: ArtifactView,
		}),
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

describe('Artifacts', () => {
	it('puts apps first, then files, each card opening the artifact', async () => {
		const router = open('/artifacts');
		const apps = await screen.findByRole('region', { name: 'Apps' });
		const files = screen.getByRole('region', { name: 'Files' });
		expect(within(apps).getByText('Budget planner')).toBeTruthy();
		expect(within(files).getByText('findings.md')).toBeTruthy();
		expect(within(files).getByText('home.png')).toBeTruthy();
		await userEvent.click(screen.getByRole('link', { name: 'Budget planner, app from Budget task' }));
		expect(router.state.location.pathname).toBe('/artifacts/s1');
		expect(router.state.location.search).toEqual({ path: 'renders/budget-planner-a1b2c3.html' });
	});

	it('narrows to one kind, and searches titles and tasks', async () => {
		open('/artifacts');
		await userEvent.click(await screen.findByRole('tab', { name: /Apps\s*1/ }));
		expect(screen.getByText('Budget planner')).toBeTruthy();
		expect(screen.queryByText('findings.md')).toBeNull();
		await userEvent.click(screen.getByRole('tab', { name: /All\s*3/ }));
		await userEvent.type(screen.getByRole('textbox', { name: 'Search artifacts' }), 'landing');
		expect(await screen.findByText('home.png')).toBeTruthy();
		expect(screen.queryByText('Budget planner')).toBeNull();
	});

	it('shows an app live, full size, with its source and a tab of its own', async () => {
		open('/artifacts/s1?path=renders%2Fbudget-planner-a1b2c3.html');
		const frame = (await screen.findByTitle('Budget planner')) as HTMLIFrameElement;
		expect(frame.getAttribute('src')).toBe('/api/sessions/s1/render-frame?path=renders%2Fbudget-planner-a1b2c3.html');
		expect(screen.getByRole('link', { name: 'Open in a new tab' }).getAttribute('href')).toBe(frame.getAttribute('src'));
		expect(screen.getByRole('link', { name: /Budget task/ })).toBeTruthy();
		await userEvent.click(screen.getByRole('radio', { name: 'Code' }));
		expect(screen.queryByTitle('Budget planner')).toBeNull();
	});

	it('deletes an artifact from its menu, asking twice, and it leaves the page', async () => {
		open('/artifacts');
		const card = (await screen.findByText('findings.md')).closest('.in-card') as HTMLElement;
		await userEvent.click(within(card).getByRole('button', { name: 'Actions for findings.md' }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
		expect(api.deleteOutput).not.toHaveBeenCalled();
		api.artifacts.mockResolvedValue({ artifacts: listed.filter((item) => item.path !== 'reports/findings.md') });
		await userEvent.click(screen.getByRole('menuitem', { name: 'Click again to delete' }));
		expect(api.deleteOutput).toHaveBeenCalledWith('s1', 'reports/findings.md');
		await waitFor(() => expect(screen.queryByText('findings.md')).toBeNull());
	});

	it('deletes the artifact it shows and goes back to them all; a deleted one says so', async () => {
		const router = open('/artifacts/s1?path=reports%2Ffindings.md');
		expect(await screen.findByRole('heading', { name: 'Findings' })).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await userEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
		expect(api.deleteOutput).toHaveBeenCalledWith('s1', 'reports/findings.md');
		await waitFor(() => expect(router.state.location.pathname).toBe('/artifacts'));

		api.outputs.mockResolvedValue({ source: 'saved', at: null, outputs: [], deleted: ['reports/old.md'] });
		open('/artifacts/s1?path=reports%2Fold.md');
		expect(await screen.findByText('This file was deleted')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
	});

	it('renders a document, with its text a click away', async () => {
		open('/artifacts/s1?path=reports%2Ffindings.md');
		expect(await screen.findByRole('heading', { name: 'Findings' })).toBeTruthy();
		await userEvent.click(screen.getByRole('radio', { name: 'Code' }));
		expect(await screen.findByText(/# Findings/)).toBeTruthy();
	});
});
