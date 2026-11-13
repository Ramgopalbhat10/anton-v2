import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/error-boundary';

let fail = true;
function Flaky() {
	if (fail) throw new Error('boom');
	return <p>Drawn</p>;
}
function StaleChunk(): never {
	throw new TypeError('Failed to fetch dynamically imported module: /assets/terminal-tab-abc.js');
}

describe('ErrorBoundary', () => {
	afterEach(() => vi.restoreAllMocks());

	it('keeps a failure in its part of the page, and draws it again on Try again', () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		fail = true;
		render(
			<div>
				<p>Rest of the page</p>
				<ErrorBoundary label="This reply">
					<Flaky />
				</ErrorBoundary>
			</div>,
		);
		expect(screen.getByRole('alert').textContent).toContain('This reply could not be shown.');
		expect(screen.getByText('Rest of the page')).toBeTruthy();
		fail = false;
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(screen.getByText('Drawn')).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('asks for a reload when a part’s code is gone after a release', () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		render(
			<ErrorBoundary label="The Terminal panel">
				<StaleChunk />
			</ErrorBoundary>,
		);
		expect(screen.getByRole('alert').textContent).toContain('The Terminal panel needs the newest version of Anton.');
		expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
	});
});
