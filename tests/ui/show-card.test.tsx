import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShowCard } from '@/components/thread/show-card';
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
	'',
].join('\n');

function renderDiff(patch: string) {
	return renderWithQueries(
		<ShowCard
			sessionId="s1"
			input={{ title: 'A patch', children: [{ type: 'diff', path: 'src/sample.ts', patch }] }}
			place={{ latest: true, answer: null }}
		/>,
	);
}

describe('show card diffs', () => {
	it('renders a valid git patch with the themed diff renderer', async () => {
		const { container } = renderDiff(SAMPLE_PATCH);

		expect(screen.getByText('src/sample.ts')).toBeTruthy();
		await waitFor(() => {
			const shadow = container.querySelector('diffs-container')?.shadowRoot;
			expect(shadow?.textContent).toContain('const oldVal = "a";');
			expect(shadow?.textContent).toContain('const newVal = "b";');
		});
		expect(container.querySelector('pre')).toBeNull();
	});

	it('keeps headerless or malformed patches as a plain preformatted fallback', () => {
		const patch = '@@ -1 +1 @@\n-old\n+new';
		const { container } = renderDiff(patch);

		expect(container.querySelector('diffs-container')).toBeNull();
		const fallback = container.querySelector('pre');
		expect(fallback?.textContent).toBe(patch);
		expect(fallback?.className).toContain('max-h-80');
	});
});
