import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQueries } from './render';

const api = vi.hoisted(() => ({
	outputs: vi.fn(),
	uploadOutput: vi.fn(async () => ({ path: 'uploads/notes.txt' })),
	deleteOutput: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { LibraryTab } = await import('@/components/library-tab');

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
});
