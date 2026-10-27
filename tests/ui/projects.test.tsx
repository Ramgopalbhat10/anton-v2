import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Space } from '@/lib/api';
import { session } from './render';

const api = vi.hoisted(() => ({
	sessions: vi.fn(),
	spaces: vi.fn(),
	nudgeThread: vi.fn(async () => ({})),
	stopAgent: vi.fn(async () => undefined),
	models: vi.fn(async () => ({ models: [], default: 'openrouter/test/cheap' })),
	startThread: vi.fn(async () => ({ id: 'new' })),
	attachToProject: vi.fn(),
	budget: vi.fn(async () => ({ limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null })),
	commands: vi.fn(async () => ({ commands: [] })),
	todos: vi.fn(async (_id: string) => ({ list: null as { todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>; updatedAt: string } | null })),
	now: vi.fn(async (_id: string) => ({ now: null })),
	outputs: vi.fn(async (_id: string) => ({ source: 'saved', at: null, outputs: [] as Array<{ path: string; size: number; mtimeMs: number }> })),
	spaceUsage: vi.fn(),
	spaceAutomations: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
const { ThreadChip, ThreadRow, nextSteps } = await import('@/components/thread-card');
const { InlineLinks, Markdown } = await import('@/components/markdown');
const { ProjectSidebarBody } = await import('@/components/project-sidebar');
const { parseReports, groupByState } = await import('@/lib/spaces');
const { StateSplit, countKinds, activity, ProjectPulse, BurnCard, ticks, tickLabel } = await import('@/components/project-viz');
const { ProjectPanel } = await import('@/components/project-panel');
const { ProjectRack, bayThreads } = await import('@/components/project-rack');
const { IconPicker, ProjectIcon, parseIcon, suggestIcon } = await import('@/components/project-icon');
const { NewThreadForm, ProjectFeed } = await import('@/components/project-feed');
const { OutputViewerHost } = await import('@/components/output-viewer');

const thread = (patch: Partial<Session>): Session => session({ spaceId: 'space_1', threadState: 'idle', ...patch });

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
	maxParallel: 3,
	autonomy: 'start',
	state: 'active',
	repoIds: ['p1'],
	repos: [{ id: 'p1', repoFullName: 'acme/demo', defaultBranch: 'main' }],
	counts: { waiting: 1, working: 1, queued: 0, review: 1, landing: 0, idle: 0, resolved: 1 },
	threads: 4,
	activeAt: '2026-10-03T00:00:00Z',
	createdAt: '2026-10-01T00:00:00Z',
	updatedAt: '2026-10-03T00:00:00Z',
};

const threads = [
	thread({ id: 'asks', title: 'Pick a name', threadState: 'waiting', asking: 'Billing or invoices?' }),
	thread({ id: 'runs', title: 'Add the table', threadState: 'working', working: true, status: 'running' }),
	thread({
		id: 'pr',
		title: 'Add the endpoint',
		threadState: 'review',
		prUrl: 'https://github.com/acme/demo/pull/12',
		pullRequest: { state: 'open', checks: 'passed', runs: [] },
	}),
	thread({ id: 'done', title: 'Old cleanup', threadState: 'resolved', resolvedAt: '2026-10-02T00:00:00Z' }),
];

/** Renders inside a router with the project's routes, starting at `path`. */
function withRouter(ui: () => ReactNode, path = '/projects/space_1') {
	const root = createRootRoute({ component: ui });
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/projects', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/projects/$spaceId', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/projects/$spaceId/settings', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/projects/$spaceId/threads/$threadId', component: () => null }),
		createRoute({ getParentRoute: () => root, path: '/agents/$sessionId', component: () => null }),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
}

