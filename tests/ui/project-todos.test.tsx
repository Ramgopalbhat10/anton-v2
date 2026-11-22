import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/api/sessions';
import type { Space, SpaceTodo } from '@/lib/api/spaces';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSpaceTodos } from '@/lib/spaces';
import { session } from './render';

const api = vi.hoisted(() => ({
	spaceTodos: vi.fn(async (_spaceId: string) => ({ todos: [] as SpaceTodo[] })),
	createSpaceTodo: vi.fn(async (_spaceId: string, input: { title: string }) => makeTodo({ id: 'todo_new', title: input.title })),
	editSpaceTodo: vi.fn(async (_spaceId: string, todoId: string, change: Record<string, unknown>) => makeTodo({ id: todoId, ...change })),
	deleteSpaceTodo: vi.fn(async () => undefined),
	startSpaceTodo: vi.fn(async () => ({ todo: { id: 'todo_open', status: 'in_progress' } })),
	attachToProject: vi.fn(async (_spaceId: string, file: File) => ({ name: file.name, path: file.name, kind: 'Text', size: file.size, text: 'hello', cut: null })),
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

function makeTodo(patch: Partial<SpaceTodo>): SpaceTodo {
	return {
	id: 'todo_1',
	spaceId: 'space_1',
	title: 'Fix OAuth redirect',
	description: 'Preserve return URL after login.',
	attachments: [],
	status: 'open',
	assignee: null,
	createdBy: 'user',
	threads: 0,
	createdAt: '2026-10-02T00:00:00Z',
	updatedAt: '2026-10-02T00:00:00Z',
	completedAt: null,
	...patch,
	};
}

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
	api.spaceTodos.mockResolvedValue({ todos: [] });
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

	it('creates work only from To do; the thread-state columns have no add button', async () => {
		renderWithRouter(() => <ProjectBoard space={space} threads={threads} todos={[]} onNewThread={() => undefined} onOpenCoordinator={() => undefined} />);
		const todo = await screen.findByRole('region', { name: 'To do' });
		expect(within(todo).getByRole('button', { name: 'New to-do' })).toBeTruthy();
		for (const name of ['Needs you', 'Working', 'Ready for review', 'Done']) {
			const column = screen.getByRole('region', { name });
			expect(within(column).queryByRole('button', { name: /^New / })).toBeNull();
		}
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
		await waitFor(() => expect(api.createSpaceTodo).toHaveBeenCalledWith('space_1', { title: 'Write the docs', description: 'For the new CLI', attachments: [] }));

		await userEvent.click(within(column).getByRole('button', { name: 'Actions for Backlog item' }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Hand to the coordinator' }));
		await waitFor(() => expect(api.startSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_open', 'coordinator'));
		await waitFor(() => expect(onOpenCoordinator).toHaveBeenCalledTimes(1));

		await userEvent.click(within(column).getByRole('button', { name: 'Actions for Backlog item' }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Start a thread' }));
		await waitFor(() => expect(api.startSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_open', 'thread'));
	});

	it("attaches files to a to-do in the project's Library, shows them on its card, and lets an edit drop one", async () => {
		renderWithRouter(() => (
			<ProjectBoard
				space={space}
				threads={threads}
				todos={[
					makeTodo({
						id: 'todo_files',
						title: 'Fix the toolbar',
						attachments: [
							{ name: 'toolbar.png', path: 'toolbar.png', kind: 'PNG image', size: 2048 },
							{ name: 'notes.md', path: 'notes.md', kind: 'Markdown', size: 120 },
						],
					}),
				]}
				onNewThread={() => undefined}
				onOpenCoordinator={() => undefined}
			/>
		));
		const column = await screen.findByRole('region', { name: 'To do' });
		expect(within(column).getByText('2 files')).toBeTruthy();

		await userEvent.click(within(column).getByRole('button', { name: 'New to-do' }));
		await userEvent.type(await screen.findByRole('textbox', { name: 'Title' }), 'Read the log');
		const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
		await userEvent.upload(picker, new File(['hello'], 'crash.log', { type: 'text/plain' }));
		expect(await screen.findByText('crash.log')).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'Add to-do' }));
		await waitFor(() =>
			expect(api.createSpaceTodo).toHaveBeenCalledWith('space_1', { title: 'Read the log', description: '', attachments: [{ name: 'crash.log', path: 'crash.log', kind: 'Text', size: 5 }] }),
		);
		expect(api.attachToProject).toHaveBeenCalledTimes(1);

		await userEvent.click(within(column).getAllByRole('button', { name: /Fix the toolbar/ })[0]!);
		// A saved picture shows as its thumbnail from the Library, a document as its chip.
		expect((await screen.findByRole('img', { name: 'toolbar.png' })).getAttribute('src')).toBe('/api/spaces/space_1/file?path=toolbar.png');
		expect(screen.queryByRole('img', { name: 'notes.md' })).toBeNull();
		await userEvent.click(await screen.findByRole('button', { name: 'Remove notes.md' }));
		await userEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(api.editSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_files', {
				title: 'Fix the toolbar',
				description: 'Preserve return URL after login.',
				attachments: [{ name: 'toolbar.png', path: 'toolbar.png', kind: 'PNG image', size: 2048 }],
			}),
		);
		expect(api.attachToProject).toHaveBeenCalledTimes(1);
	});

	describe('saves in the background', () => {
		/** The board as the project page draws it: from the to-do list the server keeps. */
		function LiveBoard() {
			const { todos } = useSpaceTodos('space_1');
			return <ProjectBoard space={space} threads={threads} todos={todos} onNewThread={() => undefined} onOpenCoordinator={() => undefined} />;
		}
		const later = <T,>() => {
			let resolve!: (value: T) => void;
			let reject!: (error: Error) => void;
			const promise = new Promise<T>((yes, no) => {
				resolve = yes;
				reject = no;
			});
			return { promise, resolve, reject };
		};

		it('shows a new to-do the moment it is added, then the saved one in its place, once', async () => {
			const saved = makeTodo({ id: 'todo_new', title: 'Write the docs', description: '' });
			const create = later<SpaceTodo>();
			api.createSpaceTodo.mockReturnValueOnce(create.promise);
			renderWithRouter(() => <LiveBoard />);
			const column = await screen.findByRole('region', { name: 'To do' });
			await userEvent.click(within(column).getByRole('button', { name: 'New to-do' }));
			await userEvent.type(await screen.findByRole('textbox', { name: 'Title' }), 'Write the docs');
			await userEvent.click(screen.getByRole('button', { name: 'Add to-do' }));

			// The dialog is gone and the card is up while the server has not answered.
			expect(screen.queryByRole('dialog')).toBeNull();
			expect(within(column).getByText('Write the docs')).toBeTruthy();
			expect(within(column).getByText('Saving…')).toBeTruthy();

			api.spaceTodos.mockResolvedValue({ todos: [saved] });
			create.resolve(saved);
			await waitFor(() => expect(within(column).queryByText('Saving…')).toBeNull());
			expect(within(column).getAllByText('Write the docs')).toHaveLength(1);
			expect(within(column).getByRole('button', { name: 'Actions for Write the docs' }).hasAttribute('disabled')).toBe(false);
		});

		it('keeps a to-do the server refused, and saves it on Retry', async () => {
			api.createSpaceTodo.mockRejectedValueOnce(new Error('Network down'));
			renderWithRouter(() => <LiveBoard />);
			const column = await screen.findByRole('region', { name: 'To do' });
			await userEvent.click(within(column).getByRole('button', { name: 'New to-do' }));
			await userEvent.type(await screen.findByRole('textbox', { name: 'Title' }), 'Flaky one');
			await userEvent.click(screen.getByRole('button', { name: 'Add to-do' }));

			expect(await within(column).findByText(/Not saved: Network down/)).toBeTruthy();
			await userEvent.click(within(column).getByRole('button', { name: 'Retry' }));
			await waitFor(() => expect(api.createSpaceTodo).toHaveBeenCalledTimes(2));
			await waitFor(() => expect(within(column).queryByRole('alert')).toBeNull());
			expect(within(column).getByText('Flaky one')).toBeTruthy();
		});

		it('marks done and deletes at once, and puts a card back when the server refuses', async () => {
			api.spaceTodos.mockResolvedValue({ todos: [makeTodo({ id: 'todo_a', title: 'First' }), makeTodo({ id: 'todo_b', title: 'Second' })] });
			const done = later<SpaceTodo>();
			api.editSpaceTodo.mockReturnValueOnce(done.promise);
			api.deleteSpaceTodo.mockRejectedValueOnce(new Error('Locked'));
			renderWithRouter(() => <LiveBoard />);
			const column = await screen.findByRole('region', { name: 'To do' });
			await within(column).findByText('First');

			await userEvent.click(within(column).getByRole('button', { name: 'Actions for First' }));
			await userEvent.click(await screen.findByRole('menuitem', { name: 'Mark done' }));
			expect(within(column).queryByText('First')).toBeNull();
			expect(within(column).getByText('1 done')).toBeTruthy();
			expect(api.editSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_a', { status: 'done' });

			await userEvent.click(within(column).getByRole('button', { name: 'Actions for Second' }));
			await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
			// Gone at once, then back with the reason when the delete fails.
			expect(await within(column).findByText(/Change not saved: Locked/)).toBeTruthy();
			expect(within(column).getByText('Second')).toBeTruthy();

			api.spaceTodos.mockResolvedValue({ todos: [makeTodo({ id: 'todo_a', title: 'First', status: 'done' }), makeTodo({ id: 'todo_b', title: 'Second' })] });
			done.resolve(makeTodo({ id: 'todo_a', title: 'First', status: 'done', updatedAt: '2026-10-04T00:00:00Z' }));
			await waitFor(() => expect(within(column).getByText('1 done')).toBeTruthy());
			expect(within(column).queryByText('First')).toBeNull();
		});
	});

	it('offers a to-do on an empty project', async () => {
		renderWithRouter(() => <ProjectBoard space={space} threads={[]} todos={[]} onNewThread={() => undefined} onOpenCoordinator={() => undefined} />);
		await userEvent.click(await screen.findByRole('button', { name: 'New to-do' }));
		expect(await screen.findByRole('textbox', { name: 'Title' })).toBeTruthy();
	});
});
