import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setChangesScope } from '@/lib/workspace';
import type { ChangesPayload, PullRequestDetail, PullRequestItem } from '@/lib/api/workspace';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({
	session: vi.fn(),
	changes: vi.fn(),
	pulls: vi.fn(),
	pull: vi.fn(),
	pullMetadata: vi.fn(async () => null),
	pullDiff: vi.fn(async () => ({ patch: '' })),
	mergePull: vi.fn(),
	revertFile: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

function diffShadowTexts(container: HTMLElement): string[] {
	return [...container.querySelectorAll('diffs-container')].map((node) => node.shadowRoot?.textContent ?? '');
}

function findDiffSpan(container: HTMLElement, text: string): HTMLSpanElement | undefined {
	for (const node of container.querySelectorAll('diffs-container')) {
		for (const span of node.shadowRoot?.querySelectorAll('[data-line] span') ?? []) {
			if (span.textContent?.trim() === text) return span as HTMLSpanElement;
		}
	}
	return undefined;
}

const { GitTab } = await import('@/components/workspace/git-tab');
const { HeaderChanges } = await import('@/components/shell/task-workspace');
const { PullRequestCard } = await import('@/components/thread/reply-cards');
const { PrTab } = await import('@/components/workspace/pr-tab');

const patch = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,1 @@\n+${line}\n`;

const changes = (patchText: string, patchFields: Partial<ChangesPayload> = {}): ChangesPayload => ({
	source: 'saved',
	at: null,
	branch: 'anton/task-s1',
	baseBranch: 'main',
	scope: 'unpushed',
	pushedSha: null,
	patch: patchText,
	log: [],
	...patchFields,
});

describe('Changes', () => {
	beforeEach(() => setChangesScope('s1', 'unpushed'));

	it('shows clickable change totals in the header, and hides them with an empty diff', async () => {
		const open = vi.fn();
		const view = renderWithQueries(<HeaderChanges sessionId="s1" onShowPanel={open} />, [[['changes', 's1', 'unpushed'], changes(patch('src/a.ts', 'new'))]]);
		fireEvent.click(screen.getByRole('button', { name: 'Open Changes: 1 file, 1 additions, 0 deletions' }));
		expect(open).toHaveBeenCalledWith('Changes');
		view.client.setQueryData(['changes', 's1', 'unpushed'], changes(''));
		await waitFor(() => expect(screen.queryByRole('button', { name: /Open Changes/ })).toBeNull());
	});

	it('lists the unpushed files with their diffs open under them, and the whole branch from the explorer', async () => {
		api.changes.mockImplementation(async (_id: string, scope: string) =>
			scope === 'branch' ? changes(patch('src/a.ts', 'pushed') + patch('src/b.ts', 'new'), { scope: 'branch', pushedSha: 'p1' }) : changes(patch('src/b.ts', 'new'), { pushedSha: 'p1' }),
		);
		renderWithQueries(<GitTab sessionId="s1" />, [[['session', 's1'], session({ workspace: true })]]);
		const list = await screen.findByRole('list', { name: 'Changed files' });
		expect(within(list).getAllByRole('listitem').map((row) => row.getAttribute('aria-label'))).toEqual(['src/b.ts']);
		expect(within(list).getByRole('button', { name: /^b\.ts/, expanded: true })).toBeTruthy();
		await waitFor(() => {
			expect(diffShadowTexts(list).join('\n')).toContain('new');
			const span = findDiffSpan(list, 'new');
			expect(span?.style.getPropertyValue('--diffs-token-dark')).toBe('var(--syntax-keyword)');
			expect(span?.style.getPropertyValue('--diffs-token-light')).toBe('var(--syntax-keyword)');
		}, { timeout: 3000 });
		expect(screen.getByRole('button', { name: /^b\.ts\s*\+1\s*M$/ })).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Whole branch' }));
		expect(await screen.findByRole('button', { name: /^a\.ts\s*\+1\s*M$/ })).toBeTruthy();
		await waitFor(() => expect(diffShadowTexts(screen.getByRole('list', { name: 'Changed files' })).join('\n')).toContain('pushed'));

		fireEvent.click(within(screen.getByRole('list', { name: 'Changed files' })).getByRole('button', { name: /^a\.ts/, expanded: true }));
		expect(within(screen.getByRole('list', { name: 'Changed files' })).getByRole('button', { name: /^a\.ts/, expanded: false })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Expand all files' }));
		expect(within(screen.getByRole('list', { name: 'Changed files' })).getByRole('button', { name: /^a\.ts/, expanded: true })).toBeTruthy();
	});

	it('says nothing is unpushed once a pull request has it all', async () => {
		api.changes.mockImplementation(async (_id: string, scope: string) => (scope === 'branch' ? changes(patch('a.ts', 'pushed'), { scope: 'branch', pushedSha: 'p1' }) : changes('', { pushedSha: 'p1' })));
		const view = renderWithQueries(<GitTab sessionId="s1" />, [[['session', 's1'], session({ workspace: true })]]);
		expect(await screen.findByText('Nothing unpushed')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Show the whole branch' }));
		await waitFor(() => expect(diffShadowTexts(view.container).join('\n')).toContain('pushed'));
	});
});

const item = (number: number, state: PullRequestItem['state'], current: boolean): PullRequestItem => ({
	url: `https://github.com/acme/demo/pull/${number}`,
	repo: 'acme/demo',
	number,
	title: `Change ${number}`,
	head: 'anton/task-s1',
	base: 'main',
	state,
	openedAt: '2026-10-02T00:00:00Z',
	mergedAt: null,
	current,
});

