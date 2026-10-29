import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadRow } from '@/lib/joined';
import { ChatNavigation, chatTurns } from '@/components/chat-navigation';

const row = (id: string, role: 'user' | 'assistant', text: string) => ({ message: { id, role, parts: [{ type: 'text', text }] } }) as ThreadRow;

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
		fireEvent.focus(first);
		expect(screen.getByRole('tooltip').textContent).toBe(turns[0].input);
		expect(screen.getByRole('tooltip').firstElementChild?.className).toContain('line-clamp-2');
		fireEvent.mouseEnter(second);
		expect(screen.getByRole('tooltip').textContent).toBe('Next');
		fireEvent.click(second);
		expect(navigate).toHaveBeenCalledWith('u2');
		expect(screen.queryByRole('tooltip')).toBeNull();
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
		expect(trigger.className).not.toContain('[@media(hover:hover)]:opacity-0');
		expect(trigger.className).not.toContain('[@media(hover:hover)]:pointer-events-none');
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
