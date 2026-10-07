import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DraftInput } from '@/components/draft-input';

const tokens = [{ value: '@src/server.ts', label: '@server.ts', title: 'src/server.ts', kind: 'file' as const }];
function Editor({ initial = '' }: { initial?: string }) {
	const [value, setValue] = useState(initial);
	return (
		<>
			<DraftInput value={value} tokens={tokens} placeholder="Draft" onChange={setValue} onSelect={() => undefined} onKeyDown={() => undefined} />
			<output>{value}</output>
		</>
	);
}
function selectAll(box: HTMLElement) {
	box.focus();
	const range = document.createRange();
	range.selectNodeContents(box);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
}
describe('draft editing', () => {
	it('cuts and pastes a chip without losing its full path', () => {
		render(<Editor initial="Check @src/server.ts" />);
		const box = screen.getByRole('textbox');
		selectAll(box);
		const setData = vi.fn();
		fireEvent.cut(box, { clipboardData: { setData } });
		expect(setData).toHaveBeenCalledWith('text/plain', 'Check @src/server.ts');
		expect(screen.getByRole('status').textContent).toBe('');
		fireEvent.paste(box, { clipboardData: { getData: () => 'Check @src/server.ts' } });
		expect(screen.getByLabelText('File src/server.ts')).toBeTruthy();
		expect(screen.getByRole('status').textContent).toBe('Check @src/server.ts');
	});
	it('undoes and redoes text editing across chip boundaries', async () => {
		render(<Editor initial="@src/server.ts " />);
		const box = screen.getByRole('textbox');
		await userEvent.click(box);
		const range = document.createRange();
		range.selectNodeContents(box);
		range.collapse(false);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
		await userEvent.keyboard('x');
		expect(screen.getByRole('status').textContent).toBe('@src/server.ts x');
		await userEvent.keyboard('{Control>}z{/Control}');
		expect(screen.getByRole('status').textContent).toBe('@src/server.ts ');
		await userEvent.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
		expect(screen.getByRole('status').textContent).toBe('@src/server.ts x');
	});
	it('pastes multiline plain text without interpreting HTML', () => {
		render(<Editor />);
		const box = screen.getByRole('textbox');
		box.focus();
		fireEvent.paste(box, { clipboardData: { getData: () => '<b>hello</b>\nsecond line' } });
		expect(box.textContent).toBe('<b>hello</b>\nsecond line');
		expect(box.querySelector('b')).toBeNull();
	});
});
