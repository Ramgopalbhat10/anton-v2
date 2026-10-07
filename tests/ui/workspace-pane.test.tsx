import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePane } from '@/components/workspace-pane';

let available = 1200;
let resize: (() => void) | undefined;
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	available = 1200;
});
function mount(expanded = false) {
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: available, left: 0, right: available }) as DOMRect);
	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	return render(
		<div>
			<WorkspacePane expanded={expanded}>
				<div>Files</div>
			</WorkspacePane>
		</div>,
	);
}

describe('workspace resizing', () => {
	it('allows keyboard resizing, clamps both ends, and restores the chosen width', () => {
		const view = mount();
		const handle = screen.getByRole('separator', { name: 'Resize workspace' });
		expect(handle.getAttribute('aria-valuenow')).toBe('552');
		fireEvent.keyDown(handle, { key: 'ArrowLeft' });
		expect(handle.getAttribute('aria-valuenow')).toBe('576');
		fireEvent.keyDown(handle, { key: 'End' });
		expect(handle.getAttribute('aria-valuenow')).toBe('860');
		fireEvent.keyDown(handle, { key: 'ArrowLeft' });
		expect(handle.getAttribute('aria-valuenow')).toBe('860');
		fireEvent.keyDown(handle, { key: 'Home' });
		expect(handle.getAttribute('aria-valuenow')).toBe('360');
		fireEvent.keyDown(handle, { key: 'ArrowRight' });
		expect(handle.getAttribute('aria-valuenow')).toBe('360');
		fireEvent.keyDown(handle, { key: 'ArrowLeft' });
		view.unmount();
		mount();
		expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('384');
	});
	it('reclamps when the available space shrinks and keeps full expansion separate', () => {
		const view = mount();
		fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' });
		available = 900;
		act(() => resize?.());
		const handle = screen.getByRole('separator');
		expect(handle.getAttribute('aria-valuenow')).toBe('560');
		view.rerender(
			<div>
				<WorkspacePane expanded>
					<div>Files</div>
				</WorkspacePane>
			</div>,
		);
		expect(screen.queryByRole('separator')).toBeNull();
		view.rerender(
			<div>
				<WorkspacePane expanded={false}>
					<div>Files</div>
				</WorkspacePane>
			</div>,
		);
		expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('560');
		available = 560;
		act(() => resize?.());
		expect(screen.queryByRole('separator')).toBeNull();
		available = 1200;
		act(() => resize?.());
		expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('860');
	});
});
