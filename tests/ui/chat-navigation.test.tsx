import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadRow } from '@/lib/joined';
import { ChatNavigation, chatTurns } from '@/components/thread/chat-navigation';

const row = (id: string, role: 'user' | 'assistant', text: string) => ({ message: { id, role, parts: [{ type: 'text', text }] } }) as ThreadRow;

function mockRailBounds(buttons: HTMLElement[], height: number) {
	const list = buttons[0].parentElement!;
	list.parentElement!.getBoundingClientRect = list.getBoundingClientRect = () => new DOMRect(0, 100, 40, height);
	buttons.forEach((button, index) => {
		button.getBoundingClientRect = () => new DOMRect(0, 104 + index * 12 - list.scrollTop, 40, 12);
	});
	return (top: number) => {
		list.scrollTop = top;
		fireEvent.scroll(list);
	};
}

describe('chat navigation', () => {
	it('previews only the bounded input in two lines and navigates', () => {
		const rows = [row('u1', 'user', 'Question ' + 'x'.repeat(220)), row('a1', 'assistant', 'A private response'), row('u2', 'user', 'Next')];
		const turns = chatTurns(rows);
		expect(turns.map((turn) => turn.id)).toEqual(['u1', 'u2']);
		expect(turns[0].input).toHaveLength(180);
		const navigate = vi.fn();
		render(<ChatNavigation rows={rows} onNavigate={navigate} />);
		const first = screen.getByRole('button', { name: /Go to input 1/ });
		const second = screen.getByRole('button', { name: /Go to input 2/ });
		mockRailBounds([first, second], 32);
		fireEvent.focus(first);
		expect(screen.getByRole('tooltip').textContent).toBe(turns[0].input);
		expect(screen.getByRole('tooltip').firstElementChild?.className).toContain('line-clamp-2');
		fireEvent.mouseEnter(second);
		expect(screen.getByRole('tooltip').textContent).toBe('Next');
		fireEvent.click(second);
		expect(navigate).toHaveBeenCalledWith('u2');
		expect(screen.queryByRole('tooltip')).toBeNull();
	});

	it('keeps the preview beside its item when the rail scrolls', () => {
		const rows = Array.from({ length: 6 }, (_, index) => row(`u${index}`, 'user', `Message ${index}`));
		render(<ChatNavigation rows={rows} onNavigate={vi.fn()} />);
		const buttons = screen.getAllByRole('button', { name: /Go to input/ });
		const [first, second, , fourth] = buttons;
		const scroll = mockRailBounds(buttons, 40);

		fireEvent.mouseEnter(first);
		const tooltip = screen.getByRole('tooltip');
		expect(tooltip.style.top).toBe('10px');
		fireEvent.mouseEnter(second);
		expect(tooltip.style.top).toBe('22px');
		expect(second.getAttribute('aria-describedby')).toBe(tooltip.id);

		scroll(12);
		expect(tooltip.style.top).toBe('10px');
		scroll(27);
		expect(tooltip.style.visibility).toBe('');
		scroll(28);
		expect(tooltip.style.visibility).toBe('hidden');

		fireEvent.focus(fourth);
		scroll(1);
		expect(tooltip.style.visibility).toBe('');
		scroll(0);
		expect(tooltip.style.visibility).toBe('hidden');
	});

	it('lets touch users reveal and dismiss the overlay', () => {
		render(<ChatNavigation rows={[row('u1', 'user', 'First')]} onNavigate={vi.fn()} />);
		fireEvent.click(screen.getByRole('button', { name: 'Show chat navigation' }));
		expect(screen.getByRole('button', { name: 'Hide chat navigation' }).getAttribute('aria-expanded')).toBe('true');
		fireEvent.keyDown(screen.getByRole('navigation'), { key: 'Escape' });
		expect(screen.getByRole('button', { name: 'Show chat navigation' }).getAttribute('aria-expanded')).toBe('false');
	});
	it('has one collapsed tab stop and opens the turns only on activation', async () => {
		const user = userEvent.setup();
		const navigate = vi.fn();
		const rows = Array.from({ length: 40 }, (_, index) => row(`u${index}`, 'user', `Message ${index}`));
		render(<><button>Before</button><ChatNavigation rows={rows} onNavigate={navigate} /><button>After</button></>);
		const trigger = screen.getByRole('button', { name: 'Show chat navigation' });
		expect(trigger.className).toContain('[@media(hover:hover)]:group-hover/nav:opacity-0');
		expect(trigger.className).toContain('[@media(hover:hover)]:group-hover/nav:pointer-events-none');
		expect(trigger.className).toContain('[@media(hover:hover)]:focus-visible:opacity-100');
		const turns = screen.getAllByRole('button', { name: /Go to input/ });
		expect(turns.every((turn) => turn.tabIndex === -1)).toBe(true);
		await user.tab();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }));
		await user.tab();
		expect(document.activeElement).toBe(trigger);
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		await user.tab();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }));
		await user.tab({ shift: true });
		await user.keyboard('{Enter}');
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		await user.tab();
		expect(document.activeElement).toBe(turns[0]);
		await user.keyboard('{Escape}');
		expect(document.activeElement).toBe(trigger);
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(turns.every((turn) => turn.tabIndex === -1)).toBe(true);
		await user.keyboard('{Enter}');
		await user.tab();
		await user.keyboard('{Enter}');
		expect(navigate).toHaveBeenCalledWith('u0');
		expect(document.activeElement).toBe(trigger);
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
	});

});