const detail = (number: number, patchFields: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
	url: `https://github.com/acme/demo/pull/${number}`,
	number,
	repo: 'acme/demo',
	title: `Change ${number}`,
	body: 'Why it changes',
	author: 'anton-bot',
	state: 'open',
	draft: false,
	headBranch: 'anton/task-s1',
	headSha: 'a'.repeat(40),
	baseBranch: 'main',
	createdAt: '2026-10-02T00:00:00Z',
	mergedAt: null,
	mergedBy: null,
	closedAt: null,
	additions: 3,
	deletions: 1,
	changedFiles: 1,
	mergeable: true,
	approved: false,
	commits: [{ sha: 'a'.repeat(40), subject: 'Change it' }],
	checks: [{ name: 'test', status: 'passed', summary: 'ok', url: 'https://ci.example.test' }],
	discussion: [{ id: 'review-1', kind: 'review', author: 'grace', body: 'Looks right', path: null, line: null, at: '2026-10-02T01:00:00Z', verdict: 'approved' }],
	...patchFields,
});

describe('PR', () => {
	it('merges the current PR from its reply after verifying it and a second click', async () => {
		const url = 'https://github.com/acme/demo/pull/13';
		api.pulls.mockReset().mockResolvedValue({ pulls: [item(13, 'open', true)] });
		api.pull.mockReset().mockResolvedValue(detail(13));
		api.mergePull.mockReset().mockResolvedValue(detail(13, { state: 'merged', mergedBy: 'you' }));
		renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Change 13" />, [[['session', 's1'], session({ prUrl: url, pullRequest: { state: 'open', checks: 'passed', runs: [] } })]]);
		expect(api.pull).not.toHaveBeenCalled();
		expect(api.pulls).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Squash and merge' }));
		const confirm = await screen.findByRole('button', { name: 'Click again to merge' });
		expect(api.mergePull).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(confirm);
		fireEvent.click(confirm);
		await waitFor(() => expect(api.mergePull).toHaveBeenCalledWith('s1', 13, { method: 'squash', sha: 'a'.repeat(40) }));
		expect(await screen.findByText(/^Merged by you/)).toBeTruthy();
	});
	it('blocks merge when the freshly read PR is a draft or has conflicts', async () => {
		const url = 'https://github.com/acme/demo/pull/13';
		api.pulls.mockReset().mockResolvedValue({ pulls: [item(13, 'open', true)] });
		api.pull.mockReset().mockResolvedValue(detail(13, { state: 'draft', draft: true, mergeable: false }));
		api.mergePull.mockReset();
		renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Change 13" />, [[['session', 's1'], session({ prUrl: url, pullRequest: { state: 'open', checks: null, runs: [] } })]]);
		fireEvent.click(screen.getByRole('button', { name: 'Squash and merge' }));
		expect(await screen.findByText('A draft cannot be merged; mark it ready on GitHub first.')).toBeTruthy();
		expect((screen.getByRole('button', { name: 'Click again to merge' }) as HTMLButtonElement).disabled).toBe(true);
		expect(api.mergePull).not.toHaveBeenCalled();
	});

	it('does not merge a PR absent from the task history', async () => {
		const url = 'https://github.com/acme/demo/pull/13';
		api.pulls.mockReset().mockResolvedValue({ pulls: [item(12, 'open', true)] });
		api.pull.mockReset();
		api.mergePull.mockReset();
		renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Change 13" />, [[['session', 's1'], session({ prUrl: url, pullRequest: { state: 'open', checks: null, runs: [] } })]]);
		fireEvent.click(screen.getByRole('button', { name: 'Squash and merge' }));
		expect((await screen.findByRole('alert')).textContent).toContain('not recorded');
		expect(api.pull).not.toHaveBeenCalled();
		expect(api.mergePull).not.toHaveBeenCalled();
	});
	it('does not offer chat merging for review tasks, historical cards, or merged PRs', () => {
		const url = 'https://github.com/acme/demo/pull/13';
		const view = renderWithQueries(<PullRequestCard sessionId="s1" url={url} title="Change 13" />, [[['session', 's1'], session({ prUrl: url, review: { number: 13, author: 'other', trusted: true, reviewedHead: null, automatic: false }, pullRequest: { state: 'open', checks: null, runs: [] } })]]);
		expect(screen.queryByRole('button', { name: 'Squash and merge' })).toBeNull();
		view.client.setQueryData(['session', 's1'], session({ prUrl: 'https://github.com/acme/demo/pull/14', pullRequest: { state: 'open', checks: null, runs: [] } }));
		expect(screen.queryByRole('button', { name: 'Squash and merge' })).toBeNull();
	});

	it("opens on the thread's current pull request, and merges it by squashing after a second click", async () => {
		api.pulls.mockResolvedValue({ pulls: [item(13, 'open', true), item(12, 'merged', false)] });
		api.pull.mockImplementation(async (_id: string, number: number) => detail(number, number === 12 ? { state: 'merged', mergedBy: 'ada', mergedAt: '2026-10-02T02:00:00Z' } : {}));
		api.mergePull.mockResolvedValue(detail(13, { state: 'merged', mergedBy: 'you', mergedAt: '2026-10-03T00:00:00Z' }));
		renderWithQueries(<PrTab sessionId="s1" />, [[['session', 's1'], session({ prUrl: 'https://github.com/acme/demo/pull/13' })]]);
		expect(await screen.findByRole('heading', { name: 'Change 13' })).toBeTruthy();
		expect(screen.getByText('Ready to merge')).toBeTruthy();

		fireEvent.click(screen.getByRole('tab', { name: /Discussion/ }));
		expect(screen.getByText('Looks right')).toBeTruthy();

		const merge = screen.getByRole('button', { name: 'Squash and merge' });
		fireEvent.click(merge);
		expect(api.mergePull).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Click again to merge' }));
		await waitFor(() => expect(api.mergePull).toHaveBeenCalledWith('s1', 13, { method: 'squash', sha: 'a'.repeat(40) }));
		expect(await screen.findByText(/^Merged by you/)).toBeTruthy();
	});

	it('bounds the changes diff in its own virtualized scroll container', async () => {
		api.pulls.mockReset().mockResolvedValue({ pulls: [item(13, 'open', true)] });
		api.pull.mockReset().mockResolvedValue(detail(13));
		api.pullDiff.mockReset().mockResolvedValue({ patch: patch('src/a.ts', 'new') });
		renderWithQueries(<PrTab sessionId="s1" />, [[['session', 's1'], session()]]);
		const list = await screen.findByRole('list', { name: 'Changed files' });
		await waitFor(() => expect(diffShadowTexts(list).join('\n')).toContain('new'));
		expect(list.parentElement?.className).toContain('flex-1');
		expect(list.parentElement?.className).toContain('overflow-auto');
		expect(list.closest('.in-well')?.className).toContain('min-h-0');
	});

	it('renders GitHub review threads inline in the diff with replies nested', async () => {
		api.pulls.mockReset().mockResolvedValue({ pulls: [item(13, 'open', true)] });
		api.pull.mockReset().mockResolvedValue(
			detail(13, {
				discussion: [
					{ id: 'line-50', kind: 'line', author: 'ana', body: 'Why drop the filter?', path: 'src/a.ts', line: 1, at: '2026-10-02T01:00:00Z', verdict: null, side: 'new' },
					{ id: 'line-51', kind: 'line', author: 'ben', body: 'It was empty after archiving', path: 'src/a.ts', line: 1, at: '2026-10-02T02:00:00Z', verdict: null, side: 'new', replyTo: 'line-50' },
				],
			}),
		);
		api.pullDiff.mockReset().mockResolvedValue({ patch: patch('src/a.ts', 'new') });
		renderWithQueries(<PrTab sessionId="s1" />, [[['session', 's1'], session()]]);
		expect(await screen.findByText('ana')).toBeTruthy();
		expect(screen.getAllByText('Why drop the filter?').length).toBeGreaterThan(0);
		expect(screen.getByText('It was empty after archiving')).toBeTruthy();
		expect(screen.getAllByText(/on GitHub/).length).toBeGreaterThan(0);
		expect(screen.getByText(/1 reply/)).toBeTruthy();
	});

	it('collapses resolved threads and marks outdated ones', async () => {
		api.pulls.mockReset().mockResolvedValue({ pulls: [item(13, 'open', true)] });
		api.pull.mockReset().mockResolvedValue(
			detail(13, {
				discussion: [
					{ id: 'line-50', kind: 'line', author: 'ana', body: 'Resolved note', path: 'src/a.ts', line: 1, at: '2026-10-02T01:00:00Z', verdict: null, side: 'new', resolved: true },
					{ id: 'line-52', kind: 'line', author: 'ben', body: 'Stale note', path: 'src/a.ts', line: 1, at: '2026-10-02T02:00:00Z', verdict: null, side: 'new', outdated: true },
				],
			}),
		);
		api.pullDiff.mockReset().mockResolvedValue({ patch: patch('src/a.ts', 'new') });
		renderWithQueries(<PrTab sessionId="s1" />, [[['session', 's1'], session()]]);
		expect((await screen.findAllByText('Resolved note')).length).toBeGreaterThan(0);
		const resolved = screen.getByText('resolved');
		expect(resolved).toBeTruthy();
		// The resolved thread renders collapsed: its details element is closed.
		expect(resolved.closest('details')?.open).toBe(false);
		expect(screen.getByText(/outdated/)).toBeTruthy();
	});

	it('nests replies under their starter in Discussion and jumps to the diff', async () => {
		api.pulls.mockReset().mockResolvedValue({ pulls: [item(13, 'open', true)] });
		api.pull.mockReset().mockResolvedValue(
			detail(13, {
				discussion: [
					{ id: 'line-50', kind: 'line', author: 'ana', body: 'Starter body', path: 'src/a.ts', line: 1, at: '2026-10-02T01:00:00Z', verdict: null, side: 'new' },
					{ id: 'line-51', kind: 'line', author: 'ben', body: 'Reply body', path: 'src/a.ts', line: 1, at: '2026-10-02T03:00:00Z', verdict: null, side: 'new', replyTo: 'line-50' },
					{ id: 'note-1', kind: 'comment', author: 'grace', body: 'General note', path: null, line: null, at: '2026-10-02T02:00:00Z', verdict: null },
				],
			}),
		);
		api.pullDiff.mockReset().mockResolvedValue({ patch: patch('src/a.ts', 'new') });
		renderWithQueries(<PrTab sessionId="s1" />, [[['session', 's1'], session()]]);
		fireEvent.click(await screen.findByRole('tab', { name: /Discussion/ }));
		const starter = await screen.findByText('Starter body');
		expect(screen.getByText('Reply body')).toBeTruthy();
		// The reply is nested under the starter in the same thread block, before the later general note.
		const replyItem = screen.getByText('Reply body').closest('li');
		expect(replyItem?.className).toContain('pl-9');
		// The path:line reference is a jump link that switches to the Changes tab.
		const jump = screen.getAllByRole('button', { name: /src\/a\.ts:1/ })[0]!;
		fireEvent.click(jump);
		await waitFor(() => expect(screen.getByRole('list', { name: 'Changed files' })).toBeTruthy());
	});

	it('says so when the thread has opened none', async () => {
		api.pulls.mockResolvedValue({ pulls: [] });
		renderWithQueries(<PrTab sessionId="s1" />, [[['session', 's1'], session()]]);
		expect(await screen.findByText('No pull requests yet')).toBeTruthy();
	});
});
