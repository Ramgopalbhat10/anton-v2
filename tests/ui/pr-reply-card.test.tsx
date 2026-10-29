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
			[['pr-metadata', 's1', 42], { url, state: 'merged', headBranch: 'anton/fix', baseBranch: 'main', additions: 42, deletions: 7 }],
		]);
		expect(screen.getByText('anton/fix → main')).toBeTruthy();
		expect(screen.getByLabelText('42 additions, 7 deletions').textContent).toContain('+42');
	});
	it('shows branches, diff and checks separately for an open PR', () => {
		const url = 'https://github.com/acme/demo/pull/42';
		renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Fix" />, [
			[['session', 's1'], session({ prUrl: url, pullRequest: { state: 'open', checks: 'passed', runs: [] } })],
			[['pr-metadata', 's1', 42], { url, state: 'open', headBranch: 'anton/fix', baseBranch: 'main', additions: 42, deletions: 7 }],
		]);
		expect(screen.getByLabelText('Pull request #42 open · checks pass').textContent).toBe('#42');
		expect(screen.getByText('anton/fix → main')).toBeTruthy();
		expect(screen.getByText('Checks passed').querySelector('.lucide-circle-check')).toBeTruthy();
	});
	it.each(['passed', 'pending', 'failed'] as const)('shows %s checks on a draft PR', (checks) => {
		const url = 'https://github.com/acme/demo/pull/42';
		renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Draft" />, [[['session', 's1'], session({ prUrl: url, pullRequest: { state: 'draft', checks, runs: [] } })]]);
		expect(screen.getByText({ passed: 'Checks passed', pending: 'Checks running', failed: 'Checks failing' }[checks])).toBeTruthy();
	});

	it('hides stale checks after merge', () => {
		const url = 'https://github.com/acme/demo/pull/42';
		renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Fix" />, [[['session', 's1'], session({ prUrl: url, pullRequest: { state: 'merged', checks: 'passed', runs: [] } })]]);
		expect(screen.queryByText('Checks passed')).toBeNull();
	});

	it('does not show metadata for a different PR', () => {
		const url = 'https://github.com/acme/demo/pull/42';
		renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Fix checkout" />, [
			[['session', 's1'], session({ prUrl: url, pullRequest: { state: 'merged', checks: null, runs: [] } })],
			[['pr-metadata', 's1', 42], { url: 'https://github.com/other/demo/pull/42', state: 'merged', headBranch: 'wrong', baseBranch: 'main', additions: 1, deletions: 2 }],
		]);
		expect(screen.queryByText('wrong → main')).toBeNull();
	});

});
