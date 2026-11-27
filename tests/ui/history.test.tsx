import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQueries } from './render';

const api = vi.hoisted(() => ({
	checkpoints: vi.fn(),
	checkpoint: vi.fn(),
	restoreCheckpoint: vi.fn(),
	checkpointDiffFiles: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { HistoryTab } = await import('@/components/workspace/history-tab');

const PATCH = [
	'diff --git a/src/a.ts b/src/a.ts',
	'--- a/src/a.ts',
	'+++ b/src/a.ts',
	'@@ -1,0 +1,1 @@',
	'+const next = 1;',
	'',
].join('\n');

describe('History', () => {
	it('bounds a checkpoint diff in its own virtualized scroll container', async () => {
		const at = '2026-10-03T01:02:03Z';
		api.checkpoints.mockResolvedValue({ checkpoints: [{ at, files: 1, added: 1, removed: 0, commit: null }] });
		api.checkpoint.mockResolvedValue({ at, patch: PATCH });
		renderWithQueries(<HistoryTab sessionId="s1" />);

		fireEvent.click(await screen.findByRole('button', { name: /1 file changed/ }));
		const list = await screen.findByRole('list', { name: 'Changed files' });
		await waitFor(() => expect(list.querySelector('diffs-container')?.shadowRoot?.textContent).toContain('const next = 1;'));
		expect(list.parentElement?.className).toContain('flex-1');
		expect(list.parentElement?.className).toContain('overflow-auto');
		expect(list.closest('.in-well')?.className).toContain('min-h-0');
	});
});
