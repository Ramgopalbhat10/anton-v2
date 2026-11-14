import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@/lib/api';

const api = vi.hoisted(() => ({
	artifacts: vi.fn(),
	session: vi.fn(async () => ({ id: 's1', title: 'Budget task', spaceId: null })),
	outputText: vi.fn(async () => '# Findings\n\nAll good.'),
	outputs: vi.fn(async () => ({ source: 'saved', at: null, outputs: [], deleted: [] as string[] })),
	deleteOutput: vi.fn(async () => undefined),
	plugins: vi.fn(async () => ({ plugins: [], marketplaces: [] })),
	downloadArtifacts: vi.fn(async () => new Blob(['zip'], { type: 'application/zip' })),
	addArtifact: vi.fn(async () => ({ path: 'SKILL.md', sessionId: 'added-files' })),
	installAddedSkill: vi.fn(async (path: string) => ({
		plugins: [{ id: 'p1', name: 'day-trading', source: { repo: 'added-files', path, ref: null }, skills: [{ name: 'day-trading', description: '', active: true }] }],
	})),
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

function open(path: string, items = listed, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
	api.artifacts.mockResolvedValue({ artifacts: items });
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
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
}

describe('Artifacts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.outputText.mockResolvedValue('# Findings\n\nAll good.');
		api.deleteOutput.mockImplementation(async () => undefined);
		api.downloadArtifacts.mockImplementation(async () => new Blob(['zip'], { type: 'application/zip' }));
		api.outputs.mockResolvedValue({ source: 'saved', at: null, outputs: [], deleted: [] });
	});
	afterEach(() => vi.unstubAllGlobals());

	it('never runs apps in the gallery, even when their cards intersect', async () => {
		const callbacks: IntersectionObserverCallback[] = [];
		vi.stubGlobal('IntersectionObserver', class {
			constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
			observe() {} disconnect() {}
		});
		open('/artifacts');
		await screen.findByText('Budget planner');
		const { act } = await import('@testing-library/react');
		act(() => callbacks.forEach((cb) => cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)));
		expect(document.querySelectorAll('iframe').length).toBe(0);
		expect(document.querySelector('[data-preview="app"]')).toBeTruthy();
		expect(api.outputText).not.toHaveBeenCalledWith('s1', 'renders/budget-planner-a1b2c3.html');
	});

	it('releases off-screen image and snippet previews, and leaves large images for the detail view', async () => {
		const callbacks: IntersectionObserverCallback[] = [];
		vi.stubGlobal('IntersectionObserver', class {
			constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
			observe() {} disconnect() {}
		});
		const big = artifact({ path: 'huge.png', title: 'Huge image', size: 3 * 1024 * 1024 });
		open('/artifacts', [...listed, big]);
		await screen.findByText('Huge image');
		expect(document.querySelectorAll('img').length).toBe(0);
		const { act } = await import('@testing-library/react');
		act(() => callbacks.forEach((cb) => cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)));
		await waitFor(() => expect(api.outputText).toHaveBeenCalledWith('s1', 'reports/findings.md'));
		expect(document.querySelectorAll('img').length).toBe(1);
		act(() => callbacks.forEach((cb) => cb([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver)));
		expect(document.querySelectorAll('img, pre').length).toBe(0);
	});

	it('keeps snippet data separate so opening a previewed document still fetches its full contents', async () => {
		const callbacks: IntersectionObserverCallback[] = [];
		vi.stubGlobal('IntersectionObserver', class {
			constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
			observe() {} disconnect() {}
		});
		api.outputText.mockResolvedValue(`# Findings\n\n${'word '.repeat(400)}\n\nEND OF DOCUMENT`);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		open('/artifacts', [listed[1]], client);
		await screen.findByText('findings.md');
		const { act } = await import('@testing-library/react');
		act(() => callbacks.forEach((cb) => cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)));
		await waitFor(() => expect(client.getQueryData(['artifact-snippet', 's1', 'reports/findings.md'])).toBeDefined());
		expect(screen.queryByText('END OF DOCUMENT')).toBeNull();
		expect(client.getQueryData(['output', 's1', 'reports/findings.md'])).toBeUndefined();
		await userEvent.click(screen.getByRole('link', { name: 'findings.md, document from Budget task' }));
		expect(await screen.findByText('END OF DOCUMENT')).toBeTruthy();
	});

	it('disables selection and conflicting bulk actions while a download is pending', async () => {
		let reject!: (error: Error) => void;
		api.downloadArtifacts.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
		open('/artifacts');
		await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
		await userEvent.click(screen.getByRole('checkbox', { name: 'Select Budget planner' }));
		await userEvent.click(screen.getByRole('button', { name: 'Download ZIP' }));
		expect((screen.getByRole('button', { name: 'Preparing ZIP…' }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole('checkbox', { name: 'Select Budget planner' }) as HTMLInputElement).disabled).toBe(true);
		for (const name of ['Delete selected', 'Done', 'Clear selection', 'Select all shown']) {
			expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
		}
		const { act } = await import('@testing-library/react');
		act(() => reject(new Error('Offline')));
		await screen.findByRole('alert');
		expect((screen.getByRole('button', { name: 'Download ZIP' }) as HTMLButtonElement).disabled).toBe(false);
	});

	it('selects with the keyboard without opening a card; preserves and counts hidden selections', async () => {
		const router = open('/artifacts');
		await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
		const checkbox = screen.getByRole('checkbox', { name: 'Select Budget planner' });
		checkbox.focus();
		await userEvent.keyboard(' ');
		expect((checkbox as HTMLInputElement).checked).toBe(true);
		expect(router.state.location.pathname).toBe('/artifacts');
		await userEvent.click(screen.getByRole('button', { name: /Images/ }));
		expect(screen.getByText('1 selected (1 hidden by filters)')).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'Select all shown' }));
		expect(screen.getByText('2 selected (1 hidden by filters)')).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
		expect(screen.getByText('0 selected')).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'Done' }));
		expect(screen.queryByRole('checkbox')).toBeNull();
	});

	it('downloads one ZIP for selected files, including matching paths from different tasks', async () => {
		const duplicate = artifact({ sessionId: 's2', path: listed[0].path, title: 'Another planner' });
		const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip');
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
		open('/artifacts', [listed[0], duplicate]);
		await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
		await userEvent.click(screen.getByRole('button', { name: 'Select all shown' }));
		await userEvent.click(screen.getByRole('button', { name: 'Download ZIP' }));
		await screen.findByText('ZIP download started.');
		expect(api.downloadArtifacts).toHaveBeenCalledWith([{ sessionId: 's1', path: listed[0].path }, { sessionId: 's2', path: listed[0].path }]);
		expect(create).toHaveBeenCalledTimes(1);
		expect(click).toHaveBeenCalledTimes(1);
		create.mockRestore(); click.mockRestore();
	});

	it('keeps selection and offers recovery after a failed ZIP download', async () => {
		api.downloadArtifacts.mockRejectedValueOnce(new Error('File no longer available.'));
		open('/artifacts');
		await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
		await userEvent.click(screen.getByRole('checkbox', { name: 'Select Budget planner' }));
		await userEvent.click(screen.getByRole('button', { name: 'Download ZIP' }));
		expect((await screen.findByRole('alert')).textContent).toContain('Try again');
		expect(screen.getByText('1 selected')).toBeTruthy();
	});

	it('confirms bulk deletion, handles partial failure, invalidates tasks and retries only failures', async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const invalidate = vi.spyOn(client, 'invalidateQueries');
		open('/artifacts', listed, client);
		await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
		await userEvent.click(screen.getByRole('button', { name: 'Select all shown' }));
		await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
		expect(api.deleteOutput).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(api.deleteOutput).not.toHaveBeenCalled();
		api.deleteOutput.mockImplementation(async (_id?: string, path?: string) => { if (path === listed[1].path) throw new Error('Storage unavailable'); });
		api.artifacts.mockResolvedValue({ artifacts: [listed[1]] });
		await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
		await userEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
		expect((await screen.findByRole('alert')).textContent).toContain('1 could not be deleted');
		expect(screen.getByText('2 artifacts deleted.')).toBeTruthy();
		expect(screen.getByText('1 selected')).toBeTruthy();
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ['outputs', 's1'] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ['outputs', 's2'] });
		api.deleteOutput.mockImplementation(async () => undefined);
		api.artifacts.mockResolvedValue({ artifacts: [] });
		await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
		await userEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
		await screen.findByText('1 artifact deleted.');
		expect(api.deleteOutput).toHaveBeenCalledTimes(4);
		expect(screen.getByText('0 selected')).toBeTruthy();
	});

	it('resets delete confirmation if selection changes and prunes externally deleted selections', async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		open('/artifacts', listed, client);
		await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
		await userEvent.click(screen.getByRole('checkbox', { name: 'Select Budget planner' }));
		await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
		await userEvent.click(screen.getByRole('checkbox', { name: 'Select findings.md' }));
		expect(screen.queryByRole('button', { name: 'Confirm delete' })).toBeNull();
		const { act } = await import('@testing-library/react');
		act(() => client.setQueryData(['artifacts'], { artifacts: [listed[1], listed[2]] }));
		await screen.findByText('1 selected');
		expect(api.deleteOutput).not.toHaveBeenCalled();
	});

	it('adds files of your own, which show as from no task', async () => {
		open('/artifacts');
		await screen.findByText('findings.md');
		const skill = new File(['# Broker skill'], 'SKILL.md', { type: 'text/markdown' });
		const added = artifact({ sessionId: 'added-files', path: 'SKILL.md', title: 'SKILL.md', task: { title: 'Added by you', spaceId: null, chat: true }, added: true });
		api.artifacts.mockResolvedValue({ artifacts: [added, ...listed] });
		await userEvent.upload(screen.getByLabelText('Files to add'), skill);
		await waitFor(() => expect(api.addArtifact).toHaveBeenCalledWith(skill));
		const card = (await screen.findByText('SKILL.md')).closest('.in-card') as HTMLElement;
		expect(within(card).getByText(/Added by you/)).toBeTruthy();
		await userEvent.click(within(card).getByRole('button', { name: 'Actions for SKILL.md' }));
		expect(await screen.findByRole('menuitem', { name: 'Download' })).toBeTruthy();
		expect(screen.queryByRole('menuitem', { name: 'Go to the task' })).toBeNull();
	});

	it('adds a folder as one zip, and installs a skill folder as a skill', async () => {
		open('/artifacts');
		await screen.findByText('findings.md');
		const inFolder = (path: string, text: string) => {
			const file = new File([text], path.split('/').pop()!);
			Object.defineProperty(file, 'webkitRelativePath', { value: path });
			return file;
		};
		api.addArtifact.mockResolvedValueOnce({ path: 'day-trading.zip', sessionId: 'added-files' });
		await userEvent.upload(screen.getByLabelText('Folder to add'), [
			inFolder('day-trading/SKILL.md', '---\nname: day-trading\ndescription: Trade.\n---\nGo.'),
			inFolder('day-trading/scripts/kit.py', 'print(1)'),
			inFolder('day-trading/.DS_Store', 'junk'),
		]);
		await waitFor(() => expect(api.installAddedSkill).toHaveBeenCalledWith('day-trading.zip'));
		const zip = (api.addArtifact.mock.calls.at(-1) as unknown as [File])[0];
		expect(zip.name).toBe('day-trading.zip');
		const { unzipSync } = await import('fflate');
		expect(Object.keys(unzipSync(new Uint8Array(await zip.arrayBuffer()))).sort()).toEqual(['day-trading/SKILL.md', 'day-trading/scripts/kit.py']);
		expect(await screen.findByText(/installed it as the skill day-trading/)).toBeTruthy();
	});

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
		await userEvent.click(await screen.findByRole('button', { name: /Apps,\s*1/ }));
		expect(screen.getByText('Budget planner')).toBeTruthy();
		expect(screen.queryByText('findings.md')).toBeNull();
		await userEvent.click(screen.getByRole('button', { name: /All,\s*3/ }));
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
