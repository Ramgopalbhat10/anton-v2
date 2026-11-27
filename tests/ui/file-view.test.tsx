import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FileView } from '@/components/content/file-view';
import { renderWithQueries, shadowCodeText } from './render';

function source(text: string | Uint8Array, props: { path?: string; line?: number } = {}) {
	const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
	return renderWithQueries(<FileView path={props.path ?? 'src/app.ts'} queryKey={['fixture', props.path ?? 'src/app.ts']} read={async () => bytes} line={props.line} />);
}

describe('FileView source rendering', () => {
	it('renders source through the worker-backed shadow viewer', async () => {
		const { container } = source('const one = 1;\nconst two = 2;\n');
		expect(await shadowCodeText()).toContain('const one = 1;');
		const host = container.querySelector('diffs-container');
		expect(host?.shadowRoot?.querySelector('[data-line="2"]')?.textContent).toContain('const two = 2;');
	});

	it('paints the deep-linked line as the selected line', async () => {
		const { container } = source('first\nsecond\nthird\nfourth\n', { line: 3 });
		await shadowCodeText();
		await waitFor(() => {
			const selected = container.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-selected-line][data-line]');
			expect(selected?.getAttribute('data-line')).toBe('3');
		});
	});

	it('says so for binary files instead of rendering source', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]);
		renderWithQueries(<FileView path="data.bin" queryKey={['fixture', 'data.bin']} read={async () => bytes} />);
		expect(await screen.findByText(/Binary file/)).toBeTruthy();
		expect(document.querySelector('diffs-container')).toBeNull();
	});
});
