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
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
const { ThreadCard, nextSteps } = await import('@/components/thread-card');
const { ProjectSidebarBody } = await import('@/components/project-sidebar');
const { parseReports, groupByState } = await import('@/lib/spaces');
const { StateSplit, countKinds, activity, ProjectPulse } = await import('@/components/project-viz');
const { ProjectRack, bayThreads } = await import('@/components/project-rack');
const { IconPicker, ProjectIcon, parseIcon, suggestIcon } = await import('@/components/project-icon');
const { NewThreadForm } = await import('@/components/project-feed');

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

	it('shows a waiting thread in amber with its question, and sends a step to the thread', async () => {
		const router = withRouter(() => (
			<div>
				<ThreadCard thread={threads[0]} />
				<ThreadCard thread={thread({ id: 'fail', title: 'Flaky', threadState: 'waiting', prUrl: 'https://github.com/acme/demo/pull/3', pullRequest: { state: 'open', checks: 'failed', runs: [] } })} />
			</div>
		));
		const card = await screen.findByRole('article', { name: 'Pick a name' });
		expect(card.className).toContain('--warning-border');
		expect(within(card).getByText('Billing or invoices?')).toBeTruthy();
		expect(within(card).getByText('Waiting on you')).toBeTruthy();

		const failing = screen.getByRole('article', { name: 'Flaky' });
		expect(within(failing).getByText('Checks failing')).toBeTruthy();
		await userEvent.click(within(failing).getByRole('button', { name: 'Fix CI' }));
		expect(api.nudgeThread).toHaveBeenCalledWith('space_1', 'fail', expect.stringContaining('Checks are failing'));
		expect(router.state.location.pathname).toBe('/projects/space_1');

		await userEvent.click(card);
		await waitFor(() => expect(router.state.location.pathname).toBe('/projects/space_1/threads/asks'));
	});

	it('starts a project without repositories on threads with none, named as chats', async () => {
		const bare: Space = { ...space, repoIds: [], repos: [] };
		const router = withRouter(() => (
			<div>
				<ThreadCard thread={thread({ id: 'chat', title: 'Compare vendors', projectId: null, repo: '' })} />
				<NewThreadForm space={bare} onDone={() => {}} />
			</div>
		));
		const card = await screen.findByRole('article', { name: 'Compare vendors' });
		expect(within(card).getByText('Chat')).toBeTruthy();
		expect(screen.getByRole('button', { name: /No repository/ })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Plan/ })).toBeNull();
		await userEvent.type(screen.getByRole('textbox', { name: /works without a repository/ }), 'Compare the pricing pages');
		await userEvent.click(screen.getByRole('button', { name: 'Start thread' }));
		await waitFor(() => expect(api.startThread).toHaveBeenCalledWith('space_1', expect.objectContaining({ brief: 'Compare the pricing pages', projectId: null, planMode: false })));
		await waitFor(() => expect(router.state.location.pathname).toBe('/projects/space_1/threads/new'));
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
				<ThreadCard thread={threads[1]} />
				<ThreadCard thread={failing} />
				<StateSplit threads={[...threads, failing]} />
			</div>
		));
		const working = await screen.findByRole('article', { name: 'Add the table' });
		expect(working.querySelector('[data-glyph="working"]')).toBeTruthy();
		expect(screen.getByRole('article', { name: failing.title }).querySelector('[data-glyph="failed"]')).toBeTruthy();
		expect(screen.getByRole('img', { name: '1 failed, 1 needs you, 1 working, 1 review, 1 done' })).toBeTruthy();
	});

	it('says an idle thread’s state once and drops an empty footer; the Pulse says what the project comes to', async () => {
		const idle = thread({ id: 'idle', title: 'Explore the repo', lastReply: 'I have a thorough picture now.' });
		withRouter(() => (
			<div>
				<ThreadCard thread={idle} />
				<ProjectPulse space={space} threads={[idle, ...threads]} />
			</div>
		));
		const card = await screen.findByRole('article', { name: 'Explore the repo' });
		expect(within(card).getAllByText(/idle/i)).toHaveLength(1);
		expect(card.querySelector('footer')).toBeNull();
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
			'<thread-reports>\n  <thread id="asks1234" title="Pick &quot;a&quot; name" state="waiting" asks="Billing or invoices?"/>\n  <thread id="pr123456" title="Endpoint" state="review">Opened #12 &lt;ok&gt;</thread>\n</thread-reports>',
		);
		expect(reports).toEqual([
			{ id: 'asks1234', title: 'Pick "a" name', state: 'waiting', text: 'Billing or invoices?' },
			{ id: 'pr123456', title: 'Endpoint', state: 'review', text: 'Opened #12 <ok>' },
		]);
		expect(parseReports('Just a message')).toBeNull();
		expect(groupByState(threads).map((group) => group.state)).toEqual(['waiting', 'working', 'review', 'resolved']);
	});
});
