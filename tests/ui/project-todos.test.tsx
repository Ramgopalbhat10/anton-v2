import { createFlueClient, type FlueConversationMessage, type FlueConversationPart, type FlueConversationSettlement } from '@flue/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/api/sessions';
import type { Space, SpaceTodo } from '@/lib/api/spaces';
import type { ModelInfo } from '@/lib/api/plans';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSpaceTodos } from '@/lib/spaces';
import { useTodoSaves } from '@/components/projects/todo-saves';
import { session } from './render';
import { todoStartMessage } from '../../src/core/space-todos';

const api = vi.hoisted(() => ({
	spaceTodos: vi.fn(async (_spaceId: string) => ({ todos: [] as SpaceTodo[] })),
	space: vi.fn(async (_spaceId: string) => space),
	sessions: vi.fn(async () => ({ sessions: threads })),
	models: vi.fn(async () => ({ models: [] as ModelInfo[], default: '' })),
	runners: vi.fn(async () => ({ sandbox: 'modal', host: true })),
	subscriptions: vi.fn(async () => ({ subscriptions: [] })),
	commands: vi.fn(async () => ({ commands: [] })),
	budget: vi.fn(async () => ({ blocked: null })),
	spaceUsage: vi.fn(async () => ({ today: 0, month: 0, byThread: [], byModel: [], daily: [] })),
	storedOutputs: vi.fn(async () => ({ outputs: [] })),
	createSpaceTodo: vi.fn(async (_spaceId: string, input: Pick<SpaceTodo, 'title' | 'threadModel'>) => makeTodo({ id: 'todo_new', ...input })),
	editSpaceTodo: vi.fn(async (_spaceId: string, todoId: string, change: Record<string, unknown>) => makeTodo({ id: todoId, ...change })),
	deleteSpaceTodo: vi.fn(async () => undefined),
	startSpaceTodo: vi.fn(async (): Promise<{ todo: SpaceTodo; submissionId?: string }> => ({ todo: makeTodo({ id: 'todo_open', status: 'in_progress' }) })),
	attachToProject: vi.fn(async (_spaceId: string, file: File) => ({ name: file.name, path: file.name, kind: 'Text', size: file.size, text: 'hello', cut: null })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
vi.mock('@flue/sdk', async (original) => ({ ...(await original<typeof import('@flue/sdk')>()), createFlueClient: vi.fn() }));

const { ProjectBoard: Board } = await import('@/components/projects/project-board');
const { ProjectPage } = await import('@/components/projects/project-page');

function ProjectBoard({ todos, ...props }: Omit<ComponentProps<typeof Board>, 'saves'> & { todos: SpaceTodo[] }) {
	const saves = useTodoSaves(props.space.id, todos);
	return <Board {...props} saves={saves} />;
}

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
		threadModel: null,
		repos: [],
		runOn: 'sandbox',
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

function renderWithRouter(ui: () => ReactNode, path = '/') {
	const root = createRootRoute({ component: ui });
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/projects', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/projects/$spaceId', component: ProjectPage }),
		createRoute({ getParentRoute: () => root, path: '/projects/$spaceId/threads/$threadId', component: () => null }),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
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
	localStorage.clear();
	api.spaceTodos.mockResolvedValue({ todos: [] });
	api.runners.mockResolvedValue({ sandbox: 'modal', host: true });
});

const later = <T,>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};

function coordinatorConversation() {
	let onChange = () => {};
	let snapshot: { phase: 'absent' | 'live'; conversation?: { messages: FlueConversationMessage[]; settlements: FlueConversationSettlement[] } } = { phase: 'absent' };
	const refresh = vi.fn();
	const send = vi.fn(async () => ({ submissionId: 'joined' }));
	vi.mocked(createFlueClient).mockReturnValue({ send, observe: () => ({
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => { onChange = listener; return () => {}; },
		refresh,
		close: () => {},
	}) } as never);
	const publish = (messages: FlueConversationMessage[], settlements: FlueConversationSettlement[] = []) => act(() => {
		snapshot = { phase: 'live', conversation: { messages, settlements } };
		onChange();
	});
	return { publish, refresh, send };
}

