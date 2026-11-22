import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/api/sessions';
import type { Space, SpaceTodo } from '@/lib/api/spaces';
import { TooltipProvider } from '@/components/ui/tooltip';
import { todoAssignMessage } from '../../src/core/space-todos';
import { session } from './render';

const api = vi.hoisted(() => ({
	sessions: vi.fn(),
	spaces: vi.fn(),
	spaceFiles: vi.fn(async () => ({ files: [{ path: 'spec.md', size: 120, modifiedAt: '2026-10-03T00:00:00Z' }] })),
	spaceTodos: vi.fn(async () => ({ todos: [] as SpaceTodo[] })),
	createSpaceTodo: vi.fn(async (_spaceId: string, input: { title: string }) => ({ id: 'todo_new', title: input.title })),
	editSpaceTodo: vi.fn(async (_spaceId: string, todoId: string, change: Record<string, unknown>) => ({ id: todoId, ...change })),
	deleteSpaceTodo: vi.fn(async () => undefined),
	reorderSpaceTodos: vi.fn(async () => ({ todos: [] })),
	assignSpaceTodo: vi.fn(async () => ({ todo: { id: 'todo_1', status: 'triaging' } })),
	models: vi.fn(async () => ({ models: [], default: 'openrouter/test/cheap' })),
	subscriptions: vi.fn(async () => ({ subscriptions: [] })),
	nudgeThread: vi.fn(async () => ({})),
	stopAgent: vi.fn(async () => undefined),
	startThread: vi.fn(async () => ({ id: 'new' })),
	attachToProject: vi.fn(),
	budget: vi.fn(async () => ({ limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null })),
	commands: vi.fn(async () => ({ commands: [] })),
	todos: vi.fn(async () => ({ list: null })),
	now: vi.fn(async () => ({ now: null })),
	outputs: vi.fn(async () => ({ source: 'saved', at: null, outputs: [] })),
	storedOutputs: vi.fn(async () => ({ outputs: [] })),
	pullMetadata: vi.fn(async () => null),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { ProjectBoard } = await import('@/components/projects/project-board');
const { ProjectTodos } = await import('@/components/projects/project-todos');
const { ProjectFeed } = await import('@/components/projects/project-feed');

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
	assigneeKind: 'unassigned',
	priority: 'high',
	tags: ['auth'],
	projectId: 'p1',
	model: null,
	reasoning: null,
	planMode: false,
	files: [],
	dueAt: null,
	sourceUrl: null,
	position: 0,
	createdBy: 'user',
	threadIds: [],
	assignedAt: null,
	completedAt: null,
	completedBy: null,
	createdAt: '2026-10-02T00:00:00Z',
	updatedAt: '2026-10-02T00:00:00Z',
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

describe('ProjectBoard with To do column', () => {
	it('places open to-dos in To do, moves triaging to Working/Needs you, and enriches linked thread cards', async () => {
		const todos: SpaceTodo[] = [
			makeTodo({ id: 'todo_open', title: 'Backlog item', status: 'open', priority: 'high', tags: ['ui'] }),
			makeTodo({ id: 'todo_triage', title: 'Triaging item', status: 'triaging', assigneeKind: 'coordinator', threadIds: [] }),
			makeTodo({ id: 'todo_linked', title: 'Invoices work', status: 'in_progress', assigneeKind: 'thread', priority: 'urgent', tags: ['billing'], threadIds: ['thread_1'] }),
		];
		const onOpenCoordinator = vi.fn();
		renderWithRouter(() => (
			<ProjectBoard space={space} threads={threads} todos={todos} coordinatorBusy={true} onNewThread={() => undefined} onOpenCoordinator={onOpenCoordinator} />
		));

		const todoCol = await screen.findByRole('region', { name: 'To do' });
		expect(within(todoCol).getByText('Backlog item')).toBeTruthy();
		expect(within(todoCol).queryByText('Triaging item')).toBeNull();
		expect(within(todoCol).queryByText('Invoices work')).toBeNull();

		const workingCol = screen.getByRole('region', { name: 'Working' });
		expect(within(workingCol).getByText('Triaging item')).toBeTruthy();
		expect(within(workingCol).getByText('Add invoices table')).toBeTruthy();
		expect(within(workingCol).getByText('Urgent')).toBeTruthy();
		expect(within(workingCol).getByText('billing')).toBeTruthy();

		// Clicking the coordinating card opens the coordinator dock.
		await userEvent.click(within(workingCol).getByRole('button', { name: /Triaging item: Coordinating/ }));
		expect(onOpenCoordinator).toHaveBeenCalledTimes(1);
	});

	it('shows stalled triaging card in Needs you with a Retry assign menu when coordinator is idle', async () => {
		const stalled = makeTodo({ id: 'todo_stalled', title: 'Stalled on board', status: 'triaging', assigneeKind: 'coordinator', threadIds: [] });
		renderWithRouter(() => (
			<ProjectBoard space={space} threads={threads} todos={[stalled]} coordinatorBusy={false} onNewThread={() => undefined} />
		));

		const needsCol = await screen.findByRole('region', { name: 'Needs you' });
		expect(within(needsCol).getByText('Stalled on board')).toBeTruthy();
		await userEvent.click(within(needsCol).getByRole('button', { name: 'Retry Stalled on board' }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Start new thread' }));
		await waitFor(() => expect(api.assignSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_stalled', { target: 'new-thread', retry: true }));
	});

	it('quick-adds a to-do in the To do column and assigns to coordinator or new thread', async () => {
		const openTodo = makeTodo({ id: 'todo_open', title: 'Ship dark mode' });
		const onOpenCoordinator = vi.fn();
		renderWithRouter(() => (
			<ProjectBoard space={space} threads={threads} todos={[openTodo]} onNewThread={() => undefined} onOpenCoordinator={onOpenCoordinator} />
		));

		const todoCol = await screen.findByRole('region', { name: 'To do' });
		await userEvent.click(within(todoCol).getByRole('button', { name: 'Add to-do' }));
		const input = within(todoCol).getByRole('textbox', { name: 'Quick add to-do' });
		await userEvent.type(input, 'Write release notes{Enter}');
		await waitFor(() => expect(api.createSpaceTodo).toHaveBeenCalledWith('space_1', { title: 'Write release notes' }));

		await userEvent.click(within(todoCol).getByRole('button', { name: 'Assign Ship dark mode' }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Send to coordinator' }));
		await waitFor(() => expect(api.assignSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_open', { target: 'coordinator' }));
		expect(onOpenCoordinator).toHaveBeenCalledTimes(1);

		await userEvent.click(within(todoCol).getByRole('button', { name: 'Assign Ship dark mode' }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Start new thread' }));
		await waitFor(() => expect(api.assignSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_open', { target: 'new-thread' }));
	});

	it('assigns a to-do when dropped onto Working and shows an error banner if drop assignment fails', async () => {
		const openTodo = makeTodo({ id: 'todo_drop', title: 'Drag me to working' });
		renderWithRouter(() => (
			<ProjectBoard space={space} threads={threads} todos={[openTodo]} onNewThread={() => undefined} />
		));

		const todoCard = await screen.findByRole('article', { name: 'Drag me to working' });
		const workingCol = screen.getByRole('region', { name: 'Working' });
		const data = new Map<string, string>();
		const dataTransfer = {
			types: ['application/x-anton-todo'],
			setData: (type: string, value: string) => data.set(type, value),
			getData: (type: string) => data.get(type) ?? '',
			effectAllowed: 'move',
			dropEffect: 'move',
		};

		// Successful drop starts a new thread.
		fireEvent.dragStart(todoCard, { dataTransfer });
		fireEvent.dragOver(workingCol, { dataTransfer });
		fireEvent.drop(workingCol, { dataTransfer });
		await waitFor(() => expect(api.assignSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_drop', { target: 'new-thread' }));

		// Rejected drop renders a visible error banner that can be dismissed.
		api.assignSpaceTodo.mockRejectedValueOnce(new Error('That repository is not in this project'));
		fireEvent.dragStart(todoCard, { dataTransfer });
		fireEvent.dragOver(workingCol, { dataTransfer });
		fireEvent.drop(workingCol, { dataTransfer });
		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('That repository is not in this project');
		await userEvent.click(within(alert).getByRole('button', { name: 'Dismiss error' }));
		expect(screen.queryByRole('alert')).toBeNull();
	});
});

describe('ProjectTodos view', () => {
	it('creates, filters, reorders, and edits to-dos with metadata', async () => {
		const list: SpaceTodo[] = [
			makeTodo({ id: 't1', title: 'First task', position: 0, priority: 'high', tags: ['api'] }),
			makeTodo({ id: 't2', title: 'Second task', position: 1, priority: 'low', tags: ['web'] }),
			makeTodo({ id: 't3', title: 'Finished task', status: 'done', position: 2 }),
		];
		renderWithRouter(() => <ProjectTodos space={space} threads={threads} todos={list} />);

		// Default Open filter shows only open items.
		expect(await screen.findByText('First task')).toBeTruthy();
		expect(screen.getByText('Second task')).toBeTruthy();
		expect(screen.queryByText('Finished task')).toBeNull();

		// Quick add creates a to-do.
		const quickInput = screen.getByRole('textbox', { name: 'New to-do title' });
		await userEvent.type(quickInput, 'Add webhook retries{Enter}');
		await waitFor(() =>
			expect(api.createSpaceTodo).toHaveBeenCalledWith('space_1', {
				title: 'Add webhook retries',
				priority: null,
				projectId: null,
			}),
		);

		// Reorder moves the second task up.
		await userEvent.click(screen.getByRole('button', { name: 'Move Second task up' }));
		await waitFor(() => expect(api.reorderSpaceTodos).toHaveBeenCalledWith('space_1', ['t2', 't1']));

		// Open editor dialog and save updated description.
		await userEvent.click(screen.getByRole('button', { name: 'First task' }));
		const dialog = await screen.findByRole('dialog', { name: 'Edit to-do: First task' });
		const desc = within(dialog).getByLabelText('Brief / acceptance criteria');
		await userEvent.clear(desc);
		await userEvent.type(desc, 'Updated acceptance criteria');
		await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(api.editSpaceTodo).toHaveBeenCalledWith(
				'space_1',
				't1',
				expect.objectContaining({ title: 'First task', description: 'Updated acceptance criteria' }),
			),
		);

		// Switch to Done tab.
		await userEvent.click(screen.getByRole('tab', { name: /Done/ }));
		expect(await screen.findByText('Finished task')).toBeTruthy();
	});

	it('allows retrying an unlinked triaging to-do from the Active tab', async () => {
		const triaging = makeTodo({ id: 't_triage', title: 'Stalled triage item', status: 'triaging', assigneeKind: 'coordinator', threadIds: [] });
		renderWithRouter(() => <ProjectTodos space={space} threads={threads} todos={[triaging]} />);

		await userEvent.click(await screen.findByRole('tab', { name: /Active/ }));
		await userEvent.click(await screen.findByRole('button', { name: 'Retry Stalled triage item' }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Start new thread' }));
		await waitFor(() => expect(api.assignSpaceTodo).toHaveBeenCalledWith('space_1', 't_triage', { target: 'new-thread', retry: true }));
	});
});

describe('ProjectFeed todo assignment rendering', () => {
	it('renders <todo-assign> messages as a compact assigned to-do card', async () => {
		const assignText = todoAssignMessage({
			id: 'todo_1',
			title: 'Fix OAuth redirect',
			priority: 'urgent',
			description: 'Keep redirect URL after sign-in.',
		});
		const agent = {
			messages: [{ id: 'm1', role: 'user', display: 'visible', parts: [{ type: 'text', text: assignText }] }],
			status: 'ready',
			historyReady: true,
			hasOlder: false,
			loadingOlder: false,
			loadOlder: vi.fn(),
			sendMessage: vi.fn(),
			stop: vi.fn(),
		} as unknown as Parameters<typeof ProjectFeed>[0]['agent'];

		renderWithRouter(() => <ProjectFeed space={space} agent={agent} threads={threads} starting={false} onStartingChange={() => undefined} />);

		expect(await screen.findByText('Assigned to-do')).toBeTruthy();
		expect(screen.getByText('Fix OAuth redirect')).toBeTruthy();
		expect(screen.getByText('Urgent')).toBeTruthy();
		expect(screen.queryByText(/<todo-assign/)).toBeNull();
	});
});
