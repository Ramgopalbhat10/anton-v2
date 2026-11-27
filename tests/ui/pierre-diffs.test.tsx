import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeList, DiffViewControls, useOpenFiles } from '@/components/workspace/diff-list';
import { parsePatch } from '@/lib/diff';
import {
	createDiffFilesLoader,
	DEFAULT_DIFF_PREFS,
	filesMatchDiffMetadata,
	getCachedFileDiffMetadata,
	getDiffCommentTargets,
	getDiffViewPrefs,
	getLineTextFromDiff,
	normalizeDiffLine,
	resolveCommentTarget,
	setDiffViewPrefs,
} from '@/lib/pierre-diffs';
import type { ReviewComment } from '@/lib/review';
import { renderWithQueries } from './render';

const SAMPLE_PATCH = [
	'diff --git a/src/sample.ts b/src/sample.ts',
	'index 1111111..2222222 100644',
	'--- a/src/sample.ts',
	'+++ b/src/sample.ts',
	'@@ -2,3 +2,3 @@',
	' const keepOne = 1;',
	'-const oldVal = "a";',
	'+const newVal = "b";',
	' const keepTwo = 2;',
	'@@ -20,2 +20,3 @@',
	' function tail() {',
	'+  return newVal;',
	' }',
	'',
].join('\n');

