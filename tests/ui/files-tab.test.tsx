import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({
	session: vi.fn(),
	files: vi.fn(),
	file: vi.fn(async (_id: string, _path: string) => new TextEncoder().encode('export const answer = 42;\n')),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
vi.mock('@/lib/highlight', () => ({ highlight: async () => null }));

const { FilesTab } = await import('@/components/files-tab');

const listing = {
	source: 'base',
	at: null,
	paths: ['README.md', 'src/app.ts', 'src/web/main.tsx', 'tests/app.test.ts'],
	changes: [{ path: 'src/app.ts', status: 'M' }],
};

describe('FilesTab', () => {
	it('lists folders first, finds files by name, and opens one', async () => {
		renderWithQueries(<FilesTab sessionId="s1" />, [
			[['session', 's1'], session()],
			[['files', 's1'], listing],
		]);
		const rows = screen
			.getAllByRole('button')
			.map((button) => button.textContent)
			.filter((text) => text !== 'Resume');
		expect(rows.indexOf('src' + 'M')).toBeLessThan(rows.indexOf('README.md'));

		fireEvent.change(screen.getByLabelText('Find a file'), { target: { value: 'app' } });
		const matches = screen
			.getAllByRole('button')
			.map((button) => button.textContent)
			.filter((text) => text !== 'Resume');
		expect(matches).toEqual(['app.tssrcM', 'app.test.tstests']);

		fireEvent.click(screen.getByRole('button', { name: /^app\.ts\s*src\s*M/ }));
		expect(await screen.findByText('export const answer = 42;')).toBeTruthy();
		expect(api.file).toHaveBeenCalledWith('s1', 'src/app.ts');
		expect(screen.getByRole('button', { name: /^app\.ts\s*src\s*M/ }).getAttribute('aria-current')).toBe('true');
	});

	it('puts the file tree away to read a file wide, and brings it back with its resize handle', async () => {
		localStorage.removeItem('anton.files.tree-hidden');
		renderWithQueries(<FilesTab sessionId="s1" />, [
			[['session', 's1'], session()],
			[['files', 's1'], listing],
		]);
		fireEvent.click(screen.getByRole('button', { name: /^README\.md/ }));
		expect(await screen.findByRole('separator', { name: 'Resize the file tree' })).toBeTruthy();
		const tree = screen.getByLabelText('File tree');

		fireEvent.click(screen.getByRole('button', { name: 'Hide the file tree' }));
		expect(tree.hidden).toBe(true);
		expect(screen.queryByRole('separator', { name: 'Resize the file tree' })).toBeNull();
		expect(localStorage.getItem('anton.files.tree-hidden')).toBe('true');

		fireEvent.click(screen.getByRole('button', { name: 'Show the file tree' }));
		expect(tree.hidden).toBe(false);
		const handle = screen.getByRole('separator', { name: 'Resize the file tree' });
		expect(handle.getAttribute('aria-valuenow')).toBe('220');
		fireEvent.keyDown(handle, { key: 'ArrowRight' });
		expect(handle.getAttribute('aria-valuenow')).toBe('236');
		fireEvent.doubleClick(handle);
		expect(handle.getAttribute('aria-valuenow')).toBe('220');
	});

	it('shows nothing matched rather than an empty panel', () => {
		renderWithQueries(<FilesTab sessionId="s1" />, [
			[['session', 's1'], session()],
			[['files', 's1'], listing],
		]);
		fireEvent.change(screen.getByLabelText('Find a file'), { target: { value: 'zzz' } });
		expect(screen.getByText('No files match.')).toBeTruthy();
	});
});

describe('file viewer tabs', () => {
	it('keeps the tree beside multiple open files and selects a neighbor when closing', async () => {
		renderWithQueries(<FilesTab sessionId="s1" />, [
			[['session', 's1'], session()],
			[['files', 's1'], listing],
		]);
		fireEvent.click(screen.getByRole('button', { name: 'README.md' }));
		expect(await screen.findByRole('tab', { name: 'README.md' })).toBeTruthy();
		expect(screen.getByLabelText('Find a file')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: /^src\s*M$/ }));
		fireEvent.click(screen.getByRole('button', { name: /^app.ts\s*M$/ }));
		expect(await screen.findByRole('tab', { name: 'app.ts' })).toBeTruthy();
		expect(screen.getByRole('tab', { name: 'app.ts' }).getAttribute('title')).toBe('src/app.ts');
		expect(screen.queryByText('src/app.ts')).toBeNull();
		expect(screen.getAllByRole('tab')).toHaveLength(2);
		expect(screen.getByRole('button', { name: /^app.ts\s*M$/ }).getAttribute('aria-current')).toBe('true');
		fireEvent.click(screen.getByRole('tab', { name: 'README.md' }));
		expect(screen.getByRole('button', { name: 'README.md' }).getAttribute('aria-current')).toBe('true');
		expect(screen.getByRole('button', { name: /^app.ts\s*M$/ }).hasAttribute('aria-current')).toBe(false);
		fireEvent.click(screen.getByRole('tab', { name: 'app.ts' }));
		fireEvent.click(screen.getByRole('button', { name: 'Close src/app.ts' }));
		expect(screen.getByRole('tab', { name: 'README.md' }).getAttribute('aria-selected')).toBe('true');
	});
	it('renders markdown with a source toggle and image files as images', async () => {
		api.file.mockImplementation(async (_id: string, path: string) => new TextEncoder().encode(path.endsWith('.md') ? '# Hello file' : 'image bytes'));
		renderWithQueries(<FilesTab sessionId="s1" />, [
			[['session', 's1'], session()],
			[['files', 's1'], { ...listing, paths: ['README.md', 'photo.png'] }],
		]);
		fireEvent.click(screen.getByRole('button', { name: 'README.md' }));
		expect(await screen.findByRole('heading', { name: 'Hello file' })).toBeTruthy();
		// How it shows is two icons at the end of the open-files bar, not a row of its own.
		const showAs = screen.getByRole('radiogroup', { name: 'Show Markdown as' });
		expect(showAs.closest('[role=tablist]')).toBeNull();
		expect(showAs.parentElement?.querySelector('[role=tablist][aria-label="Open files"]')).toBeTruthy();
		fireEvent.click(within(showAs).getByRole('radio', { name: 'Source' }));
		expect(screen.getByText('# Hello file')).toBeTruthy();
		fireEvent.click(within(showAs).getByRole('radio', { name: 'Preview' }));
		expect(screen.getByRole('heading', { name: 'Hello file' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'photo.png' }));
		expect(await screen.findByRole('img', { name: 'photo.png' })).toBeTruthy();
	});
});
