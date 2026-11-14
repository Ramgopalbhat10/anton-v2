import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PullRequestChip } from '@/components/task-actions';
import { PrChecks, PrStatus, prColor, prSummary, prTone } from '@/components/pr-status';
import { renderWithQueries, session } from './render';

const url = 'https://github.com/acme/demo/pull/42?x=1';
describe('pull request presentation', () => {
	it.each(['open', 'merged', 'draft', 'closed'] as const)('shows %s consistently with an accessible link', (state) => {
		const thread = session({ prUrl: url, pullRequest: { state, checks: null, runs: [] } });
		render(<PrStatus thread={thread} link full />);
		const link = screen.getByRole('link', { name: `Pull request #42 ${state}` });
		expect(link.getAttribute('href')).toBe(url);
		expect(link.getAttribute('style')).toContain(prColor(state));
	});
	it('keeps the header chip short while retaining the full status for accessibility', () => {
		const thread = session({ prUrl: url, pullRequest: { state: 'open', checks: 'failed', conflicts: true, runs: [] } });
		renderWithQueries(<PullRequestChip session={thread} />, [[['pull-request', thread.id, url], { state: 'open' }]]);
		const chip = screen.getByRole('link', { name: 'Pull request #42 open · merge conflicts · checks failing' });
		expect(chip.textContent).toBe('#42');
		expect(chip.title).toBe('#42 open · merge conflicts · checks failing');
		expect(chip.getAttribute('href')).toBe(url);
	});
	it('renders a merged chip with its merge icon, but retains its accessible state', () => {
		const thread = session({ prUrl: url, pullRequest: { state: 'merged', checks: null, runs: [] } });
		render(<PrStatus thread={thread} link full />);
		const chip = screen.getByRole('link', { name: 'Pull request #42 merged' });
		expect(chip.textContent).toBe('#42');
		expect(chip.querySelector('.lucide-git-merge')).toBeTruthy();
		expect(chip.className).toContain('rounded-inner');
		expect(chip.style.background).toContain('--merged-soft');
		expect(within(chip).queryByText(/merged/i)).toBeNull();
	});
	it('keeps state and attention details together, without treating unknown as open', () => {
		expect(prSummary(session({ prUrl: url }))).toBe('#42 · status unknown');
		expect(prSummary(session({ prUrl: url, pullRequest: { state: 'open', checks: 'failed', conflicts: true, approved: true, runs: [] } }))).toBe('#42 open · merge conflicts · checks failing · approved');
		expect(prSummary(session({ prUrl: url, pullRequest: { state: 'draft', checks: 'pending', runs: [] } }))).toBe('#42 draft · checks running');
		expect(prSummary(session({ prUrl: url, pullRequest: { state: 'merged', checks: 'failed', runs: [] } }))).toBe('#42 merged');
		expect(prColor('open')).not.toBe(prColor('merged'));
	});
	it('shows compact attention cues alongside the open identity, even with no check runs', () => {
		const thread = session({ prUrl: url, pullRequest: { state: 'open', checks: 'failed', conflicts: true, runs: [] } });
		const { rerender } = render(<PrStatus thread={thread} />);
		const status = screen.getByLabelText('Pull request #42 open · merge conflicts · checks failing');
		expect(status.style.color).toBe(prColor('open'));
		expect(screen.getByText('Conflicts')).toBeTruthy();
		expect(screen.getByText('Checks failing')).toBeTruthy();
		rerender(<PrStatus thread={thread} showConflicts={false} showFailing={false} />);
		expect(screen.queryByText('Conflicts')).toBeNull();
		expect(screen.queryByText('Checks failing')).toBeNull();
		rerender(<PrStatus thread={{ ...thread, pullRequest: { ...thread.pullRequest!, state: 'merged' } }} />);
		expect(screen.queryByText('Conflicts')).toBeNull();
		expect(screen.queryByText('Checks failing')).toBeNull();
	});

	it('gives every state and attention cue its own colour', () => {
		const tones = ['open', 'draft', 'merged', 'closed', 'conflicts'] as const;
		expect(new Set(tones.map(prTone)).size).toBe(tones.length);
		expect(prColor('merged')).toBe('var(--merged)');
		expect(prColor(null)).toBe('var(--text-3)');
		const thread = session({ prUrl: url, pullRequest: { state: 'open', checks: 'failed', conflicts: true, runs: [] } });
		render(<PrStatus thread={thread} />);
		expect(screen.getByText('Conflicts').style.color).toBe(prTone('conflicts'));
		expect(screen.getByText('Checks failing').style.color).toBe(prTone('failing'));
	});
	it('colours checks by how they stand', () => {
		const { rerender } = render(<PrChecks pull={{ state: 'open', checks: 'passed', runs: [] }} />);
		expect(screen.getByText('Checks passed').closest('span')!.style.color).toBe(prTone('passed'));
		rerender(<PrChecks pull={{ state: 'open', checks: 'pending', runs: [] }} />);
		expect(screen.getByText('Checks running').closest('span')!.style.color).toBe(prTone('running'));
	});
});
