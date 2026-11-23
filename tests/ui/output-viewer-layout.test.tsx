import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutputCards, OutputViewerHost } from '@/components/content/output-viewer';
import { TaskWorkspace, type TaskPanels } from '@/components/shell/shell';
import type { PanelName } from '@/components/workspace/vm-panel';
import { closeViewer } from '@/lib/viewer';
import { session } from './render';

const picture = { sessionId: 's1', path: `images/${'long-filename-'.repeat(15)}.png` };
const document = { sessionId: 's1', path: 'reports/resume.pdf' };
const source = { sessionId: 's1', path: 'scripts/example.js' };
const sourceText = 'const first = 1;\r\n\r\n\tconst third = 3;\r\n';
const items = [picture, document, source];
const terminal = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn(), dispose: vi.fn() }));

vi.mock('@flue/react', () => ({ useFlueAgent: () => ({ messages: [], settlements: [], status: 'idle', historyReady: true, refresh: vi.fn(), sendMessage: vi.fn() }) }));
vi.mock('@/components/thread/thread', () => ({ Thread: () => <OutputCards items={items} composer="s1" /> }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
	cols = 80;
	rows = 24;
	loadAddon() {}
	open() {}
	write() {}
	onData() {}
	onResize() {}
	dispose = terminal.dispose;
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

afterEach(() => {
	closeViewer();
	vi.unstubAllGlobals();
	localStorage.clear();
});

async function mount(initiallyOpen: boolean, mobile = false, active: PanelName | null = null) {
	vi.clearAllMocks();
	vi.stubGlobal('matchMedia', () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal('WebSocket', class {
		static OPEN = 1;
		constructor(url: string) { terminal.connect(url); }
		close = terminal.close;
	});
	function Page() {
		const [panels, setPanels] = useState<TaskPanels>({ tabs: active ? [active] : [], active, open: initiallyOpen });
		return <><TaskWorkspace sessionId="s1" panels={panels} onPanelsChange={setPanels} /><OutputViewerHost /></>;
	}
	const root = createRootRoute({ component: Page });
	const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	client.setQueryData(['session', 's1'], session({ repo: '', projectId: null }));
	client.setQueryData(['outputs', 's1'], { outputs: items.map((item) => ({ path: item.path, size: 1, mtimeMs: 1 })) });
	client.setQueryData(['output', 's1', source.path], sourceText);
	client.setQueryData(['changes', 's1', 'unpushed'], { source: 'saved', patch: '' });
	client.setQueryData(['health'], { providers: { sandbox: 'local' } });
	render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
	await screen.findByRole('list', { name: 'Files from this reply' });
}

describe('artifact viewer layout', () => {
	it('opens source in the sliding workspace with a separate, keyboard-scrollable line gutter', async () => {
		await mount(false);
		fireEvent.click(screen.getByTitle(`Open ${source.path}`));
		const viewer = await screen.findByRole('complementary', { name: 'Viewing example.js' });
		expect(viewer.closest('.sg-workspace')?.getAttribute('data-slide')).toBe('in');
		const scroll = within(viewer).getByRole('region', { name: 'Source code' });
		expect(scroll.tabIndex).toBe(0);
		expect(scroll.querySelector('[aria-hidden="true"]')?.textContent).toBe('1\n2\n3\n4');
		expect(scroll.querySelector('code')?.textContent).toBe(sourceText.replaceAll('\r\n', '\n'));
		await waitFor(() => expect(scroll.querySelector('code span')).not.toBeNull());
		expect(scroll.querySelector('code')?.textContent).toBe(sourceText.replaceAll('\r\n', '\n'));
		fireEvent.keyDown(scroll, { key: 'ArrowLeft' });
		expect(screen.getByRole('complementary', { name: 'Viewing example.js' })).toBe(viewer);
		fireEvent.keyDown(scroll, { key: 'Escape' });
		expect(screen.queryByRole('complementary')).toBeNull();
	});

	it('does not connect a saved Terminal when only an artifact opens a closed workspace', async () => {
		await mount(false, false, 'Terminal');
		// Resolve the real lazy panel module, so an accidental mount cannot escape the connection assertion.
		await import('@/components/workspace/terminal-tab');
		fireEvent.click(screen.getByTitle(`Open ${picture.path}`));
		expect((await screen.findByRole('complementary')).closest('.sg-workspace')).not.toBeNull();
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
		expect(terminal.connect).not.toHaveBeenCalled();
		expect(screen.queryByText('Restart')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
		expect(await screen.findByRole('complementary', { name: 'Viewing resume.pdf' })).toBeTruthy();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(window.document.querySelector('.sg-workspace')).toBeNull());
		expect(terminal.connect).not.toHaveBeenCalled();
		// An explicit workspace opening still connects normally, and previewing over it keeps that same Shell mounted.
		fireEvent.click(screen.getByRole('button', { name: 'Show workspace' }));
		await waitFor(() => expect(terminal.connect).toHaveBeenCalledTimes(1));
		expect(terminal.connect).toHaveBeenCalledWith(expect.stringContaining('/vm/s1/pty?'));
		fireEvent.click(screen.getByTitle(`Open ${picture.path}`));
		await screen.findByRole('complementary');
		expect(terminal.connect).toHaveBeenCalledTimes(1);
		expect(terminal.dispose).not.toHaveBeenCalled();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(await screen.findByRole('button', { name: 'Restart' })).toBeTruthy();
		expect(terminal.connect).toHaveBeenCalledTimes(1);
		expect(terminal.close).not.toHaveBeenCalled();
	});

	it('does not reconnect Terminal after the workspace was hidden and unmounted', async () => {
		await mount(true, false, 'Terminal');
		await waitFor(() => expect(terminal.connect).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole('button', { name: 'Hide workspace' }));
		await waitFor(() => expect(window.document.querySelector('.sg-workspace')).toBeNull());
		expect(terminal.close).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByTitle(`Open ${document.path}`));
		expect((await screen.findByRole('complementary', { name: 'Viewing resume.pdf' })).closest('.sg-workspace')).not.toBeNull();
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
		expect(terminal.connect).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Restart')).toBeNull();
	});

	it.each([true, false])('docks images and files with workspace initially open=%s, then restores it', async (initiallyOpen) => {
		await mount(initiallyOpen);
		const cards = within(screen.getByRole('list', { name: 'Files from this reply' }));
		fireEvent.click(cards.getByTitle(`Open ${picture.path}`));
		let viewer = await screen.findByRole('complementary', { name: `Viewing ${picture.path.split('/').pop()}` });
		expect(viewer.closest('.sg-workspace')).not.toBeNull();
		expect(viewer.classList.contains('fixed')).toBe(false);
		expect(viewer.querySelector('header')?.classList.contains('h-11')).toBe(true);
		expect(within(viewer.querySelector('header')!).getByTitle(picture.path).classList.contains('truncate')).toBe(true);
		expect(within(viewer).getByRole('button', { name: 'Mark up' })).toBeTruthy();
		expect(within(viewer).getByRole('link', { name: 'Open in a new tab' }).getAttribute('href')).toContain(encodeURIComponent(picture.path));
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		fireEvent.click(within(viewer).getByRole('button', { name: 'Download' }));
		expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe(picture.path.split('/').pop());
		click.mockRestore();
		fireEvent.click(within(viewer).getByRole('button', { name: 'Next file' }));
		viewer = await screen.findByRole('complementary', { name: 'Viewing resume.pdf' });
		expect(viewer.closest('.sg-workspace')).not.toBeNull();
		expect(within(viewer.querySelector('header')!).getByTitle(document.path).tagName).toBe('SPAN');
		expect(viewer.querySelector('iframe')?.getAttribute('src')).toContain('reports%2Fresume.pdf');
		expect(within(viewer).queryByRole('button', { name: 'Mark up' })).toBeNull();
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(await screen.findByRole('button', { name: 'Mark up' })).toBeTruthy();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
		if (initiallyOpen) expect(screen.getByRole('navigation', { name: 'Open a panel' })).toBeTruthy();
		else await waitFor(() => expect(screen.getByRole('button', { name: 'Show workspace' })).toBeTruthy());
		// A file card opens through exactly the same dock, without navigating from an image first.
		fireEvent.click(cards.getByTitle(`Open ${document.path}`));
		expect((await screen.findByRole('complementary', { name: 'Viewing resume.pdf' })).closest('.sg-workspace')).not.toBeNull();
	});

	it('keeps the inset sheet on phones even when the desktop workspace was saved open', async () => {
		await mount(true, true);
		fireEvent.click(screen.getByTitle(`Open ${picture.path}`));
		const viewer = await screen.findByRole('complementary', { name: `Viewing ${picture.path.split('/').pop()}` });
		expect(viewer.closest('.sg-workspace')).toBeNull();
		expect(viewer.classList.contains('sg-viewer-sheet')).toBe(true);
		expect(screen.getByRole('button', { name: 'Show workspace' })).toBeTruthy();
		fireEvent.click(within(viewer).getByRole('button', { name: 'Next file' }));
		expect((await screen.findByRole('complementary', { name: 'Viewing resume.pdf' })).classList.contains('sg-viewer-sheet')).toBe(true);
		act(closeViewer);
	});
});