describe('threads', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.sessions.mockResolvedValue({ sessions: threads });
		api.spaces.mockResolvedValue({ spaces: [space] });
	});

	it('offers the next step each state calls for', () => {
		expect(nextSteps(threads[0]).map((step) => step.label)).toEqual(['Answer']);
		expect(nextSteps(threads[1]).map((step) => step.label)).toEqual(['Stop']);
		expect(nextSteps(threads[2]).map((step) => step.label)).toEqual(['Review', 'PR']);
		expect(nextSteps(thread({ status: 'error', threadState: 'waiting' })).map((step) => step.label)).toEqual(['Try again']);
		expect(
			nextSteps(thread({ threadState: 'waiting', prUrl: 'https://github.com/acme/demo/pull/3', pullRequest: { state: 'open', checks: 'failed', runs: [] } })).map((step) => step.label),
		).toEqual(['Fix CI']);
		expect(nextSteps(thread({ threadState: 'queued', brief: 'Later' }))).toEqual([]);
	});

	it('shows a thread on one line with its chips, a waiting one with its question, and sends a step to the thread', async () => {
		const router = withRouter(() => (
			<div>
				<ThreadRow thread={threads[0]} />
				<ThreadRow thread={threads[2]} />
				<ThreadRow thread={thread({ id: 'fail', title: 'Flaky', threadState: 'waiting', prUrl: 'https://github.com/acme/demo/pull/3', pullRequest: { state: 'open', checks: 'failed', runs: [] } })} />
			</div>
		));
		const row = await screen.findByRole('article', { name: 'Pick a name' });
		expect(within(row).getByText('Billing or invoices?')).toBeTruthy();
		expect(within(row).getByText('Needs you')).toBeTruthy();

		// A pull request is a chip; its checks say themselves in its colour, not as another word.
		const ready = screen.getByRole('article', { name: 'Add the endpoint' });
		expect(within(ready).getByTitle('#12 · checks pass').textContent).toBe('#12');
		const failing = screen.getByRole('article', { name: 'Flaky' });
		expect(within(failing).getByTitle('#3 · checks failing').className).toContain('--danger-text');
		expect(within(failing).queryByText('Needs you')).toBeNull();
		await userEvent.click(within(failing).getByRole('button', { name: 'Fix CI' }));
		expect(api.nudgeThread).toHaveBeenCalledWith('space_1', 'fail', expect.stringContaining('Checks are failing'));
		expect(router.state.location.pathname).toBe('/projects/space_1');

		await userEvent.click(row);
		await waitFor(() => expect(router.state.location.pathname).toBe('/projects/space_1/threads/asks'));
	});

	it('follows a working thread live with the step it is on, and opens a thread that asks something of you into a card with its buttons', async () => {
		let todos = [
			{ content: 'Read the billing schema', status: 'completed' as const },
			{ content: 'Add the invoices table', status: 'in_progress' as const },
			{ content: 'Write the migration test', status: 'pending' as const },
		];
		api.todos.mockImplementation(async () => ({ list: { todos, updatedAt: '2026-10-03T00:00:00Z' } }));
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const root = createRootRoute({
			component: () => (
				<div>
					<ThreadRow thread={threads[1]} />
					<ThreadRow thread={threads[2]} />
					<ThreadRow thread={threads[3]} />
				</div>
			),
		});
		const tree = root.addChildren([createRoute({ getParentRoute: () => root, path: '/projects/$spaceId/threads/$threadId', component: () => null })]);
		const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/'] }) });
		render(
			<QueryClientProvider client={client}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		);
		const working = await screen.findByRole('article', { name: 'Add the table' });
		expect(await within(working).findByText('Add the invoices table')).toBeTruthy();
		expect(within(working).getByTitle('1 of 3 steps done').textContent).toBe('1/3');
		// Only a working thread asks for its list.
		expect(api.todos).toHaveBeenCalledTimes(1);
		expect(api.todos).toHaveBeenCalledWith('runs');

		// The agent ticks a step off: the live update refetches the list, and the card moves on.
		todos = todos.map((todo, index) => ({ ...todo, status: index < 2 ? 'completed' : index === 2 ? 'in_progress' : todo.status }) as (typeof todos)[number]);
		await client.invalidateQueries({ queryKey: ['todos', 'runs'] });
		expect(await within(working).findByText('Write the migration test')).toBeTruthy();
		expect(within(working).getByTitle('2 of 3 steps done')).toBeTruthy();
		expect(within(working).queryByRole('button')).toBeNull();

		// A finished thread keeps to one line with what it last said; one ready for review opens out with its buttons.
		const done = screen.getByRole('article', { name: 'Old cleanup' });
		expect(within(done).queryByRole('button')).toBeNull();
		const ready = screen.getByRole('article', { name: 'Add the endpoint' });
		expect(within(ready).getByRole('button', { name: 'Review' })).toBeTruthy();
		await userEvent.click(within(ready).getByRole('button', { name: 'View thread' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/projects/space_1/threads/pr'));
	});

	it('shows the rest of a thread on hover: its state, where it works, what it asks and its next steps', async () => {
		withRouter(() => <ThreadRow thread={{ ...threads[0], prUrl: 'https://github.com/acme/demo/pull/9', pullRequest: { state: 'open', checks: 'pending', runs: [] } }} />);
		const row = await screen.findByRole('article', { name: 'Pick a name' });
		fireEvent.pointerEnter(row, { pointerType: 'mouse' });
		const peek = await screen.findByRole('button', { name: 'Open thread' });
		const card = peek.closest('.in-pop') as HTMLElement;
		// The glyph says the state; no chip repeats it.
		expect(within(card).getByRole('img', { name: 'Waiting on you' })).toBeTruthy();
		expect(within(card).getByText('demo')).toBeTruthy();
		expect(within(card).getByText('Billing or invoices?')).toBeTruthy();
		expect(within(card).getByRole('link', { name: /#9 · checks running/ }).getAttribute('href')).toBe('https://github.com/acme/demo/pull/9');
		expect(within(card).getByRole('button', { name: 'Answer' })).toBeTruthy();
		// Opening the thread is the peek's primary button.
		expect(peek.className).toContain('sg-btn--primary');
	});

	it('shows what a thread made as chips: its newest file with a peek, and +N listing the rest, each opening beside the chat', async () => {
		api.outputs.mockImplementation(async (id: string) => ({
			source: 'saved',
			at: null,
			outputs:
				id === 'pr'
					? [
							{ path: 'uploads/brief.pdf', size: 10, mtimeMs: 5 },
							{ path: 'stream-architecture.svg', size: 1754, mtimeMs: 3 },
							{ path: 'screenshots/home-1.png', size: 34843, mtimeMs: 4 },
							{ path: 'reports/notes.md', size: 900, mtimeMs: 1 },
						]
					: [],
		}));
		const router = withRouter(() => (
			<>
				<ThreadRow thread={threads[2]} />
				<OutputViewerHost />
			</>
		));
		// The newest first; files you attached are not the thread's.
		const chip = await screen.findByRole('button', { name: 'Open home-1.png' });
		const more = screen.getByRole('button', { name: '2 more files' });
		expect(more.textContent).toBe('+2');
		expect(screen.getByText('#12')).toBeTruthy();
		fireEvent.pointerEnter(more, { pointerType: 'mouse' });
		expect(await screen.findByText('stream-architecture.svg')).toBeTruthy();
		expect(screen.getByText('notes.md')).toBeTruthy();
		// Just the files: no sizes, no counts, no directions.
		expect(screen.queryByText(/KB|from this thread/)).toBeNull();
		await userEvent.click(chip);
		const viewer = await screen.findByRole('complementary', { name: 'Viewing home-1.png' });
		expect(within(viewer).getByText('1 of 3')).toBeTruthy();
		// The row stays where it is: the file opens beside the chat.
		expect(router.state.location.pathname).toBe('/projects/space_1');
	});

	it('lists what a thread made in its peek, beside the button that opens it', async () => {
		api.outputs.mockImplementation(async (id: string) => ({
			source: 'saved',
			at: null,
			outputs: id === 'pr' ? ['a.png', 'b.md', 'c.svg', 'd.csv', 'e.txt', 'f.json'].map((path, index) => ({ path, size: 10, mtimeMs: 10 - index })) : [],
		}));
		withRouter(() => (
			<>
				<ThreadRow thread={threads[2]} />
				<OutputViewerHost />
			</>
		));
		const row = await screen.findByRole('article', { name: 'Add the endpoint' });
		fireEvent.pointerEnter(row, { pointerType: 'mouse' });
		const files = await screen.findByRole('list', { name: 'Files' });
		const card = files.closest('.in-pop') as HTMLElement;
		// Next steps take some of the room: a tile for the newest, then the rest as +N.
		await waitFor(() => expect(within(files).getAllByRole('button').map((tile) => tile.getAttribute('aria-label'))).toEqual(['Open a.png', '5 more files']));
		expect(within(card).getByRole('button', { name: 'Open thread' }).className).toContain('sg-btn--primary');
		await userEvent.click(within(files).getByRole('button', { name: '5 more files' }));
		expect(await screen.findByRole('complementary', { name: 'Viewing b.md' })).toBeTruthy();
	});

	it('opens a file the coordinator passes on from a thread, by the thread or by the path the thread gave', async () => {
		api.outputs.mockImplementation(async (id: string) => ({ source: 'saved', at: null, outputs: id === 'pr' ? [{ path: 'diagram.png', size: 10, mtimeMs: 1 }] : [] }));
		const text = 'Ready: [the diagram](../outputs/diagram.png) and [its notes](#thread-runs/outputs/notes.md).';
		const agent = { messages: [{ id: 'm1', role: 'assistant', display: 'visible', parts: [{ type: 'text', text }] }], status: 'idle', historyReady: true, settlements: [], sendMessage: vi.fn(), refresh: () => {} };
		withRouter(() => (
			<>
				<ProjectFeed space={space} agent={agent as never} threads={threads} starting={false} onStartingChange={() => {}} />
				<OutputViewerHost />
			</>
		));
		await waitFor(() => expect(screen.getByRole('link', { name: 'the diagram' }).getAttribute('href')).toBe('/api/sessions/pr/output?path=diagram.png'));
		expect(screen.getByRole('link', { name: 'its notes' }).getAttribute('href')).toBe('/api/sessions/runs/output?path=notes.md');
		const cards = within(screen.getByRole('list', { name: 'Files from this reply' })).getAllByRole('listitem');
		expect(cards).toHaveLength(2);
		await userEvent.click(screen.getByRole('link', { name: 'the diagram' }));
		expect(await screen.findByRole('complementary', { name: 'Viewing diagram.png' })).toBeTruthy();
	});

	it('draws a thread named in a reply as a chip that opens it', async () => {
		const router = withRouter(() => (
			<InlineLinks.Provider value={(href, children) => (href === '#thread-asks' ? <ThreadChip thread={threads[0]}>{children}</ThreadChip> : null)}>
				<Markdown text="Waiting on [Pick a name](#thread-asks) before the rest; see [docs](https://example.com)." />
			</InlineLinks.Provider>
		));
		const chip = await screen.findByRole('button', { name: 'Pick a name' });
		expect(chip.querySelector('[data-glyph="waiting"]')).toBeTruthy();
		expect(screen.getByRole('link', { name: 'docs' }).getAttribute('href')).toBe('https://example.com');
		await userEvent.click(chip);
		await waitFor(() => expect(router.state.location.pathname).toBe('/projects/space_1/threads/asks'));
	});

	it('starts a project without repositories on threads with none, named as chats', async () => {
		const bare: Space = { ...space, repoIds: [], repos: [] };
		const router = withRouter(() => (
			<div>
				<ThreadRow thread={thread({ id: 'chat', title: 'Compare vendors', projectId: null, repo: '' })} />
				<NewThreadForm space={bare} onDone={() => {}} />
			</div>
		));
		expect(await screen.findByRole('article', { name: 'Compare vendors' })).toBeTruthy();
		expect(screen.getByRole('button', { name: /No repository/ })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Plan/ })).toBeNull();
		await userEvent.type(screen.getByRole('textbox', { name: /works without a repository/ }), 'Compare the pricing pages');
		await userEvent.click(screen.getByRole('button', { name: 'Start thread' }));
		// It opens at once, by the id the page chose, while the server makes it.
		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/space_1\/threads\/[0-9a-f-]{36}$/));
		const id = router.state.location.pathname.split('/').pop();
		await waitFor(() => expect(api.startThread).toHaveBeenCalledWith('space_1', expect.objectContaining({ id, brief: 'Compare the pricing pages', projectId: null, planMode: false })));
	});

	it('attaches files to the coordinator: saved to the project Library and sent with what they say', async () => {
		const sendMessage = vi.fn(async () => undefined);
		const agent = { messages: [], status: 'idle', historyReady: true, error: undefined, failedSends: [], settlements: [], sendMessage, refresh: () => {} };
		withRouter(() => <ProjectFeed space={space} agent={agent as never} threads={[]} starting={false} onStartingChange={() => {}} />);
		const box = await screen.findByRole('textbox', { name: /Tell the coordinator/ });
		fireEvent.paste(box, { clipboardData: { files: [new File(['%PDF'], 'brief.pdf', { type: 'application/pdf' })], getData: () => '' } });
		expect(await screen.findByText('brief.pdf')).toBeTruthy();
		api.attachToProject.mockResolvedValueOnce({ name: 'brief.pdf', path: 'brief.pdf', size: 4, kind: 'PDF', text: 'Ship in May.', cut: null });
		await userEvent.type(box, 'Plan this{Enter}');
		await waitFor(() => expect(sendMessage).toHaveBeenCalled());
		expect(api.attachToProject).toHaveBeenCalledWith('space_1', expect.any(File));
		expect(sendMessage).toHaveBeenCalledWith('Plan this\n\n<attachment name="brief.pdf" path="brief.pdf" kind="PDF" size="4" library="project">\nShip in May.\n</attachment>');
	});

	it('saves a new thread’s attached files, images too, to the project Library and puts them in its brief', async () => {
		withRouter(() => <NewThreadForm space={space} onDone={() => {}} />);
		const box = await screen.findByRole('textbox', { name: /What should this thread do/ });
		fireEvent.paste(box, { clipboardData: { files: [new File(['png'], 'mock.png', { type: 'image/png' })], getData: () => '' } });
		expect(await screen.findByText('mock.png')).toBeTruthy();
		api.attachToProject.mockResolvedValueOnce({ name: 'mock.png', path: 'mock.png', size: 3, kind: 'PNG image', text: null, cut: null });
		await userEvent.type(box, 'Build this screen');
		await userEvent.click(screen.getByRole('button', { name: 'Start thread' }));
		await waitFor(() => expect(api.startThread).toHaveBeenCalled());
		const brief = (api.startThread.mock.calls[0] as unknown as [string, { brief: string }])[1].brief;
		expect(brief).toMatch(/^Build this screen\n\n<attachment name="mock\.png" path="mock\.png" kind="PNG image" size="3" library="project">/);
	});

	it('lists threads in the project sidebar by state, needs-you first, done folded', async () => {
		withRouter(() => <ProjectSidebarBody spaceId="space_1" onNavigate={() => {}} />);
		await screen.findByText('Pick a name');
		const sections = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
		expect(sections).toEqual(['Waiting on you', 'Working', 'Ready for review', 'Done']);
		expect(screen.queryByText('Old cleanup')).toBeNull();
		await userEvent.click(within(screen.getByRole('region', { name: 'Done' })).getByRole('button'));
		expect(screen.getByText('Old cleanup')).toBeTruthy();
		expect(screen.getByRole('link', { name: /Coordinator/ }).getAttribute('aria-current')).toBe('page');
	});

	it('draws each state as its own glyph, and the project as a split by state', async () => {
		const failing = thread({ id: 'ci', threadState: 'waiting', prUrl: 'https://github.com/acme/demo/pull/3', pullRequest: { state: 'open', checks: 'failed', runs: [] } });
		expect(countKinds([...threads, failing])).toMatchObject({ waiting: 1, failed: 1, working: 1, review: 1, resolved: 1, queued: 0 });
		withRouter(() => (
			<div>
				<ThreadRow thread={threads[1]} />
				<ThreadRow thread={failing} />
				<StateSplit threads={[...threads, failing]} />
			</div>
		));
		const working = await screen.findByRole('article', { name: 'Add the table' });
		expect(working.querySelector('[data-glyph="working"]')).toBeTruthy();
		expect(screen.getByRole('article', { name: failing.title }).querySelector('[data-glyph="failed"]')).toBeTruthy();
		expect(screen.getByRole('img', { name: '1 failed, 1 needs you, 1 working, 1 review, 1 done' })).toBeTruthy();
	});

	it('leaves an idle thread’s state to its glyph; the Pulse says what the project comes to', async () => {
		const idle = thread({ id: 'idle', title: 'Explore the repo', lastReply: 'I have a thorough picture now.' });
		withRouter(() => (
			<div>
				<ThreadRow thread={idle} />
				<ProjectPulse space={space} threads={[idle, ...threads]} />
			</div>
		));
		const row = await screen.findByRole('article', { name: 'Explore the repo' });
		expect(within(row).queryByText(/idle/i)).toBeNull();
		expect(row.querySelector('[data-glyph="idle"]')).toBeTruthy();
		expect(screen.getByText('1 thread needs you')).toBeTruthy();
	});

	it('racks each project as a bay of its threads, and draws a thread out with what it asks', async () => {
		expect(bayThreads(threads).map((item) => item.id)).toEqual(['asks', 'runs', 'pr', 'done']);
		withRouter(() => <ProjectRack spaces={[space]} threads={threads} />);
		expect(await screen.findByRole('group', { name: '1 projects as bays, their threads as blades' })).toBeTruthy();
		expect(screen.getByRole('link', { name: /Billing/ })).toBeTruthy();
		fireEvent.focus(screen.getByRole('link', { name: 'Pick a name, Needs you' }));
		const card = await screen.findByRole('dialog', { name: 'Pick a name' });
		expect(within(card).getByText('Asks you')).toBeTruthy();
		expect(within(card).getByText('Billing or invoices?')).toBeTruthy();
		await userEvent.type(within(card).getByRole('textbox', { name: 'Send a follow-up to Pick a name' }), 'Invoices');
		await userEvent.click(within(card).getByRole('button', { name: 'Send to this thread' }));
		expect(api.nudgeThread).toHaveBeenCalledWith('space_1', 'asks', 'Invoices');
	});

	it('marks a project with a drawn icon picked from the list, never an emoji', async () => {
		expect(parseIcon('rocket:violet')).toMatchObject({ entry: { key: 'rocket' }, tint: 'violet' });
		expect(parseIcon('book-open')).toMatchObject({ tint: 'cyan' });
		expect(parseIcon('🚀')).toBeNull();
		expect(suggestIcon('Docs refresh')).toBe('book-open');
		expect(suggestIcon('Zzz')).toBe('folder');
		const { container } = render(<ProjectIcon value="🚀" name="Release" />);
		expect(container.textContent).toBe('R');
		const onChange = vi.fn();
		render(<IconPicker value="folder" name="Billing" onChange={onChange} />);
		await userEvent.click(screen.getByRole('button', { name: /Change icon/ }));
		await userEvent.type(screen.getByRole('textbox', { name: 'Search icons' }), 'billing');
		const options = within(screen.getByRole('listbox', { name: 'Icons' })).getAllByRole('option');
		expect(options.map((option) => option.getAttribute('aria-label'))).toContain('Card');
		await userEvent.click(screen.getByRole('option', { name: 'Card' }));
		expect(onChange).toHaveBeenLastCalledWith('credit-card');
	});

	it('bins recent activity, the current stretch last', () => {
		const now = Date.parse('2026-10-03T12:00:00Z');
		const recent = [thread({ createdAt: '2026-10-03T10:00:00Z', lastInputAt: '2026-10-03T11:59:00Z' })];
		const { bars, total } = activity(recent, now, 12);
		expect(total).toBe(2);
		expect(bars[0]).toBe(1);
		expect(bars[11]).toBe(1);
	});

	it('reads thread reports back out of the coordinator message', () => {
		const reports = parseReports(
			'<thread-reports>\n  <thread id="asks1234" title="Pick &quot;a&quot; name" state="waiting" asks="Billing or invoices?"/>\n  <thread id="pr123456" title="Endpoint" state="review">Opened #12 &lt;ok&gt;</thread>\n  <thread id="nightly1" title="Nightly check" state="working" started="routine">Started by the routine that runs every 24 hours.</thread>\n  <thread id="mine1234" title="API keys" state="working" started="you">Add API key auth.</thread>\n</thread-reports>',
		);
		expect(reports).toEqual([
			{ id: 'asks1234', title: 'Pick "a" name', state: 'waiting', text: 'Billing or invoices?', started: null },
			{ id: 'pr123456', title: 'Endpoint', state: 'review', text: 'Opened #12 <ok>', started: null },
			{ id: 'nightly1', title: 'Nightly check', state: 'working', text: 'Started by the routine that runs every 24 hours.', started: 'routine' },
			{ id: 'mine1234', title: 'API keys', state: 'working', text: 'Add API key auth.', started: 'you' },
		]);
		expect(parseReports('Just a message')).toBeNull();
		expect(groupByState(threads).map((group) => group.state)).toEqual(['waiting', 'working', 'review', 'resolved']);
	});
});

