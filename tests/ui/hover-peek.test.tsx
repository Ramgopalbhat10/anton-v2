import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HoverPeek } from '@/components/hover-peek';

const content = <><a href="https://github.com/acme/demo/pull/42">PR #42</a><span tabIndex={0}>Source branch</span><span tabIndex={0}>Target branch</span><button>Open thread</button></>;

describe('interactive hover peek', () => {
	it('enters on Arrow Down, keeps natural tab stops, and restores focus on Escape without activating the thread', async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		render(<HoverPeek interactive content={content}><button onClick={navigate}>Thread</button></HoverPeek>);
		await user.tab();
		await user.keyboard('{ArrowDown}');
		const dialog = await screen.findByRole('dialog', { name: 'Thread details' });
		expect(document.activeElement).toBe(screen.getByRole('link', { name: 'PR #42' }));
		await user.tab();
		expect(document.activeElement).toBe(screen.getByText('Source branch'));
		await user.tab();
		expect(document.activeElement).toBe(screen.getByText('Target branch'));
		expect(dialog.querySelector('[tabindex="0"]')).toBeTruthy();
		await user.keyboard('{Escape}');
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Thread' }));
		expect(navigate).not.toHaveBeenCalled();
	});

	it('opens on hover without stealing focus and preserves trigger click behavior', async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		render(<HoverPeek interactive content={content} openDelay={0}><button onClick={navigate}>Thread</button></HoverPeek>);
		const trigger = screen.getByRole('button', { name: 'Thread' });
		fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
		await screen.findByRole('dialog');
		expect(document.activeElement).not.toBe(screen.getByRole('link'));
		await user.click(trigger);
		expect(navigate).toHaveBeenCalledOnce();
	});

	it('does not open a quiet peek from the keyboard', async () => {
		const user = userEvent.setup();
		render(<HoverPeek interactive quiet content={content}><button>Thread</button></HoverPeek>);
		await user.tab();
		await user.keyboard('{ArrowDown}');
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});
