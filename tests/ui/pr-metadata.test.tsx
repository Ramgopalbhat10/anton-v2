import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrMetadata } from '@/components/pr-status';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithQueries } from './render';

const pullMetadata = vi.hoisted(() => vi.fn(async (): Promise<any> => null));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: { pullMetadata } }));
const url = 'https://github.com/acme/demo/pull/42';
const headBranch = 'anton/very-long-source-branch-that-must-truncate-independently';
const baseBranch = 'release/very-long-target-branch-that-must-also-truncate';
const detail = { url, headBranch, baseBranch, additions: 0, deletions: 123456 };
const metadata = (data: unknown = detail) => renderWithQueries(<TooltipProvider><PrMetadata sessionId="s1" url={url} compact /></TooltipProvider>, [[['pr-metadata', 's1', 42], data]]);

beforeEach(() => { pullMetadata.mockReset().mockResolvedValue(null); });

describe('compact PR metadata', () => {
	it('uses intrinsic branch tracks, a non-truncated arrow, and non-shrinking counts', () => {
		metadata();
		const source = screen.getByLabelText(`Source branch: ${headBranch}`);
		const target = screen.getByLabelText(`Target branch: ${baseBranch}`);
		expect(source.className).toContain('truncate');
		expect(target.className).toContain('truncate');
		expect(source.parentElement).toBe(target.parentElement);
		expect(source.parentElement?.className).toContain('grid-cols-[minmax(0,max-content)_max-content_minmax(0,max-content)]');
		expect(screen.getByText('→').getAttribute('aria-hidden')).toBe('true');
		expect(screen.getByLabelText('0 additions, 123456 deletions').className).toContain('shrink-0');
	});

	it('reveals each full name on keyboard focus, dismisses on Escape, and can be hovered', async () => {
		const user = userEvent.setup();
		metadata();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByLabelText(`Source branch: ${headBranch}`));
		expect((await screen.findByRole('tooltip')).textContent).toBe(headBranch);
		await user.keyboard('{Escape}');
		await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
		await user.tab();
		expect(document.activeElement).toBe(screen.getByLabelText(`Target branch: ${baseBranch}`));
		expect((await screen.findByRole('tooltip')).textContent).toBe(baseBranch);
		await user.tab();
		fireEvent.pointerMove(screen.getByLabelText(`Source branch: ${headBranch}`), { pointerType: 'mouse' });
		expect((await screen.findByRole('tooltip')).textContent).toBe(headBranch);
	});

	it.each([
		{ headBranch, baseBranch: 'main' },
		{ headBranch: 'fix', baseBranch },
	])('keeps full names accessible with unequal branch lengths (%j)', async (branches) => {
		const user = userEvent.setup();
		metadata({ ...detail, ...branches });
		for (const [kind, name] of [['Source', branches.headBranch], ['Target', branches.baseBranch]]) {
			await user.tab();
			expect(document.activeElement).toBe(screen.getByLabelText(`${kind} branch: ${name}`));
			const tooltip = await screen.findByRole('tooltip');
			expect(tooltip.textContent).toBe(name);
			const surface = tooltip.closest('[data-slot="tooltip-content"]')!;
			expect(surface.className).toContain('bg-(--bg-overlay)');
			expect(surface.className).toContain('text-(--text-primary)');
			expect(surface.querySelector('svg')?.getAttribute('class')).toContain('fill-(--bg-overlay)');
			expect(surface.className).not.toContain('bg-foreground');
			await user.keyboard('{Escape}');
			await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
		}
	});

	it('handles absent branch names without losing the diff', () => {
		metadata({ ...detail, headBranch: '', baseBranch: '' });
		expect(screen.getByLabelText('Source branch: Unknown source')).toBeTruthy();
		expect(screen.getByLabelText('Target branch: Unknown target')).toBeTruthy();
		expect(screen.getByLabelText('0 additions, 123456 deletions')).toBeTruthy();
	});

	it.each([null, { ...detail, url: 'https://github.com/other/repo/pull/42' }])('omits unavailable or mismatched metadata (%j)', (data) => {
		const { container } = metadata(data);
		expect(container.textContent).toBe('');
	});

	it('stays empty while loading and after a metadata error', async () => {
		let reject!: (reason: Error) => void;
		pullMetadata.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
		const { container, client } = renderWithQueries(<PrMetadata sessionId="s1" url={url} compact />);
		expect(container.textContent).toBe('');
		reject(new Error('Metadata unavailable'));
		await waitFor(() => expect(client.getQueryState(['pr-metadata', 's1', 42])?.status).toBe('error'));
		expect(container.textContent).toBe('');
	});

	it('does not fetch when disabled or without a valid PR number', () => {
		renderWithQueries(<><PrMetadata sessionId="s1" url={url} compact enabled={false} /><PrMetadata sessionId="s1" url="https://github.com/acme/demo" compact /></>);
		expect(pullMetadata).not.toHaveBeenCalled();
	});
});