it('opens the coordinator during a delayed handoff, makes failure retryable, and tracks the accepted submission', async () => {
	const item = makeTodo({ id: 'todo_open', title: 'Backlog item', description: '' });
	api.spaceTodos.mockResolvedValue({ todos: [item] });
	localStorage.setItem('anton.project-panel.space_1', JSON.stringify({ open: false, view: 'board' }));
	let reject!: (error: Error) => void;
	let accept!: (result: { todo: SpaceTodo; submissionId: string }) => void;
	api.startSpaceTodo
		.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
		.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
	const { publish, refresh, send } = coordinatorConversation();
	renderWithRouter(() => <Outlet />, '/projects/space_1');
	const actions = await screen.findByRole('button', { name: 'Actions for Backlog item' });
	expect(screen.queryByRole('button', { name: 'Hide the coordinator' })).toBeNull();
	await userEvent.click(actions);
	await userEvent.click(await screen.findByRole('menuitem', { name: 'Hand to the coordinator' }));
	expect(await screen.findByRole('button', { name: 'Hide the coordinator' })).toBeTruthy();
	expect(screen.getByText('Handing “Backlog item” to the coordinator').closest('[role=status]')).toBeTruthy();
	expect(api.startSpaceTodo).toHaveBeenCalledExactlyOnceWith('space_1', item.id, 'coordinator');
	expect(actions.hasAttribute('disabled')).toBe(true);
	await act(() => reject(new Error('Could not connect')));
	expect(screen.getByRole('alert').textContent).toContain('Could not hand off “Backlog item”: Could not connect');
	expect(screen.queryByText('Handing “Backlog item” to the coordinator')).toBeNull();
	await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
	expect(screen.getByText('Handing “Backlog item” to the coordinator')).toBeTruthy();
	const assigned: SpaceTodo = { ...item, status: 'in_progress', assignee: 'coordinator' };
	api.spaceTodos.mockResolvedValue({ todos: [assigned] });
	await act(() => accept({ todo: assigned, submissionId: 'handoff' }));
	expect(refresh).toHaveBeenCalledTimes(1);
	expect(screen.getByText('Waiting for the coordinator to pick up “Backlog item”')).toBeTruthy();
	const brief = todoStartMessage(item);
	const message: FlueConversationMessage = { id: 'message', role: 'user', purpose: 'user', display: 'visible', submissionId: 'handoff', parts: [{ type: 'text', state: 'done', text: brief }] };
	await publish([message], [{ submissionId: 'unrelated', outcome: 'completed' }]);
	expect(screen.queryByText('Waiting for the coordinator to pick up “Backlog item”')).toBeNull();
	expect(screen.getAllByText(brief)).toHaveLength(1);
	expect(screen.getByText('The coordinator is reading')).toBeTruthy();
	const reply: FlueConversationMessage = { id: 'reply', role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: 'handoff', parts: [] };
	await publish([message, reply]);
	expect(screen.getByText('The coordinator is thinking')).toBeTruthy();
	for (const toolName of ['read_project_file', 'read_thread', 'suggest_threads']) {
		await publish([message, { ...reply, parts: [{ type: 'dynamic-tool', toolName, toolCallId: toolName, state: 'input-available', input: {} }] }]);
		expect(screen.getByText('The coordinator is thinking')).toBeTruthy();
	}
	await publish([message, { ...reply, parts: [{ type: 'dynamic-tool', toolName: 'start_thread', toolCallId: 'start', state: 'input-available', input: { title: 'Start billing work' } }] }]);
	expect(screen.getByText('Start billing work')).toBeTruthy();
	expect(screen.getByText('Starting')).toBeTruthy();
	expect(screen.queryByText('The coordinator is thinking')).toBeNull();
	const followUp: FlueConversationMessage = { ...message, id: 'joined-message', submissionId: 'joined', parts: [{ type: 'text', state: 'done', text: 'Also run the tests.' }] };
	const launching: FlueConversationMessage = { ...reply, parts: [{ type: 'dynamic-tool', toolName: 'start_thread', toolCallId: 'start', state: 'output-available', input: { title: 'Start billing work' }, output: 'Started [id:thread-not-yet-listed]' }] };
	await publish([message, launching]);
	await userEvent.type(screen.getByRole('textbox', { name: 'Add to what the coordinator is doing' }), 'Also run the tests.{Enter}');
	expect(send).toHaveBeenCalledOnce();
	expect(screen.getByText('Also run the tests.')).toBeTruthy();
	expect(screen.getByText('Starting')).toBeTruthy();
	await publish([message, launching, followUp]);
	expect(screen.getAllByText('Also run the tests.')).toHaveLength(1);
	expect(screen.getByText('Starting')).toBeTruthy();
	expect(screen.queryByText('The coordinator is reading')).toBeNull();
	await publish([message, { ...reply, parts: [
		{ type: 'dynamic-tool', toolName: 'start_thread', toolCallId: 'start', state: 'output-available', input: { title: 'Start billing work' }, output: 'Started [id:thread_1]' },
		{ type: 'text', state: 'done', text: 'Done for now.' },
	] }, followUp], [{ submissionId: 'handoff', outcome: 'completed' }, { submissionId: 'joined', outcome: 'completed', answeredBySubmissionId: 'handoff' }]);
	const dock = within(screen.getByRole('complementary', { name: 'Coordinator' }));
	expect(dock.getByRole('article', { name: 'Add invoices table' })).toBeTruthy();
	expect(dock.queryByText('Starting')).toBeNull();
	expect(screen.getByText('Done for now.')).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Stop the coordinator' })).toBeNull();
	expect(screen.queryByText('The coordinator is thinking')).toBeNull();
});

