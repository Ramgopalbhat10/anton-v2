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
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
const { ThreadChip, ThreadRow, nextSteps } = await import('@/components/thread-card');
const { InlineLinks, Markdown } = await import('@/components/markdown');
const { ProjectSidebarBody } = await import('@/components/project-sidebar');
const { parseReports, groupByState } = await import('@/lib/spaces');
const { StateSplit, countKinds, activity, ProjectPulse } = await import('@/components/project-viz');
const { ProjectRack, bayThreads } = await import('@/components/project-rack');
const { IconPicker, ProjectIcon, parseIcon, suggestIcon } = await import('@/components/project-icon');
const { NewThreadForm, ProjectFeed } = await import('@/components/project-feed');

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

	it('shows the rest of a thread on hover: its state, where it works, what it asks and its next steps', async () => {
		withRouter(() => <ThreadRow thread={{ ...threads[0], prUrl: 'https://github.com/acme/demo/pull/9', pullRequest: { state: 'open', checks: 'pending', runs: [] } }} />);
		const row = await screen.findByRole('article', { name: 'Pick a name' });
		fireEvent.pointerEnter(row, { pointerType: 'mouse' });
		const peek = await screen.findByRole('button', { name: 'Open thread' });
		const card = peek.closest('.in-pop') as HTMLElement;
		expect(within(card).getByText('Waiting on you')).toBeTruthy();
		expect(within(card).getByText(/demo ·/)).toBeTruthy();
		expect(within(card).getByText('Billing or invoices?')).toBeTruthy();
		expect(within(card).getByRole('link', { name: /#9 · checks running/ }).getAttribute('href')).toBe('https://github.com/acme/demo/pull/9');
		expect(within(card).getByRole('button', { name: 'Answer' })).toBeTruthy();
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
		await waitFor(() => expect(api.startThread).toHaveBeenCalledWith('space_1', expect.objectContaining({ brief: 'Compare the pricing pages', projectId: null, planMode: false })));
		await waitFor(() => expect(router.state.location.pathname).toBe('/projects/space_1/threads/new'));
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
		expect(sections).toEqual(['Waiting on you', 'Working', 'Ready for review', 'Resolved']);
		expect(screen.queryByText('Old cleanup')).toBeNull();
		await userEvent.click(within(screen.getByRole('region', { name: 'Resolved' })).getByRole('button'));
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
			'<thread-reports>\n  <thread id="asks1234" title="Pick &quot;a&quot; name" state="waiting" asks="Billing or invoices?"/>\n  <thread id="pr123456" title="Endpoint" state="review">Opened #12 &lt;ok&gt;</thread>\n  <thread id="nightly1" title="Nightly check" state="working" started="routine">Started by the routine that runs every 24 hours.</thread>\n</thread-reports>',
		);
		expect(reports).toEqual([
			{ id: 'asks1234', title: 'Pick "a" name', state: 'waiting', text: 'Billing or invoices?', routine: false },
			{ id: 'pr123456', title: 'Endpoint', state: 'review', text: 'Opened #12 <ok>', routine: false },
			{ id: 'nightly1', title: 'Nightly check', state: 'working', text: 'Started by the routine that runs every 24 hours.', routine: true },
		]);
		expect(parseReports('Just a message')).toBeNull();
		expect(groupByState(threads).map((group) => group.state)).toEqual(['waiting', 'working', 'review', 'resolved']);
	});
});
