import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQueries } from './render';

const api = vi.hoisted(() => ({
	outputs: vi.fn(),
	uploadOutput: vi.fn(async () => ({ path: 'uploads/notes.txt' })),
	deleteOutput: vi.fn(async () => ({ ok: true })),
	outputText: vi.fn(async () => '<!doctype html><title>Budget</title><p>Hello</p>'),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { Library, LibraryTab, taskPlace } = await import('@/components/library-tab');

const at = Date.parse('2026-10-09T12:00:00Z');
const listing = {
	source: 'saved',
	at: null,
	outputs: [
		{ path: 'report.md', size: 2048, mtimeMs: at },
		{ path: 'screenshots/home.png', size: 91_000, mtimeMs: at },
		{ path: 'screenshots/pricing.png', size: 80_000, mtimeMs: at - 1000 },
		{ path: 'data/rows.csv', size: 512, mtimeMs: at },
	],
};

const openMenu = (trigger: HTMLElement) => fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });

describe('LibraryTab', () => {
	it('shows folders as cards with how many files they hold, and goes back up by the breadcrumb', () => {
		localStorage.removeItem('anton.library.view');
		renderWithQueries(<LibraryTab sessionId="s1" />, [[['outputs', 's1'], listing]]);
		expect(screen.getByRole('button', { name: /screenshots\s*2 items/ })).toBeTruthy();
		expect(screen.getByRole('button', { name: /data\s*1 item/ })).toBeTruthy();
		expect(screen.getByText('4 files')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: /screenshots\s*2 items/ }));
		const crumbs = screen.getByRole('navigation', { name: 'Folder' });
		expect(within(crumbs).getByRole('button', { name: 'screenshots' }).getAttribute('aria-current')).toBe('page');
		expect(screen.queryByText('report.md')).toBeNull();
		expect(screen.getAllByText('PNG')).toHaveLength(2);

		fireEvent.click(within(crumbs).getByRole('button', { name: 'All files' }));
		expect(screen.getByText('report.md')).toBeTruthy();
	});

	it('narrows to one type', async () => {
		localStorage.removeItem('anton.library.view');
		renderWithQueries(<LibraryTab sessionId="s1" />, [[['outputs', 's1'], listing]]);
		openMenu(screen.getByRole('button', { name: /Type/ }));
		fireEvent.click(await screen.findByRole('menuitem', { name: /Images/ }));
		expect(screen.getByText('2 of 4 files')).toBeTruthy();
		expect(screen.queryByText('report.md')).toBeNull();
	});

	it('deletes a file only on the second click, without opening it', async () => {
		localStorage.removeItem('anton.library.view');
		renderWithQueries(<LibraryTab sessionId="s1" />, [[['outputs', 's1'], listing]]);
		openMenu(screen.getByRole('button', { name: 'Actions for report.md' }));
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
		expect(api.deleteOutput).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Click again to delete' }));
		await waitFor(() => expect(api.deleteOutput).toHaveBeenCalledWith('s1', 'report.md'));
		expect(screen.queryByRole('button', { name: 'Library' })).toBeNull();
	});

	it('adds the files you pick', async () => {
		renderWithQueries(<LibraryTab sessionId="s1" />, [[['outputs', 's1'], listing]]);
		const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
		fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
		await waitFor(() => expect(api.uploadOutput).toHaveBeenCalledWith('s1', file));
		expect(await screen.findByText('Added notes.txt to uploads')).toBeTruthy();
	});

	it('remembers the list view', () => {
		localStorage.removeItem('anton.library.view');
		renderWithQueries(<LibraryTab sessionId="s1" />, [[['outputs', 's1'], listing]]);
		fireEvent.click(screen.getByRole('radio', { name: 'List' }));
		expect(screen.getByText('Modified')).toBeTruthy();
		expect(screen.getByText('Size')).toBeTruthy();
		expect(localStorage.getItem('anton.library.view')).toContain('list');
	});

	it('opens an HTML file as its live page, with its source a click away', async () => {
		localStorage.removeItem('anton.library.view');
		const pages = { ...listing, outputs: [{ path: 'renders/budget-a1b2c3.html', size: 900, mtimeMs: at }] };
		renderWithQueries(<LibraryTab sessionId="s1" />, [[['outputs', 's1'], pages]]);
		fireEvent.click(screen.getByRole('button', { name: /^renders\s*1 item/ }));
		fireEvent.click(screen.getByRole('button', { name: 'budget-a1b2c3.html' }));
		const frame = screen.getByTitle('budget-a1b2c3.html') as HTMLIFrameElement;
		expect(frame.getAttribute('src')).toBe('/api/sessions/s1/render-frame?path=renders%2Fbudget-a1b2c3.html');
		expect(screen.getByRole('link', { name: 'Open in a new tab' }).getAttribute('href')).toBe(frame.getAttribute('src'));
		fireEvent.click(screen.getByRole('radio', { name: 'Code' }));
		expect(await screen.findByText(/<p>Hello<\/p>/)).toBeTruthy();
		expect(screen.queryByTitle('budget-a1b2c3.html')).toBeNull();
	});

	it('shows any Library the same way: a project file, and a thread\'s page live in its folder', async () => {
		localStorage.removeItem('anton.library.view');
		const text = vi.fn(async () => '<h1>Plan</h1>');
		const source = {
			files: [
				{ path: 'plan.html', size: 120, mtimeMs: at },
				{ path: 'From threads/Fix CI/renders/report.html', size: 900, mtimeMs: at },
			],
			error: null,
			place: (path: string) =>
				path.startsWith('From threads/') ? taskPlace('t9', 'renders/report.html') : { path, url: `/api/spaces/p1/file?path=${path}`, textKey: ['space-file', 'p1', path], text },
			agentPath: (path: string) => `../project-files/${path}`,
			upload: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			refresh: vi.fn(),
			addedTo: 'the project files',
			empty: 'Nothing here',
		};
		renderWithQueries(<Library library={source} />, []);
		expect(screen.getByRole('button', { name: /From threads\s*1 item/ })).toBeTruthy();
		// A project's own page has no task to run it, so it opens as its source.
		fireEvent.click(screen.getByRole('button', { name: 'plan.html' }));
		expect(await screen.findByText(/<h1>Plan<\/h1>/)).toBeTruthy();
		expect(screen.queryByRole('radio', { name: 'Code' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Library' }));

		fireEvent.click(screen.getByRole('button', { name: /From threads\s*1 item/ }));
		fireEvent.click(screen.getByRole('button', { name: /Fix CI\s*1 item/ }));
		fireEvent.click(screen.getByRole('button', { name: /renders\s*1 item/ }));
		fireEvent.click(screen.getByRole('button', { name: 'report.html' }));
		expect((screen.getByTitle('report.html') as HTMLIFrameElement).getAttribute('src')).toBe('/api/sessions/t9/render-frame?path=renders%2Freport.html');

		fireEvent.click(screen.getByRole('button', { name: 'Library' }));
		const file = new File(['x'], 'brief.md', { type: 'text/markdown' });
		fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
		await waitFor(() => expect(source.upload).toHaveBeenCalledWith(file));
		expect(await screen.findByText('Added brief.md to the project files')).toBeTruthy();
	});
});