it.each(['explicit', 'inferred'] as const)('keeps a joined to-do and attachment above the right thread action with an %s ID through finish and settlement', async (mode) => {
	const first = makeTodo({ id: 'todo_aaaaaaaa', title: 'Add invoices to billing', description: '' });
	const second = makeTodo({ id: 'todo_bbbbbbbb', title: 'Make the invoice preview taller', description: '' });
	const nextThread = session({ ...threads[0], id: 'thread_2', title: 'Fill the invoice preview' });
	api.sessions.mockResolvedValueOnce({ sessions: [...threads, nextThread] });
	api.spaceTodos.mockResolvedValue({ todos: [first, second] });
	if (mode === 'explicit') api.startSpaceTodo.mockResolvedValueOnce({ todo: { ...first, status: 'in_progress' }, submissionId: 'first' });
	api.startSpaceTodo.mockResolvedValueOnce({ todo: { ...second, status: 'in_progress' }, submissionId: 'second' });
	const { publish } = coordinatorConversation();
	renderWithRouter(() => <Outlet />, '/projects/space_1');
	const handOff = async (todo: SpaceTodo) => {
		await userEvent.click(await screen.findByRole('button', { name: `Actions for ${todo.title}` }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Hand to the coordinator' }));
		await screen.findByText(`Waiting for the coordinator to pick up “${todo.title}”`);
	};
	const userMessage = (todo: SpaceTodo, submissionId: string): FlueConversationMessage => ({
		id: `user-${submissionId}`, role: 'user', purpose: 'user', display: 'visible', submissionId,
		parts: [{ type: 'text', state: 'done', text: todoStartMessage(todo) }],
	});
	const u1 = userMessage(first, 'first');
	const firstText = mode === 'explicit' ? todoStartMessage(first) : first.title;
	u1.parts = [{ type: 'text', state: 'done', text: firstText }];
	const u2 = userMessage(second, 'second');
	u2.parts.push({ type: 'file', mediaType: 'image/png', filename: 'preview.png', url: '/preview.png' });
	const reply: FlueConversationMessage = {
		id: 'reply', role: 'assistant', purpose: 'assistant', display: 'visible', submissionId: 'first',
		metadata: { startedAt: 42 },
		parts: [{ type: 'dynamic-tool', toolName: 'start_thread', toolCallId: 'c1', state: 'output-available', input: mode === 'explicit' ? { todo_id: '[todo:aaaaaaaa]' } : {}, output: 'Started [id:thread_1]' }],
	};
	if (mode === 'explicit') await handOff(first);
	await publish([u1, reply]);
	await handOff(second);
	const rejected: FlueConversationPart = {
		type: 'dynamic-tool', toolName: 'start_thread', toolCallId: 'wrong-brief', state: 'output-error',
		input: { todo_id: second.id, title: 'Start the billing work again', request: first.title }, errorText: 'Request is not the user’s words for this to-do',
	};
	const earlierCalls = mode === 'explicit' ? [...reply.parts, rejected] : reply.parts;
	const tool = { type: 'dynamic-tool', toolName: 'start_thread', toolCallId: 'c2', state: 'input-available', input: { ...(mode === 'explicit' ? { todo_id: second.id } : {}), title: nextThread.title } } as const;
	const resolved = { ...tool, state: 'output-available', output: { output: 'Started [id:thread_2]', todoId: second.id } } as const;
	await publish([u1, { ...reply, parts: [...earlierCalls, mode === 'explicit' ? tool : resolved] }, u2]);
	const dock = within(screen.getByRole('complementary', { name: 'Coordinator' }));
	const brief1 = dock.getByText(firstText);
	const row1 = dock.getByRole('article', { name: threads[0].title });
	const brief2 = dock.getByText(todoStartMessage(second));
	const image = dock.getByRole('button', { name: 'Open preview.png' });
	const before = (node: Node, other: Node) => expect(node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	before(brief1, row1);
	before(row1, image);
	before(image, brief2);
	before(brief2, dock.getByText(nextThread.title));
	if (mode === 'explicit') {
		expect(dock.getByText('Starting')).toBeTruthy();
		before(dock.getByText('Could not start “Start the billing work again”'), image);
	}

	const answered: FlueConversationMessage = { ...reply, parts: [...earlierCalls, resolved, { type: 'text', state: 'done', text: 'Both threads are underway.' }] };
	const assertFinalOrder = () => {
		const row2 = dock.getByRole('article', { name: nextThread.title });
		expect(dock.getByText(todoStartMessage(second))).toBe(brief2);
		before(row1, image);
		if (mode === 'explicit') before(dock.getByText('Could not start “Start the billing work again”'), image);
		before(image, brief2);
		before(brief2, row2);
		before(row2, dock.getByText('Both threads are underway.'));
		expect(dock.queryByText('Starting')).toBeNull();
	};
	await publish([u1, answered, u2]);
	assertFinalOrder();
	const finished = { ...answered, metadata: { ...reply.metadata, completedAt: 84, usage: {} } };
	await publish([u1, finished, u2]);
	assertFinalOrder();
	const hostSettled: FlueConversationSettlement = { submissionId: 'first', outcome: 'completed' };
	await publish([u1, finished, u2], [hostSettled]);
	assertFinalOrder();
	await publish([u1, finished, u2], [
		hostSettled,
		{ submissionId: 'second', outcome: 'completed', answeredBySubmissionId: 'first' },
	]);
	assertFinalOrder();
});

it.each([
	{ outcome: 'failed', error: { message: 'The provider could not render the reply' }, text: 'The coordinator failed while working on “Backlog item”: The provider could not render the reply' },
	{ outcome: 'aborted', error: undefined, text: 'The coordinator stopped while working on “Backlog item”.' },
] as const)('explains an accepted handoff that settled $outcome without a transcript marker, then gives way to the marker', async ({ outcome, error, text }) => {
	const item = makeTodo({ id: 'todo_open', title: 'Backlog item' });
	const assigned = { ...item, status: 'in_progress', assignee: 'coordinator', updatedAt: '2026-10-04T00:00:00Z' } as const;
	api.spaceTodos.mockResolvedValue({ todos: [item] });
	api.startSpaceTodo.mockImplementationOnce(async () => {
		api.spaceTodos.mockResolvedValue({ todos: [assigned] });
		return { todo: assigned, submissionId: 'handoff' };
	});
	const { publish } = coordinatorConversation();
	renderWithRouter(() => <Outlet />, '/projects/space_1');
	await userEvent.click(await screen.findByRole('button', { name: 'Actions for Backlog item' }));
	await userEvent.click(await screen.findByRole('menuitem', { name: 'Hand to the coordinator' }));
	await screen.findByText('Waiting for the coordinator to pick up “Backlog item”');
	const marker = (id: string, body: string): FlueConversationMessage => ({
		id: `entry_submission_${outcome === 'aborted' ? 'aborted' : 'interrupted'}_${id}`,
		role: 'system', purpose: 'advisory', display: 'diagnostic', settlement: { outcome },
		...(outcome === 'aborted' ? { signal: { attributes: { submissionId: id, kind: 'dispatch', reason: 'aborted' } } } : { submissionId: id }),
		parts: [{ type: 'text', state: 'done', text: body }],
	});
	const unrelated = marker('unrelated', 'The runtime explained another submission.');
	const settlements = [{ submissionId: 'handoff', outcome, error }];
	await publish([unrelated], settlements);
	expect(screen.getByRole('alert').textContent).toContain(text);
	expect(screen.queryByText('Waiting for the coordinator to pick up “Backlog item”')).toBeNull();
	expect(screen.getByRole('button', { name: 'Try again' }).hasAttribute('disabled')).toBe(true);
	await publish([unrelated, marker('handoff', 'The runtime explained the outcome.')], settlements);
	expect(screen.getAllByText('The runtime explained the outcome.')).toHaveLength(1);
	expect(screen.queryByText(text)).toBeNull();
});

it('blocks dock retry while the same to-do is starting a thread, even if the board is remounted', async () => {
	const item = makeTodo({ id: 'todo_open', title: 'Backlog item' });
	const starting = later<Awaited<ReturnType<typeof api.startSpaceTodo>>>();
	api.spaceTodos.mockResolvedValue({ todos: [item] });
	api.startSpaceTodo.mockRejectedValueOnce(new Error('Could not connect')).mockReturnValueOnce(starting.promise);
	coordinatorConversation();
	renderWithRouter(() => <Outlet />, '/projects/space_1');
	const action = 'Actions for Backlog item';
	await userEvent.click(await screen.findByRole('button', { name: action }));
	await userEvent.click(await screen.findByRole('menuitem', { name: 'Hand to the coordinator' }));
	const retry = await screen.findByRole('button', { name: 'Try again' });
	expect(retry.hasAttribute('disabled')).toBe(false);
	await userEvent.click(screen.getByRole('button', { name: action }));
	await userEvent.click(await screen.findByRole('menuitem', { name: 'Start a thread' }));
	await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(true));
	await userEvent.click(retry);
	expect(api.startSpaceTodo.mock.calls).toEqual([['space_1', item.id, 'coordinator'], ['space_1', item.id, 'thread']]);
	await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
	expect(retry.hasAttribute('disabled')).toBe(true);
	await userEvent.click(screen.getByRole('tab', { name: 'Board' }));
	expect(screen.getByRole('button', { name: action }).hasAttribute('disabled')).toBe(true);
	await act(() => starting.reject(new Error('Could not start the thread')));
	await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false));
});

