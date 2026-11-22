import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/api/sessions';
import type { Space, SpaceTodo } from '@/lib/api/spaces';
import { TooltipProvider } from '@/components/ui/tooltip';
import { session } from './render';

const api = vi.hoisted(() => ({
	createSpaceTodo: vi.fn(async (_spaceId: string, input: { title: string }) => ({ id: 'todo_new', title: input.title })),
	editSpaceTodo: vi.fn(async (_spaceId: string, todoId: string, change: Record<string, unknown>) => ({ id: todoId, ...change })),
	deleteSpaceTodo: vi.fn(async () => undefined),
	startSpaceTodo: vi.fn(async () => ({ todo: { id: 'todo_open', status: 'in_progress' } })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { ProjectBoard } = await import('@/components/projects/project-board');

const space: Space = {
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
	repoIds: ['p1', 'p2'],
	repos: [
		{ id: 'p1', repoFullName: 'acme/api', defaultBranch: 'main' },
		{ id: 'p2', repoFullName: 'acme/web', defaultBranch: 'main' },
	],
	counts: { waiting: 0, working: 1, queued: 0, review: 0, landing: 0, idle: 0, resolved: 0 },
	threads: 1,
	activeAt: '2026-10-03T00:00:00Z',
	createdAt: '2026-10-01T00:00:00Z',
	updatedAt: '2026-10-03T00:00:00Z',
};

const makeTodo = (patch: Partial<SpaceTodo>): SpaceTodo => ({
	id: 'todo_1',
	spaceId: 'space_1',
	title: 'Fix OAuth redirect',
	description: 'Preserve return URL after login.',
	status: 'open',
	assignee: null,
	createdBy: 'user',
	threads: 0,
	createdAt: '2026-10-02T00:00:00Z',
	updatedAt: '2026-10-02T00:00:00Z',
	completedAt: null,
	...patch,
});

const threads: Session[] = [
	session({
		id: 'thread_1',
		spaceId: 'space_1',
		projectId: 'p1',
		repo: 'acme/api',
		title: 'Add invoices table',
		threadState: 'working',
		working: true,
		status: 'running',
	}),
];

function renderWithRouter(ui: () => ReactNode) {
	const root = createRootRoute({ component: ui });
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/projects/$spaceId/threads/$threadId', component: () => null }),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/'] }) });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>,
	);
	return router;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('the To do column on the project board', () => {
	it('lists open to-dos and those waiting on the coordinator, and counts the done ones', async () => {
		const onOpenCoordinator = vi.fn();
		renderWithRouter(() => (
			<ProjectBoard
				space={space}
				threads={threads}
				todos={[
					makeTodo({ id: 'todo_open', title: 'Backlog item' }),
					makeTodo({ id: 'todo_coord', title: 'Handed over', status: 'in_progress', assignee: 'coordinator' }),
					makeTodo({ id: 'todo_thread', title: 'Being worked', status: 'in_progress', assignee: 'thread', threads: 1 }),
					makeTodo({ id: 'todo_done', title: 'Shipped', status: 'done', threads: 1 }),
				]}
				onNewThread={() => undefined}
				onOpenCoordinator={onOpenCoordinator}
			/>
		));
		const column = await screen.findByRole('region', { name: 'To do' });
		expect(within(column).getByText('Backlog item')).toBeTruthy();
		expect(within(column).getByText('Handed over')).toBeTruthy();
		expect(within(column).queryByText('Being worked')).toBeNull();
		expect(within(column).queryByText('Shipped')).toBeNull();
		expect(within(column).getByText('1 done')).toBeTruthy();
		await userEvent.click(within(column).getByRole('button', { name: 'With the coordinator' }));
		expect(onOpenCoordinator).toHaveBeenCalledTimes(1);
	});

	it('adds a to-do, and starts one as a thread or hands it to the coordinator', async () => {
		const onOpenCoordinator = vi.fn();
		renderWithRouter(() => (
			<ProjectBoard space={space} threads={threads} todos={[makeTodo({ id: 'todo_open', title: 'Backlog item' })]} onNewThread={() => undefined} onOpenCoordinator={onOpenCoordinator} />
		));
		const column = await screen.findByRole('region', { name: 'To do' });

		await userEvent.click(within(column).getByRole('button', { name: 'New to-do' }));
		await userEvent.type(await screen.findByRole('textbox', { name: 'Title' }), 'Write the docs');
		await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'For the new CLI');
		await userEvent.click(screen.getByRole('button', { name: 'Add to-do' }));
		await waitFor(() => expect(api.createSpaceTodo).toHaveBeenCalledWith('space_1', { title: 'Write the docs', description: 'For the new CLI' }));

		await userEvent.click(within(column).getByRole('button', { name: 'Actions for Backlog item' }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Hand to the coordinator' }));
		await waitFor(() => expect(api.startSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_open', 'coordinator'));
		await waitFor(() => expect(onOpenCoordinator).toHaveBeenCalledTimes(1));

		await userEvent.click(within(column).getByRole('button', { name: 'Actions for Backlog item' }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Start a thread' }));
		await waitFor(() => expect(api.startSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_open', 'thread'));
	});

	it('offers a to-do on an empty project', async () => {
		renderWithRouter(() => <ProjectBoard space={space} threads={[]} todos={[]} onNewThread={() => undefined} onOpenCoordinator={() => undefined} />);
		await userEvent.click(await screen.findByRole('button', { name: 'New to-do' }));
		expect(await screen.findByRole('textbox', { name: 'Title' })).toBeTruthy();
	});
});
