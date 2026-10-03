import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({ session: vi.fn(), files: vi.fn(), file: vi.fn(async () => new TextEncoder().encode('export const answer = 42;\n')) }));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
vi.mock('@/lib/highlight', () => ({ highlight: async () => null }));

const { FilesTab } = await import('@/components/files-tab');

const listing = { source: 'base', at: null, paths: ['README.md', 'src/app.ts', 'src/web/main.tsx', 'tests/app.test.ts'], changes: [{ path: 'src/app.ts', status: 'M' }] };

describe('FilesTab', () => {
	it('lists folders first, finds files by name, and opens one', async () => {
		renderWithQueries(<FilesTab sessionId="s1" />, [
			[['session', 's1'], session()],
			[['files', 's1'], listing],
		]);
		const rows = screen.getAllByRole('button').map((button) => button.textContent).filter((text) => text !== 'Resume');
		expect(rows.indexOf('src' + 'M')).toBeLessThan(rows.indexOf('README.md'));

		fireEvent.change(screen.getByLabelText('Find a file'), { target: { value: 'app' } });
		const matches = screen.getAllByRole('button').map((button) => button.textContent).filter((text) => text !== 'Resume');
		expect(matches).toEqual(['app.tssrcM', 'app.test.tstests']);

		fireEvent.click(screen.getByRole('button', { name: /^app\.ts\s*src\s*M/ }));
		expect(await screen.findByText('export const answer = 42;')).toBeTruthy();
		expect(api.file).toHaveBeenCalledWith('s1', 'src/app.ts');
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