it('disables dock retry through attachment upload and editing, retries the saved to-do, and disables retry when it is done', async () => {
	const item = makeTodo({ id: 'todo_open', title: 'Backlog item' });
	api.spaceTodos.mockResolvedValue({ todos: [item] });
	api.startSpaceTodo.mockRejectedValueOnce(new Error('Could not connect')).mockRejectedValueOnce(new Error('Could not connect'));
	const upload = later<Awaited<ReturnType<typeof api.attachToProject>>>();
	api.attachToProject.mockReturnValueOnce(upload.promise);
	const patch = later<SpaceTodo>();
	api.editSpaceTodo.mockReturnValueOnce(patch.promise);
	coordinatorConversation();
	renderWithRouter(() => <Outlet />, '/projects/space_1');
	await userEvent.click(await screen.findByRole('button', { name: 'Actions for Backlog item' }));
	await userEvent.click(await screen.findByRole('menuitem', { name: 'Hand to the coordinator' }));
	const retryButton = await screen.findByRole('button', { name: 'Try again' });
	const card = within(screen.getByRole('article', { name: 'Backlog item' }));
	await userEvent.click(card.getByRole('button', { name: /Backlog item Preserve/ }));
	const dialog = await screen.findByRole('dialog', { name: 'Edit to-do' });
	const edit = within(dialog);
	await userEvent.clear(edit.getByRole('textbox', { name: 'Title' }));
	await userEvent.type(edit.getByRole('textbox', { name: 'Title' }), 'Revised brief');
	await userEvent.upload(dialog.querySelector<HTMLInputElement>('input[type=file]')!, new File(['Updated'], 'details.txt', { type: 'text/plain' }));
	await userEvent.click(edit.getByRole('button', { name: 'Save' }));
	expect(api.attachToProject).toHaveBeenCalledTimes(1);
	expect(api.editSpaceTodo).not.toHaveBeenCalled();
	expect(retryButton.hasAttribute('disabled')).toBe(true);
	await userEvent.click(retryButton);
	expect(api.startSpaceTodo).toHaveBeenCalledTimes(1);

	// Leaving the board does not lose the save in progress or make dock retry available.
	await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
	expect(retryButton.hasAttribute('disabled')).toBe(true);
	const attachment = { name: 'details.txt', path: 'details.txt', kind: 'Text', size: 7 };
	await act(() => upload.resolve({ ...attachment, text: 'Updated', cut: null }));
	expect(api.editSpaceTodo).toHaveBeenCalledWith('space_1', item.id, { title: 'Revised brief', description: item.description, attachments: [attachment] });
	expect(retryButton.hasAttribute('disabled')).toBe(true);
	const saved = { ...item, title: 'Revised brief', updatedAt: '2026-10-04T00:00:00Z', attachments: [attachment] };
	api.spaceTodos.mockResolvedValue({ todos: [saved] });
	await act(() => patch.resolve(saved));
	await waitFor(() => expect(retryButton.hasAttribute('disabled')).toBe(false));
	await userEvent.click(retryButton);
	expect(await screen.findByText('Could not hand off “Revised brief”: Could not connect')).toBeTruthy();
	expect(api.startSpaceTodo).toHaveBeenCalledTimes(2);
	await userEvent.click(screen.getByRole('tab', { name: 'Board' }));
	await userEvent.click(await screen.findByRole('button', { name: 'Actions for Revised brief' }));
	await userEvent.click(await screen.findByRole('menuitem', { name: 'Mark done' }));
	await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' }).hasAttribute('disabled')).toBe(true));
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
				onHandTodo={() => undefined}
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
		renderWithRouter(() => <ProjectBoard space={space} threads={threads} todos={[]} onNewThread={() => undefined} onOpenCoordinator={() => undefined} onHandTodo={() => undefined} />);
		const todo = await screen.findByRole('region', { name: 'To do' });
		expect(within(todo).getByRole('button', { name: 'New to-do' })).toBeTruthy();
		for (const name of ['Needs you', 'Working', 'Ready for review', 'Done']) {
			const column = screen.getByRole('region', { name });
			expect(within(column).queryByRole('button', { name: /^New / })).toBeNull();
		}
	});

	it('adds a to-do, and starts one as a thread or hands it to the coordinator', async () => {
		const onHandTodo = vi.fn();
		renderWithRouter(() => (
			<ProjectBoard space={space} threads={threads} todos={[makeTodo({ id: 'todo_open', title: 'Backlog item' })]} onNewThread={() => undefined} onOpenCoordinator={() => undefined} onHandTodo={onHandTodo} />
		));
		const column = await screen.findByRole('region', { name: 'To do' });

		await userEvent.click(within(column).getByRole('button', { name: 'New to-do' }));
		await userEvent.type(await screen.findByRole('textbox', { name: 'Title' }), 'Write the docs');
		await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'For the new CLI');
		await userEvent.click(screen.getByRole('button', { name: 'Add to-do' }));
		await waitFor(() => expect(api.createSpaceTodo).toHaveBeenCalledWith('space_1', { title: 'Write the docs', description: 'For the new CLI', attachments: [], threadModel: null, repos: [], runOn: 'sandbox' }));

		await userEvent.click(within(column).getByRole('button', { name: 'Actions for Backlog item' }));
		await userEvent.click(await screen.findByRole('menuitem', { name: 'Hand to the coordinator' }));
		expect(onHandTodo).toHaveBeenCalledExactlyOnceWith('todo_open');

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
				onHandTodo={() => undefined}
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
			expect(api.createSpaceTodo).toHaveBeenCalledWith('space_1', { title: 'Read the log', description: '', attachments: [{ name: 'crash.log', path: 'crash.log', kind: 'Text', size: 5 }], threadModel: null, repos: [], runOn: 'sandbox' }),
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
			return <ProjectBoard space={space} threads={threads} todos={todos} onNewThread={() => undefined} onOpenCoordinator={() => undefined} onHandTodo={() => undefined} />;
		}

		it('edits a to-do without resending its delisted model', async () => {
			const threadModel = { model: 'openrouter/test/delisted#sort=latency', reasoning: 'low' } as const;
			const item = makeTodo({ threadModel });
			api.spaceTodos.mockResolvedValue({ todos: [item] });
			api.editSpaceTodo.mockImplementationOnce(async (_spaceId, _todoId, change) => {
				if (Object.hasOwn(change, 'threadModel')) throw new Error('Unknown model');
				return { ...item, ...change, updatedAt: '2026-10-04T00:00:00Z' };
			});
			renderWithRouter(() => <LiveBoard />);
			await userEvent.click(await screen.findByRole('button', { name: /^Fix OAuth redirect/ }));
			const edit = within(await screen.findByRole('dialog', { name: 'Edit to-do' }));
			const picker = edit.getByRole('button', { name: 'Main thread model' });
			await userEvent.click(picker);
			await userEvent.click(screen.getByRole('textbox', { name: 'Search models' }));
			expect(await screen.findByText('No models match.')).toBeTruthy();
			await userEvent.keyboard('{Escape}');
			expect(picker.textContent).toContain('openrouter/test/delisted');
			const title = edit.getByRole('textbox', { name: 'Title' });
			await userEvent.clear(title);
			await userEvent.type(title, 'Tidy the redirect');
			await userEvent.click(edit.getByRole('button', { name: 'Save' }));
			await waitFor(() => expect(api.editSpaceTodo).toHaveBeenCalledWith('space_1', item.id, { title: 'Tidy the redirect', description: item.description, attachments: [] }));
			await userEvent.click(await screen.findByRole('button', { name: /^Tidy the redirect/ }));
			expect(within(await screen.findByRole('dialog', { name: 'Edit to-do' })).getByRole('button', { name: 'Main thread model' }).textContent).toContain('openrouter/test/delisted');
		});

		it('sets a model and effort when adding a to-do, then reopens and clears the saved choice', async () => {
			const model: ModelInfo = { id: 'openrouter/test/model', name: 'Compact model', vendor: 'Test', description: '', createdAt: 0, contextLength: 128000, maxOutput: null, price: { input: 1, output: 2 }, vision: false, reasoning: ['low', 'high'], defaultReasoning: 'high' };
			api.models.mockResolvedValueOnce({ models: [model], default: model.id });
			renderWithRouter(() => <LiveBoard />);
			await userEvent.click(await screen.findByRole('button', { name: 'New to-do' }));
			await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Pick a model');
			const trigger = screen.getByRole('button', { name: 'Main thread model' });
			expect(trigger.textContent).toContain('Project default');
			await userEvent.click(trigger);
			await userEvent.click(await screen.findByRole('option', { name: /Compact model/ }));
			await userEvent.click(screen.getByRole('radio', { name: 'Low' }));
			await userEvent.keyboard('{Escape}');
			expect(trigger.textContent).toContain('Compact model');
			await userEvent.click(screen.getByRole('button', { name: 'Add to-do' }));
			await waitFor(() => expect(api.createSpaceTodo).toHaveBeenCalledWith('space_1', expect.objectContaining({ threadModel: { model: model.id, reasoning: 'low' } })));
			await userEvent.click(await screen.findByRole('button', { name: /^Pick a model/ }));
			const edit = within(await screen.findByRole('dialog', { name: 'Edit to-do' }));
			expect(edit.getByRole('button', { name: 'Main thread model' }).textContent).toContain('Compact model');
			await userEvent.click(edit.getByRole('button', { name: 'Use project default' }));
			expect(edit.getByRole('button', { name: 'Main thread model' }).textContent).toContain('Project default');
			await userEvent.click(edit.getByRole('button', { name: 'Save' }));
			await waitFor(() => expect(api.editSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_new', expect.objectContaining({ threadModel: null })));
		});

		it('tags a to-do with repositories from its chip, shows them on its card, and clears them back to Anton picking', async () => {
			renderWithRouter(() => <LiveBoard />);
			await userEvent.click(await screen.findByRole('button', { name: 'New to-do' }));
			await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Fix both ends');
			const chip = screen.getByRole('button', { name: 'Repositories: Anton picks' });
			expect(chip.textContent).toContain('Anton picks');
			await userEvent.click(chip);
			// The menu stays open, so several can be ticked; they keep the project's order.
			await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'acme/web' }));
			await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'acme/api' }));
			expect(screen.getByRole('menuitemcheckbox', { name: 'acme/api' }).getAttribute('aria-checked')).toBe('true');
			await userEvent.keyboard('{Escape}');
			expect(screen.getByRole('button', { name: 'Repositories: acme/api, acme/web' }).textContent).toContain('2 repositories');
			await userEvent.click(screen.getByRole('button', { name: 'Add to-do' }));
			await waitFor(() => expect(api.createSpaceTodo).toHaveBeenCalledWith('space_1', expect.objectContaining({ title: 'Fix both ends', repos: ['p1', 'p2'] })));
			const column = await screen.findByRole('region', { name: 'To do' });
			expect(within(column).getByText('api, web')).toBeTruthy();

			await userEvent.click(await screen.findByRole('button', { name: /^Fix both ends/ }));
			const edit = within(await screen.findByRole('dialog', { name: 'Edit to-do' }));
			await userEvent.click(edit.getByRole('button', { name: 'Repositories: acme/api, acme/web' }));
			await userEvent.click(await screen.findByRole('menuitem', { name: 'Let Anton pick' }));
			await userEvent.click(edit.getByRole('button', { name: 'Save' }));
			await waitFor(() => expect(api.editSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_new', expect.objectContaining({ repos: [] })));
		});

		it('lets a to-do choose Run on This server or Sandbox, shows it on the card, and hides the option when host is unavailable', async () => {
			renderWithRouter(() => <LiveBoard />);
			await userEvent.click(await screen.findByRole('button', { name: 'New to-do' }));
			await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Inspect local socket');
			const chip = await screen.findByRole('button', { name: 'Run on: Sandbox' });
			expect(chip.textContent).toContain('Sandbox');
			await userEvent.click(chip);
			expect((await screen.findByRole('menuitemradio', { name: /Sandbox · Modal/ })).getAttribute('aria-checked')).toBe('true');
			expect(screen.getByText(/not isolated from that machine/)).toBeTruthy();
			await userEvent.click(screen.getByRole('menuitemradio', { name: 'This server' }));
			expect(screen.getByRole('button', { name: 'Run on: This server' }).textContent).toContain('This server');
			await userEvent.click(screen.getByRole('button', { name: 'Add to-do' }));
			await waitFor(() => expect(api.createSpaceTodo).toHaveBeenCalledWith('space_1', expect.objectContaining({ title: 'Inspect local socket', runOn: 'host' })));
			const column = await screen.findByRole('region', { name: 'To do' });
			expect(within(column).getByText('This server')).toBeTruthy();

			await userEvent.click(await screen.findByRole('button', { name: /^Inspect local socket/ }));
			const edit = within(await screen.findByRole('dialog', { name: 'Edit to-do' }));
			await userEvent.click(edit.getByRole('button', { name: 'Run on: This server' }));
			await userEvent.click(await screen.findByRole('menuitemradio', { name: /Sandbox · Modal/ }));
			await userEvent.click(edit.getByRole('button', { name: 'Save' }));
			await waitFor(() => expect(api.editSpaceTodo).toHaveBeenCalledWith('space_1', 'todo_new', expect.objectContaining({ runOn: 'sandbox' })));
		});

		it('hides the Run on option when every task already runs locally', async () => {
			api.runners.mockResolvedValue({ sandbox: 'local', host: false });
			renderWithRouter(() => <LiveBoard />);
			await userEvent.click(await screen.findByRole('button', { name: 'New to-do' }));
			await screen.findByRole('textbox', { name: 'Title' });
			await waitFor(() => expect(api.runners).toHaveBeenCalled());
			expect(screen.queryByRole('button', { name: /^Run on:/ })).toBeNull();
		});

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
		renderWithRouter(() => <ProjectBoard space={space} threads={[]} todos={[]} onNewThread={() => undefined} onOpenCoordinator={() => undefined} onHandTodo={() => undefined} />);
		await userEvent.click(await screen.findByRole('button', { name: 'New to-do' }));
		expect(await screen.findByRole('textbox', { name: 'Title' })).toBeTruthy();
	});
});
