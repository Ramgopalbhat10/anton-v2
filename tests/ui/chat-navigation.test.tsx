import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadRow } from '@/lib/joined';
import { ChatNavigation, chatTurns } from '@/components/chat-navigation';

const row = (id: string, role: 'user' | 'assistant', text: string) => ({ message: { id, role, parts: [{ type: 'text', text }] } }) as ThreadRow;

describe('chat navigation', () => {
	it('uses displayed order, trims previews and handles missing output', () => {
		const rows = [row('u1', 'user', 'Question ' + 'x'.repeat(220)), row('a1', 'assistant', 'Answer ' + 'y'.repeat(220)), row('u2', 'user', 'Next')];
		const turns = chatTurns(rows);
		expect(turns.map((turn) => turn.id)).toEqual(['u1', 'u2']);
		expect(turns[0].input).toHaveLength(180);
		expect(turns[0].output).toHaveLength(180);
		const navigate = vi.fn();
		render(<ChatNavigation rows={rows} onNavigate={navigate} />);
		const buttons = screen.getAllByRole('button');
		fireEvent.focus(buttons[0]);
		expect(screen.getByRole('tooltip').textContent).toContain(turns[0].output);
		fireEvent.mouseEnter(buttons[1]);
		expect(screen.getByRole('tooltip').textContent).toContain('No response yet.');
		fireEvent.click(buttons[1]);
		expect(navigate).toHaveBeenCalledWith('u2');
		fireEvent.keyDown(buttons[1], { key: 'Escape' });
		expect(screen.queryByRole('tooltip')).toBeNull();
	});

	it('uses only the visible portion of split replies', () => {
		const reply = row('a', 'assistant', 'before and after');
		const rows = [row('u1', 'user', 'First'), { ...reply, segment: { key: 'a~0', parts: [{ type: 'text', text: 'before' }], first: true, last: false } }, row('u2', 'user', 'Joined'), { ...reply, segment: { key: 'a', parts: [{ type: 'text', text: 'after' }], first: false, last: true } }] as ThreadRow[];
		expect(chatTurns(rows).map((turn) => turn.output)).toEqual(['before', 'after']);
	});
});