describe('project overview numbers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.sessions.mockResolvedValue({ sessions: threads });
		api.spaces.mockResolvedValue({ spaces: [space] });
	});

	it('labels a schedule of days by date and one of hours by time', () => {
		const start = new Date(2026, 9, 16, 9).getTime();
		const week = ticks(start, start + 7 * 24 * 3600_000);
		expect(week.steps.map((at) => tickLabel(at, week.step))).toEqual(['Oct 18', 'Oct 20', 'Oct 22']);
		const hours = ticks(start, start + 3 * 3600_000);
		expect(hours.steps.map((at) => tickLabel(at, hours.step))).toEqual(['09:00', '10:00', '11:00', '12:00']);
		// A tick on midnight names the day it starts.
		const night = ticks(new Date(2026, 9, 16, 21).getTime(), new Date(2026, 9, 17, 3).getTime());
		expect(night.steps.map((at) => tickLabel(at, night.step))).toContain('Oct 17');
	});

	it('measures a project that spends next to nothing in tokens, and keeps each routine run’s day in view', async () => {
		api.spaceUsage.mockResolvedValue({
			today: 0,
			month: 0.004,
			byThread: [
				{ id: 'a', title: 'Daily tech and AI news roundup · Oct 21', tokens: 820_000, cost: 0.0004 },
				{ id: 'b', title: 'Daily tech and AI news roundup · Oct 22', tokens: 860_000, cost: 0.0004 },
			],
			byModel: [],
			daily: [],
		});
		withRouter(() => <BurnCard space={space} />);
		expect(await screen.findByText('1.7M')).toBeTruthy();
		expect(screen.getByText('tokens · $0.004 spent')).toBeTruthy();
		expect(screen.getByText('860K')).toBeTruthy();
		// The newest roundup ranks first by tokens; each keeps its day beside the cut title.
		expect(screen.getAllByText(/^· Oct 2[12]$/).map((day) => day.textContent)).toEqual(['· Oct 22', '· Oct 21']);
	});

	it('leads with dollars once a project spends real money', async () => {
		api.spaceUsage.mockResolvedValue({ today: 0.5, month: 2.4, byThread: [{ id: 'a', title: 'Big refactor', tokens: 3_000_000, cost: 2.4 }], byModel: [], daily: [] });
		withRouter(() => <BurnCard space={space} />);
		expect(await screen.findByText('$2.40', { selector: '.in-figure' })).toBeTruthy();
		expect(screen.getAllByText('3M tok')).toHaveLength(2);
	});

	it('shows each routine’s recent runs as a strip in their states, and when it runs next', async () => {
		const day = 24 * 3600_000;
		const runs = [0, 1, 2].map((index) =>
			thread({ id: `run-${index}`, title: `Morning briefing · Oct ${20 + index}`, automationId: 'r1', createdAt: new Date(Date.now() - (3 - index) * day).toISOString(), threadState: index === 1 ? 'waiting' : 'resolved', status: index === 1 ? 'error' : 'stopped' }),
		);
		api.spaceAutomations.mockResolvedValue({
			automations: [
				{
					id: 'r1',
					projectId: '',
					kind: 'schedule',
					label: null,
					schedule: { frequency: 'daily', time: '09:00', everyHours: 6, days: [1], dayOfMonth: 1, cron: '', timeZone: 'UTC' },
					nextRunAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
					prompt: 'Brief me',
					model: null,
					reasoning: null,
					planFirst: false,
					enabled: true,
					lastRunAt: new Date(Date.now() - 3600_000).toISOString(),
					lastError: null,
					seen: [],
					createdAt: '2026-10-01T00:00:00Z',
				},
			],
		});
		withRouter(() => <ProjectPanel space={{ ...space, repos: [] }} threads={[...runs, ...threads]} tab="Routines" onTab={() => {}} expanded={false} onToggleExpanded={() => {}} onClose={() => {}} />);
		const strip = await screen.findByRole('group', { name: 'Recent runs' });
		expect(within(strip).getAllByRole('button').map((cell) => cell.getAttribute('aria-label'))).toEqual(['Morning briefing · Oct 20: Done', 'Morning briefing · Oct 21: Failed', 'Morning briefing · Oct 22: Done']);
		expect(screen.getByText('1h ago')).toBeTruthy();
		expect(screen.getByText('in 5h')).toBeTruthy();
		expect(screen.getByText('no repository')).toBeTruthy();
		expect(screen.getByText('Daily')).toBeTruthy();
		// Named by its runs' title once it has one, else by what it does; the instructions fold open under it.
		expect(screen.getByRole('button', { name: 'Brief me' }).getAttribute('aria-expanded')).toBe('false');
		await userEvent.click(screen.getByRole('button', { name: 'Brief me' }));
		expect(screen.getAllByText('Brief me')).toHaveLength(2);
	});
});