describe('pierre-diffs helpers & controls', () => {
	beforeEach(() => {
		setDiffViewPrefs(DEFAULT_DIFF_PREFS);
	});

	it('preserves FileDiffMetadata object identity when a patch is unchanged and replaces it when changed', () => {
		const first = getCachedFileDiffMetadata({ path: 'src/sample.ts' }, SAMPLE_PATCH);
		const second = getCachedFileDiffMetadata({ path: 'src/sample.ts' }, SAMPLE_PATCH);
		expect(first).not.toBeNull();
		expect(second).toBe(first);

		const modified = getCachedFileDiffMetadata({ path: 'src/sample.ts' }, SAMPLE_PATCH.replace('"b"', '"c"'));
		expect(modified).not.toBeNull();
		expect(modified).not.toBe(first);
	});

	it('resolves 1-based line text across context, deletions, additions, and multiple hunks', () => {
		const metadata = getCachedFileDiffMetadata({ path: 'src/sample.ts' }, SAMPLE_PATCH)!;
		expect(getLineTextFromDiff(metadata, 'additions', 2)).toBe('const keepOne = 1;');
		expect(getLineTextFromDiff(metadata, 'deletions', 3)).toBe('const oldVal = "a";');
		expect(getLineTextFromDiff(metadata, 'additions', 3)).toBe('const newVal = "b";');
		expect(getLineTextFromDiff(metadata, 'additions', 21)).toBe('  return newVal;');
		expect(getLineTextFromDiff(metadata, 'deletions', 21)).toBe('}');
		expect(getLineTextFromDiff(metadata, 'additions', 99)).toBeNull();
	});

	it('resolves canonical review comment targets across deletions, shifted context lines, additions, and deleted files', () => {
		const metadata = getCachedFileDiffMetadata({ path: 'src/sample.ts' }, SAMPLE_PATCH)!;
		// Removed line on deletions stays on old side
		expect(resolveCommentTarget(metadata, 'deletions', 3)).toEqual({ side: 'old', line: 3 });
		// Context line in first hunk on deletions maps to new side
		expect(resolveCommentTarget(metadata, 'deletions', 2)).toEqual({ side: 'new', line: 2 });
		// Shifted context line after an insertion in second hunk maps to new side line number
		expect(resolveCommentTarget(metadata, 'deletions', 21)).toEqual({ side: 'new', line: 22 });
		// Additions stay on new side
		expect(resolveCommentTarget(metadata, 'additions', 3)).toEqual({ side: 'new', line: 3 });
		expect(resolveCommentTarget(metadata, 'additions', 21)).toEqual({ side: 'new', line: 21 });

		const shiftedHunkPatch = [
			'diff --git a/src/shifted.ts b/src/shifted.ts',
			'index 1111111..2222222 100644',
			'--- a/src/shifted.ts',
			'+++ b/src/shifted.ts',
			'@@ -1,2 +1,3 @@',
			' const a = 1;',
			'+const extra = 2;',
			' const b = 3;',
			'@@ -10,2 +11,2 @@',
			' const tailA = 10;',
			' const tailB = 11;',
			'',
		].join('\n');
		const shifted = getCachedFileDiffMetadata({ path: 'src/shifted.ts' }, shiftedHunkPatch)!;
		expect(resolveCommentTarget(shifted, 'deletions', 10)).toEqual({ side: 'new', line: 11 });

		const deletedPatch = [
			'diff --git a/src/gone.ts b/src/gone.ts',
			'deleted file mode 100644',
			'index 1111111..0000000',
			'--- a/src/gone.ts',
			'+++ /dev/null',
			'@@ -1,2 +0,0 @@',
			'-const gone = 1;',
			'-export default gone;',
			'',
		].join('\n');
		const deleted = getCachedFileDiffMetadata({ path: 'src/gone.ts' }, deletedPatch)!;
		expect(resolveCommentTarget(deleted, 'deletions', 1)).toEqual({ side: 'old', line: 1 });
	});

	it('groups multiple comments on the same line and outdated comments into a single shadow DOM slot each', async () => {
		const files = parsePatch(SAMPLE_PATCH);
		const comments: ReviewComment[] = [
			{ path: 'src/sample.ts', side: 'new', line: 3, code: 'const newVal = "b";', text: 'First comment on line 3' },
			{ path: 'src/sample.ts', side: 'new', line: 3, code: 'const newVal = "b";', text: 'Second comment on line 3' },
			{ path: 'src/sample.ts', side: 'new', line: 9, code: 'stale line one', text: 'First outdated comment' },
			{ path: 'src/sample.ts', side: 'new', line: 12, code: 'stale line two', text: 'Second outdated comment' },
		];
		const review = {
			comments,
			add: vi.fn(),
			remove: vi.fn(),
			removeAll: vi.fn(),
			clear: vi.fn(),
		};

		function Harness() {
			const open = useOpenFiles(files);
			return <ChangeList files={files} open={open} review={review} />;
		}

		const { container } = renderWithQueries(<Harness />);

		expect(await screen.findByText('First comment on line 3')).toBeTruthy();
		expect(screen.getByText('Second comment on line 3')).toBeTruthy();
		expect(screen.getByText('First outdated comment')).toBeTruthy();
		expect(screen.getByText('Second outdated comment')).toBeTruthy();
		expect(screen.getByText('Line 9 has changed since this comment')).toBeTruthy();
		expect(screen.getByText('Line 12 has changed since this comment')).toBeTruthy();

		await waitFor(() => {
			const shadow = container.querySelector('diffs-container')?.shadowRoot;
			expect(shadow).toBeTruthy();
			expect(shadow?.querySelectorAll('slot[name="annotation-additions-3"]')).toHaveLength(1);
			expect(shadow?.querySelectorAll('slot[name="annotation-additions-0"]')).toHaveLength(1);
		});
	});

	it('enumerates ordered visible comment targets across context, deleted, and added lines', () => {
		const metadata = getCachedFileDiffMetadata({ path: 'src/sample.ts' }, SAMPLE_PATCH)!;
		expect(getDiffCommentTargets(metadata)).toEqual([
			{ side: 'additions', lineNumber: 2 },
			{ side: 'deletions', lineNumber: 3 },
			{ side: 'additions', lineNumber: 3 },
			{ side: 'additions', lineNumber: 4 },
			{ side: 'additions', lineNumber: 20 },
			{ side: 'additions', lineNumber: 21 },
			{ side: 'additions', lineNumber: 22 },
		]);

		const deletedPatch = [
			'diff --git a/src/gone.ts b/src/gone.ts',
			'deleted file mode 100644',
			'index 1111111..0000000',
			'--- a/src/gone.ts',
			'+++ /dev/null',
			'@@ -1,2 +0,0 @@',
			'-const gone = 1;',
			'-export default gone;',
			'',
		].join('\n');
		const deleted = getCachedFileDiffMetadata({ path: 'src/gone.ts' }, deletedPatch)!;
		expect(getDiffCommentTargets(deleted)).toEqual([
			{ side: 'deletions', lineNumber: 1 },
			{ side: 'deletions', lineNumber: 2 },
		]);
	});

	it('lets keyboard-only users target diff lines and open inline comments', async () => {
		const user = userEvent.setup();
		const files = parsePatch(SAMPLE_PATCH);
		const add = vi.fn();
		const review = {
			comments: [] as ReviewComment[],
			add,
			remove: vi.fn(),
			removeAll: vi.fn(),
			clear: vi.fn(),
		};

		function Harness() {
			const open = useOpenFiles(files);
			return <ChangeList files={files} open={open} review={review} />;
		}

		renderWithQueries(<Harness />);

		const region = await screen.findByRole('region', { name: /Diff for src\/sample\.ts/ });
		act(() => region.focus());

		fireEvent.keyDown(region, { key: 'ArrowDown' });
		fireEvent.keyDown(region, { key: 'Enter' });

		const textarea = await screen.findByLabelText('Comment');
		expect(document.activeElement).toBe(textarea);
		await user.type(textarea, 'Fix removed line');
		await user.click(screen.getByRole('button', { name: 'Add comment' }));

		expect(add).toHaveBeenCalledWith({
			path: 'src/sample.ts',
			side: 'old',
			line: 3,
			code: 'const oldVal = "a";',
			text: 'Fix removed line',
		});

		act(() => region.focus());
		fireEvent.keyDown(region, { key: 'Home' });
		fireEvent.keyDown(region, { key: 'ArrowDown' });
		fireEvent.keyDown(region, { key: 'ArrowDown' });
		fireEvent.keyDown(region, { key: 'Enter' });

		const nextTextarea = await screen.findByLabelText('Comment');
		await user.type(nextTextarea, 'Review added line');
		await user.click(screen.getByRole('button', { name: 'Add comment' }));

		expect(add).toHaveBeenLastCalledWith({
			path: 'src/sample.ts',
			side: 'new',
			line: 3,
			code: 'const newVal = "b";',
			text: 'Review added line',
		});
	});

	it('preserves unsaved draft text when deleting an earlier saved comment', async () => {
		const user = userEvent.setup();
		const files = parsePatch(SAMPLE_PATCH);

		function Harness() {
			const open = useOpenFiles(files);
			const [comments, setComments] = useState<ReviewComment[]>([
				{ path: 'src/sample.ts', side: 'new', line: 3, code: 'const newVal = "b";', text: 'Saved comment on line 3' },
			]);
			const review = {
				comments,
				add: (comment: ReviewComment) => setComments((now) => [...now, comment]),
				remove: (comment: ReviewComment) => setComments((now) => now.filter((item) => item !== comment)),
				removeAll: (sent: ReviewComment[]) => setComments((now) => now.filter((item) => !sent.includes(item))),
				clear: () => setComments([]),
			};
			return <ChangeList files={files} open={open} review={review} />;
		}

		renderWithQueries(<Harness />);

		expect(await screen.findByText('Saved comment on line 3')).toBeTruthy();

		const region = screen.getByRole('region', { name: /Diff for src\/sample\.ts/ });
		act(() => region.focus());
		fireEvent.keyDown(region, { key: 'End' });
		fireEvent.keyDown(region, { key: 'Enter' });

		const textarea = (await screen.findByLabelText('Comment')) as HTMLTextAreaElement;
		await user.type(textarea, 'Keep this unsaved draft');
		expect(textarea.value).toBe('Keep this unsaved draft');

		await user.click(screen.getByRole('button', { name: 'Delete comment' }));

		expect(screen.queryByText('Saved comment on line 3')).toBeNull();
		const keptTextarea = screen.getByLabelText('Comment') as HTMLTextAreaElement;
		expect(keptTextarea.value).toBe('Keep this unsaved draft');
	});

	it('updates persisted diff display preferences from DiffViewControls', async () => {
		const user = userEvent.setup();
		render(<DiffViewControls />);

		fireEvent.click(screen.getByRole('radio', { name: 'Stacked' }));
		expect(getDiffViewPrefs().diffStyle).toBe('unified');

		await user.click(screen.getByRole('button', { name: 'Diff display options' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Classic (+/-)' }));
		expect(getDiffViewPrefs().diffIndicators).toBe('classic');

		await user.click(screen.getByRole('button', { name: 'Diff display options' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Character' }));
		expect(getDiffViewPrefs().lineDiffType).toBe('char');

		await user.click(screen.getByRole('button', { name: 'Diff display options' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Line backgrounds' }));
		await user.click(screen.getByRole('menuitem', { name: 'Wrap lines' }));
		await user.click(screen.getByRole('menuitem', { name: 'Line numbers' }));
		expect(getDiffViewPrefs()).toMatchObject({
			diffStyle: 'unified',
			diffIndicators: 'classic',
			lineDiffType: 'char',
			disableBackground: true,
			overflow: 'wrap',
			disableLineNumbers: true,
		});
	});

	it('moves Split/Stacked into Diff display options when compact', async () => {
		const user = userEvent.setup();
		render(<DiffViewControls compact />);

		expect(screen.queryByRole('radio', { name: 'Split' })).toBeNull();
		expect(screen.queryByRole('radio', { name: 'Stacked' })).toBeNull();

		await user.click(screen.getByRole('button', { name: 'Diff display options' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Stacked' }));
		expect(getDiffViewPrefs().diffStyle).toBe('unified');

		await user.click(screen.getByRole('button', { name: 'Diff display options' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Split' }));
		expect(getDiffViewPrefs().diffStyle).toBe('split');
	});

	it('treats pre-upgrade CRLF draft comments as inline after stripping trailing CR', async () => {
		expect(normalizeDiffLine('const newVal = "b";\r\n')).toBe('const newVal = "b";');

		const files = parsePatch(SAMPLE_PATCH);
		const review = {
			comments: [
				{ path: 'src/sample.ts', side: 'new' as const, line: 3, code: 'const newVal = "b";\r', text: 'Pre-upgrade CRLF comment' },
			],
			add: vi.fn(),
			remove: vi.fn(),
			removeAll: vi.fn(),
			clear: vi.fn(),
		};

		function Harness() {
			const open = useOpenFiles(files);
			return <ChangeList files={files} open={open} review={review} />;
		}

		const { container } = renderWithQueries(<Harness />);
		expect(await screen.findByText('Pre-upgrade CRLF comment')).toBeTruthy();
		expect(screen.queryByText(/has changed since this comment/)).toBeNull();

		await waitFor(() => {
			const shadow = container.querySelector('diffs-container')?.shadowRoot;
			expect(shadow?.querySelectorAll('slot[name="annotation-additions-3"]')).toHaveLength(1);
			expect(shadow?.querySelectorAll('slot[name="annotation-additions-0"]')).toHaveLength(0);
		});
	});

	it('restores focus to the diff region with preventScroll after Ctrl+Enter comment submission', async () => {
		const user = userEvent.setup();
		const files = parsePatch(SAMPLE_PATCH);
		const add = vi.fn();
		const review = {
			comments: [] as ReviewComment[],
			add,
			remove: vi.fn(),
			removeAll: vi.fn(),
			clear: vi.fn(),
		};

		function Harness() {
			const open = useOpenFiles(files);
			return <ChangeList files={files} open={open} review={review} />;
		}

		renderWithQueries(<Harness />);

		const region = await screen.findByRole('region', { name: /Diff for src\/sample\.ts/ });
		const focusSpy = vi.spyOn(region, 'focus');
		act(() => region.focus());

		fireEvent.keyDown(region, { key: 'ArrowDown' });
		fireEvent.keyDown(region, { key: 'Enter' });

		const textarea = await screen.findByLabelText('Comment');
		await user.type(textarea, 'Submit via shortcut');
		focusSpy.mockClear();
		fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

		expect(add).toHaveBeenCalledWith({
			path: 'src/sample.ts',
			side: 'old',
			line: 3,
			code: 'const oldVal = "a";',
			text: 'Submit via shortcut',
		});
		expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
		expect(document.activeElement).toBe(region);

		fireEvent.keyDown(region, { key: 'ArrowDown' });
		fireEvent.keyDown(region, { key: 'Enter' });
		const nextTextarea = await screen.findByLabelText('Comment');
		await user.type(nextTextarea, 'Immediate next target');
		await user.click(screen.getByRole('button', { name: 'Add comment' }));

		expect(add).toHaveBeenLastCalledWith({
			path: 'src/sample.ts',
			side: 'new',
			line: 3,
			code: 'const newVal = "b";',
			text: 'Immediate next target',
		});
	});

	it('adapts diff file endpoints with createDiffFilesLoader and expands hidden context lines in ChangeList', async () => {
		const middle = Array.from({ length: 15 }, (_, index) => `const mid${index + 5} = ${index + 5};`);
		const oldText = ['// header', 'const keepOne = 1;', 'const oldVal = "a";', 'const keepTwo = 2;', ...middle, 'function tail() {', '}'].join('\n');
		const newText = ['// header', 'const keepOne = 1;', 'const newVal = "b";', 'const keepTwo = 2;', ...middle, 'function tail() {', '  return newVal;', '}'].join('\n');

		const fetchFiles = vi.fn(async () => ({ oldText, newText }));
		const loader = createDiffFilesLoader(fetchFiles);
		const changeMeta = getCachedFileDiffMetadata({ path: 'src/sample.ts' }, SAMPLE_PATCH)!;
		const loaded = await loader({ ...changeMeta, prevName: 'src/old-sample.ts', type: 'change' });
		expect(fetchFiles).toHaveBeenCalledWith({ path: 'src/sample.ts', prevPath: 'src/old-sample.ts' });
		expect(loaded.oldFile).toEqual({
			name: 'src/old-sample.ts',
			contents: oldText,
			cacheKey: expect.stringContaining('anton-file:src/old-sample.ts:'),
		});
		expect(loaded.newFile).toEqual({
			name: 'src/sample.ts',
			contents: newText,
			cacheKey: expect.stringContaining('anton-file:src/sample.ts:'),
		});

		const renamePure = await createDiffFilesLoader(async () => ({ oldText: null, newText }))({
			...changeMeta,
			name: 'src/renamed.ts',
			prevName: 'src/sample.ts',
			type: 'rename-pure',
		});
		expect(renamePure.oldFile).toBeNull();
		expect(renamePure.newFile?.name).toBe('src/renamed.ts');

		await expect(
			createDiffFilesLoader(async () => ({ oldText: null, newText }))(changeMeta),
		).rejects.toThrow(/Could not load full file contents/);

		const files = parsePatch(SAMPLE_PATCH);
		const expandFetch = vi.fn(async () => ({ oldText, newText }));
		const review = {
			comments: [] as ReviewComment[],
			add: vi.fn(),
			remove: vi.fn(),
			removeAll: vi.fn(),
			clear: vi.fn(),
		};

		function Harness() {
			const open = useOpenFiles(files);
			return <ChangeList files={files} open={open} review={review} loadDiffFiles={createDiffFilesLoader(expandFetch)} />;
		}

		const { container } = renderWithQueries(<Harness />);
		await waitFor(() => {
			const shadow = container.querySelector('diffs-container')?.shadowRoot;
			const middleSeparator = Array.from(shadow?.querySelectorAll('[data-separator]') ?? []).find((el) =>
				el.textContent?.includes('15 unmodified'),
			);
			expect(middleSeparator?.querySelector('[data-expand-button]')).toBeTruthy();
		});

		const shadow = container.querySelector('diffs-container')!.shadowRoot!;
		const middleSeparator = Array.from(shadow.querySelectorAll('[data-separator]')).find((el) =>
			el.textContent?.includes('15 unmodified'),
		)!;
		const expandButton = middleSeparator.querySelector('[data-expand-button]') as HTMLElement;
		fireEvent.click(expandButton);

		await waitFor(() => {
			expect(expandFetch).toHaveBeenCalledWith({ path: 'src/sample.ts', prevPath: undefined });
			expect(shadow.textContent).toContain('mid10');
		});
	});

	it('re-syncs line annotations after expanded context hydrates the diff', async () => {
		const middle = Array.from({ length: 15 }, (_, index) => `const mid${index + 5} = ${index + 5};`);
		const oldText = ['// header', 'const keepOne = 1;', 'const oldVal = "a";', 'const keepTwo = 2;', ...middle, 'function tail() {', '}'].join('\n');
		const newText = ['// header', 'const keepOne = 1;', 'const newVal = "b";', 'const keepTwo = 2;', ...middle, 'function tail() {', '  return newVal;', '}'].join('\n');
		const files = parsePatch(SAMPLE_PATCH.replaceAll('src/sample.ts', 'src/resync-sample.ts'));
		const review = {
			comments: [{ path: 'src/resync-sample.ts', side: 'new' as const, line: 10, code: 'const mid10 = 10;', text: 'Hidden line note' }],
			add: vi.fn(),
			remove: vi.fn(),
			removeAll: vi.fn(),
			clear: vi.fn(),
		};

		function Harness() {
			const open = useOpenFiles(files);
			return <ChangeList files={files} open={open} review={review} loadDiffFiles={createDiffFilesLoader(async () => ({ oldText, newText }))} />;
		}

		const { container } = renderWithQueries(<Harness />);
		expect(await screen.findByText('Hidden line note')).toBeTruthy();
		expect(screen.getByText('Line 10 has changed since this comment')).toBeTruthy();

		const shadow = container.querySelector('diffs-container')!.shadowRoot!;
		await waitFor(() => {
			const middleSeparator = Array.from(shadow.querySelectorAll('[data-separator]')).find((el) => el.textContent?.includes('15 unmodified'));
			expect(middleSeparator?.querySelector('[data-expand-button]')).toBeTruthy();
		});
		const middleSeparator = Array.from(shadow.querySelectorAll('[data-separator]')).find((el) => el.textContent?.includes('15 unmodified'))!;
		fireEvent.click(middleSeparator.querySelector('[data-expand-button]') as HTMLElement);

		await waitFor(() => expect(shadow.textContent).toContain('mid10'));
		await waitFor(() => expect(screen.queryByText('Line 10 has changed since this comment')).toBeNull());
		expect(screen.getByText('Hidden line note')).toBeTruthy();
	});

	it('rejects stale expanded files when contents diverge from displayed hunks and surfaces expansion errors inline', async () => {
		const user = userEvent.setup();
		const stalePatch = SAMPLE_PATCH.replaceAll('src/sample.ts', 'src/stale.ts');
		const middle = Array.from({ length: 15 }, (_, index) => `const mid${index + 5} = ${index + 5};`);
		const oldText = ['// header', 'const keepOne = 1;', 'const oldVal = "a";', 'const keepTwo = 2;', ...middle, 'function tail() {', '}'].join('\n');
		const editedInGap = ['// header', 'const keepOne = 1;', 'const newVal = "b";', 'const keepTwo = 2;', ...middle.slice(0, 7), 'const mid12 = 999;', ...middle.slice(8), 'function tail() {', '  return newVal;', '}'].join('\n');
		const insertedLine = ['// header', 'const keepOne = 1;', 'const newVal = "b";', 'const keepTwo = 2;', 'const inserted = true;', ...middle, 'function tail() {', '  return newVal;', '}'].join('\n');

		const meta = getCachedFileDiffMetadata({ path: 'src/stale.ts' }, stalePatch)!;
		expect(filesMatchDiffMetadata(meta, oldText, editedInGap)).toBe(false);
		expect(filesMatchDiffMetadata(meta, oldText, insertedLine)).toBe(false);

		const onStale = vi.fn();
		const staleLoader = createDiffFilesLoader(async () => ({ oldText, newText: editedInGap }), { onStale });
		await expect(staleLoader(meta)).rejects.toThrow(/File changed since this diff loaded/);
		expect(onStale).toHaveBeenCalledTimes(1);

		const files = parsePatch(stalePatch);
		function StaleHarness() {
			const open = useOpenFiles(files);
			return <ChangeList files={files} open={open} loadDiffFiles={staleLoader} />;
		}

		const staleView = renderWithQueries(<StaleHarness />);
		await waitFor(() => {
			const shadow = staleView.container.querySelector('diffs-container')?.shadowRoot;
			const sep = Array.from(shadow?.querySelectorAll('[data-separator]') ?? []).find((el) => el.textContent?.includes('15 unmodified'));
			expect(sep?.querySelector('[data-expand-button]')).toBeTruthy();
		});
		const staleShadow = staleView.container.querySelector('diffs-container')!.shadowRoot!;
		const staleSep = Array.from(staleShadow.querySelectorAll('[data-separator]')).find((el) => el.textContent?.includes('15 unmodified'))!;
		fireEvent.click(staleSep.querySelector('[data-expand-button]') as HTMLElement);

		const staleAlert = await staleView.findByRole('alert');
		expect(staleAlert.textContent).toContain('File changed since this diff loaded. Refreshing diff…');
		expect(staleShadow.textContent).not.toContain('999');
		expect(staleShadow.textContent).toContain('const oldVal = "a";');
		staleView.unmount();

		function ErrorHarness() {
			const open = useOpenFiles(files);
			return (
				<ChangeList
					files={files}
					open={open}
					loadDiffFiles={createDiffFilesLoader(async () => {
						throw new Error('File too large to expand context.');
					})}
				/>
			);
		}

		const errView = renderWithQueries(<ErrorHarness />);
		await waitFor(() => {
			const shadow = errView.container.querySelector('diffs-container')?.shadowRoot;
			const sep = Array.from(shadow?.querySelectorAll('[data-separator]') ?? []).find((el) => el.textContent?.includes('15 unmodified'));
			expect(sep?.querySelector('[data-expand-button]')).toBeTruthy();
		});
		const errShadow = errView.container.querySelector('diffs-container')!.shadowRoot!;
		const errSep = Array.from(errShadow.querySelectorAll('[data-separator]')).find((el) => el.textContent?.includes('15 unmodified'))!;
		fireEvent.click(errSep.querySelector('[data-expand-button]') as HTMLElement);

		const errAlert = await errView.findByRole('alert');
		expect(errAlert.textContent).toContain('File too large to expand context.');
		expect(errShadow.textContent).toContain('const newVal = "b";');

		await user.click(errView.getByRole('button', { name: 'Dismiss expansion error' }));
		expect(errView.queryByRole('alert')).toBeNull();
	});
});
