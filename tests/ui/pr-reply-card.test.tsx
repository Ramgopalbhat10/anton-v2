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
});
