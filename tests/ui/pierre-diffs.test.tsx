import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { DiffViewControls } from '@/components/workspace/diff-list';
import {
	DEFAULT_DIFF_PREFS,
	getCachedFileDiffMetadata,
	getDiffViewPrefs,
	getLineTextFromDiff,
	setDiffViewPrefs,
} from '@/lib/pierre-diffs';

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
});
