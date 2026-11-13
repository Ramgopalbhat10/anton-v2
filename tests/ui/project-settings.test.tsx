import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Space } from '@/lib/api';

const model = (id: string, name: string) => ({
	id,
	name,
	vendor: 'Acme',
	description: '',
	createdAt: 0,
	contextLength: 128_000,
	maxOutput: null,
	price: { input: 0, output: 0 },
	vision: false,
	reasoning: ['low', 'high'],
	defaultReasoning: 'high',
});

const api = vi.hoisted(() => ({
	space: vi.fn(),
	subscriptions: vi.fn(async () => ({ subscriptions: [] })),
	editSpace: vi.fn(async (_id: string, change: object) => change),
	generalSettings: vi.fn(),
	models: vi.fn(async () => ({ models: [model('openrouter/acme/model', 'Model'), model('openrouter/acme/fast', 'Fast')], default: 'openrouter/acme/model' })),
	projects: vi.fn(async () => ({ projects: [] })),
	spaceUsage: vi.fn(async () => ({ today: 0, month: 0, byThread: [], byModel: [], daily: [] })),
	deleteSpace: vi.fn(async () => undefined),
}));

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { ProjectSettingsModal } = await import('@/components/project-settings-modal');
// The card loads its sections on first open; loaded here, so a test waits for a render, not a module.
await import('@/components/project-settings');
const { closeProjectSettings, openProjectSettings } = await import('@/lib/project-settings-modal');

const general = {
	model: null,
	reasoning: null,
	planMode: false,
	reviewPullRequests: true,
	codeMode: false,
	visualReplies: 'some',
	pageNetwork: true,
	imageModel: null,
	titleModel: null,
	compactAt: 200_000,
	claudeCodeCompactAt: 200_000,
	agentModels: { explorer: null, tester: { model: 'openrouter/acme/fast', reasoning: 'low' }, browser: null, computer: null, reviewer: null },
};

const space = (patch: Partial<Space> = {}): Space => ({
	id: 'space_1',
	name: 'Billing',
	icon: null,
	goal: 'Ship billing v2',
	instructions: '',
	memory: '',
	coordinatorModel: null,
	coordinatorReasoning: null,
	threadModel: null,
	threadReasoning: null,
	agentModels: { explorer: null, tester: null, browser: null, computer: null, reviewer: null },
	maxParallel: 3,
	autonomy: 'start',
	state: 'active',
	repoIds: ['p1'],
	repos: [{ id: 'p1', repoFullName: 'acme/demo', defaultBranch: 'main' }],
	counts: { waiting: 0, working: 0, queued: 0, review: 0, landing: 0, idle: 0, resolved: 0 },
	threads: 0,
	activeAt: '2026-10-03T00:00:00Z',
	createdAt: '2026-10-01T00:00:00Z',
	updatedAt: '2026-10-03T00:00:00Z',
	...patch,
});

function page(current: Space) {
	api.space.mockResolvedValue(current);
	api.generalSettings.mockResolvedValue(general);
	api.editSpace.mockImplementation(async (_id: string, change: object) => ({ ...current, ...change }));
	closeProjectSettings();
	openProjectSettings('space_1');
	const root = createRootRoute({ component: () => <ProjectSettingsModal /> });
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/projects/$spaceId', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/projects/$spaceId/settings', component: () => null }),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/projects/space_1'] }) });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe('Project settings', () => {
	it('opens as a card with its sections beside it, and moves between them', async () => {
		page(space({ instructions: 'Keep pull requests small.' }));
		expect(await screen.findByRole('dialog', { name: 'Project settings' })).toBeTruthy();
		// The card's sections load the first time it opens.
		const nav = await screen.findByRole('navigation', { name: 'Project settings' });
		expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('General');
		fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
		expect(await screen.findByDisplayValue('Keep pull requests small.')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Close project settings' }));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Project settings' })).toBeNull());
	});

	it.each(['coordinator', 'thread', 'explorer', 'tester', 'browser', 'computer', 'reviewer'])('saves %s routing in its own project field only', async (caller) => {
		const id = 'openrouter/acme/model';
		const agentModels = Object.fromEntries(['explorer', 'tester', 'browser', 'computer', 'reviewer'].map((agent) => [agent, { model: id, reasoning: 'low' }])) as Space['agentModels'];
		page(space({ coordinatorModel: id, coordinatorReasoning: 'low', threadModel: id, threadReasoning: 'high', agentModels }));
		const callers = ['coordinator', 'thread', 'explorer', 'tester', 'browser', 'computer', 'reviewer'];
		await userEvent.click((await screen.findAllByRole('button', { name: 'Model and reasoning' }))[callers.indexOf(caller)]);
		await userEvent.click(screen.getAllByRole('button', { name: 'Sort providers: default' })[0]);
		await userEvent.click(screen.getByRole('menuitem', { name: /Price/ }));
		await userEvent.keyboard('{Escape}');
		expect(api.editSpace).not.toHaveBeenCalled();
		await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
		await waitFor(() => expect(api.editSpace).toHaveBeenCalledWith('space_1', expect.objectContaining({
			coordinatorModel: caller === 'coordinator' ? `${id}#sort=price` : id,
			coordinatorReasoning: 'low', threadModel: caller === 'thread' ? `${id}#sort=price` : id, threadReasoning: 'high',
			agentModels: callers.indexOf(caller) > 1 ? { ...agentModels, [caller]: { model: `${id}#sort=price`, reasoning: 'low' } } : agentModels,
		})));
	});
	it('shows what each helper follows, and saves one of its own', async () => {
		page(space());
		// Tester has a model in Settings › General; the rest follow the thread's.
		expect(await screen.findByText('Default · Fast')).toBeTruthy();
		expect(screen.getAllByText("Default · thread's model").length).toBe(4);

		fireEvent.click(screen.getByRole('switch', { name: 'Explorer uses its own model' }));
		// The first Save is the Project card's; each later card saves its own text.
		fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
		await waitFor(() =>
			expect(api.editSpace).toHaveBeenCalledWith(
				'space_1',
				expect.objectContaining({
					agentModels: { explorer: { model: 'openrouter/acme/model', reasoning: null }, tester: null, browser: null, computer: null, reviewer: null },
				}),
			),
		);
	});

	it('switches a helper back to the default', async () => {
		page(space({ agentModels: { explorer: { model: 'openrouter/acme/model', reasoning: 'low' }, tester: null, browser: null, computer: null, reviewer: null } }));
		fireEvent.click(await screen.findByRole('switch', { name: 'Explorer uses its own model' }));
		fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
		await waitFor(() => expect(api.editSpace).toHaveBeenCalledWith('space_1', expect.objectContaining({ agentModels: { explorer: null, tester: null, browser: null, computer: null, reviewer: null } })));
	});
});
