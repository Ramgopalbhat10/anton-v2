import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PullRequestCard } from '@/components/reply-cards';
import { renderWithQueries, session } from './render';

describe('pull request reply card', () => {
	it('shows a merged PR as a chip without visible merged text', () => {
		const url = 'https://github.com/acme/demo/pull/42';
		renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Fix checkout" />, [
			[['session', 's1'], session({ prUrl: url, pullRequest: { state: 'merged', checks: null, runs: [] } })],
		]);
		const card = screen.getByRole('link', { name: /Fix checkout/ });
		const chip = within(card).getByLabelText('Pull request #42 merged');
		expect(chip.textContent).toBe('#42');
		expect(chip.querySelector('.lucide-git-merge')).toBeTruthy();
		expect(card.textContent).not.toMatch(/merged/i);
		expect(card.getAttribute('href')).toBe(url);
	});
	it('shows merged branch and diff metadata for the matching PR', () => {
		const url = 'https://github.com/acme/demo/pull/42';
		renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Fix checkout" />, [
			[['session', 's1'], session({ prUrl: url, pullRequest: { state: 'merged', checks: null, runs: [] } })],
			[['pull', 's1', 42], { url, state: 'merged', headBranch: 'anton/fix', baseBranch: 'main', additions: 42, deletions: 7 }],
		]);
		expect(screen.getByText('anton/fix → main')).toBeTruthy();
		expect(screen.getByLabelText('42 additions, 7 deletions').textContent).toContain('+42');
	});
	it('does not show metadata for a different PR', () => {
		const url = 'https://github.com/acme/demo/pull/42';
		renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Fix checkout" />, [
			[['session', 's1'], session({ prUrl: url, pullRequest: { state: 'merged', checks: null, runs: [] } })],
			[['pull', 's1', 42], { url: 'https://github.com/other/demo/pull/42', state: 'merged', headBranch: 'wrong', baseBranch: 'main', additions: 1, deletions: 2 }],
		]);
		expect(screen.queryByText('wrong → main')).toBeNull();
	});

});
