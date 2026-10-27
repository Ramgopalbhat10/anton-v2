import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PrStatus, prColor, prSummary } from '@/components/pr-status';
import { session } from './render';

const url = 'https://github.com/acme/demo/pull/42?x=1';
describe('pull request presentation', () => {
	it.each(['open', 'merged', 'draft', 'closed'] as const)('shows %s consistently with an accessible link', (state) => {
		const thread = session({ prUrl: url, pullRequest: { state, checks: null, runs: [] } });
		render(<PrStatus thread={thread} link full />);
		const link = screen.getByRole('link', { name: `Pull request #42 ${state}` });
		expect(link.getAttribute('href')).toBe(url);
		expect(link.getAttribute('style')).toContain(prColor(state));
	});
	it('keeps state and attention details together, without treating unknown as open', () => {
		expect(prSummary(session({ prUrl: url }))).toBe('#42 · status unknown');
		expect(prSummary(session({ prUrl: url, pullRequest: { state: 'open', checks: 'failed', conflicts: true, approved: true, runs: [] } }))).toBe('#42 open · merge conflicts · checks failing · approved');
		expect(prSummary(session({ prUrl: url, pullRequest: { state: 'draft', checks: 'pending', runs: [] } }))).toBe('#42 draft · checks running');
		expect(prSummary(session({ prUrl: url, pullRequest: { state: 'merged', checks: 'failed', runs: [] } }))).toBe('#42 merged');
		expect(prColor('open')).not.toBe(prColor('merged'));
	});
});
