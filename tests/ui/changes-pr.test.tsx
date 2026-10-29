import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setChangesScope } from '@/lib/workspace';
import type { ChangesPayload, PullRequestDetail, PullRequestItem } from '@/lib/api';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({
	session: vi.fn(),
	changes: vi.fn(),
	pulls: vi.fn(),
	pull: vi.fn(),
	pullDiff: vi.fn(async () => ({ patch: '' })),
	mergePull: vi.fn(),
	revertFile: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
vi.mock('@/lib/highlight', () => ({ highlight: async () => null }));

const { GitTab } = await import('@/components/git-tab');
const { HeaderChanges } = await import('@/components/shell');
const { PrTab } = await import('@/components/pr-tab');

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
		expect(screen.getByText('new')).toBeTruthy();
		expect(screen.getByRole('button', { name: /^b\.ts\s*\+1\s*M$/ })).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Whole branch' }));
		expect(await screen.findByRole('button', { name: /^a\.ts\s*\+1\s*M$/ })).toBeTruthy();
		expect(screen.getByText('pushed')).toBeTruthy();

		fireEvent.click(within(screen.getByRole('list', { name: 'Changed files' })).getByRole('button', { name: /^a\.ts/, expanded: true }));
		expect(within(screen.getByRole('list', { name: 'Changed files' })).getByRole('button', { name: /^a\.ts/, expanded: false })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Expand all files' }));
		expect(within(screen.getByRole('list', { name: 'Changed files' })).getByRole('button', { name: /^a\.ts/, expanded: true })).toBeTruthy();
	});

	it('says nothing is unpushed once a pull request has it all', async () => {
		api.changes.mockImplementation(async (_id: string, scope: string) => (scope === 'branch' ? changes(patch('a.ts', 'pushed'), { scope: 'branch', pushedSha: 'p1' }) : changes('', { pushedSha: 'p1' })));
		renderWithQueries(<GitTab sessionId="s1" />, [[['session', 's1'], session({ workspace: true })]]);
		expect(await screen.findByText('Nothing unpushed')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Show the whole branch' }));
		expect(await screen.findByText('pushed')).toBeTruthy();
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

	it('says so when the thread has opened none', async () => {
		api.pulls.mockResolvedValue({ pulls: [] });
		renderWithQueries(<PrTab sessionId="s1" />, [[['session', 's1'], session()]]);
		expect(await screen.findByText('No pull requests yet')).toBeTruthy();
	});
});
