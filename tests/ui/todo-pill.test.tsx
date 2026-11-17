import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { TodoList } from '@/lib/api/sessions';
import { renderWithQueries } from './render';

const { TodoPill } = await import('@/components/composer/todo-pill');

const list: TodoList = {
	updatedAt: '2026-10-13T00:00:00Z',
	todos: [
		{ content: 'Read the UI code', status: 'completed' },
		{ content: 'Reproduce the slow render', status: 'completed' },
		{ content: 'Measure renders', status: 'in_progress' },
		{ content: 'Fix the hotspots', status: 'pending' },
		{ content: 'Measure again', status: 'pending' },
		{ content: 'Open a draft PR', status: 'pending' },
	],
};

const setup = (seed: TodoList | null, busy = true) => renderWithQueries(<TodoPill sessionId="s1" busy={busy} />, [[['todos', 's1'], { list: seed }]]);

describe('TodoPill', () => {
	it('shows nothing while the task has no todo list', () => {
		const { container } = setup(null);
		expect(container.innerHTML).toBe('');
	});

	it('counts what is done, and lists every item on hover', async () => {
		setup(list);
		const pill = screen.getByRole('button', { name: /Todos: 2 of 6 done\. Now: Measure renders/ });
		expect(pill.textContent).toBe('2/6Done');
		fireEvent.pointerEnter(pill, { pointerType: 'mouse' });
		const popover = await screen.findByRole('dialog');
		expect(within(popover).getAllByRole('listitem').map((item) => item.textContent)).toEqual(list.todos.map((todo) => todo.content));
		expect(within(popover).getByText('Measure renders').closest('li')?.getAttribute('aria-current')).toBe('step');
	});

	it('a click keeps the list open, and a second click closes it', async () => {
		setup(list);
		const pill = screen.getByRole('button', { name: /Todos/ });
		await userEvent.click(pill);
		await screen.findByRole('dialog');
		fireEvent.pointerLeave(pill, { pointerType: 'mouse' });
		await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
		expect(screen.queryByRole('dialog')).not.toBeNull();
		await userEvent.click(pill);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('shows details under each item, clamped with a toggle only when they run long', async () => {
		const long = 'Typecheck and new UI tests pass; Playwright measured 44px headers with aligned bottom borders and verified long-name truncation.';
		const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
		Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
			configurable: true,
			get(this: HTMLElement) {
				return this.textContent === long && this.classList.contains('line-clamp-2') ? 80 : 0;
			},
		});
		try {
			setup({
				...list,
				todos: [
					{ content: 'Read the UI code', status: 'completed', evidence: 'Read todo-pill.tsx' },
					{ content: 'Match header heights', status: 'completed', evidence: long },
					{ content: 'Open a draft PR', status: 'in_progress' },
				],
			});
			await userEvent.click(screen.getByRole('button', { name: /Todos/ }));
			const popover = await screen.findByRole('dialog');
			expect(within(popover).getByText('Read todo-pill.tsx').tagName).toBe('P');
			const toggles = within(popover).getAllByRole('button', { name: 'Show details' });
			expect(toggles).toHaveLength(1);
			expect(toggles[0].closest('li')?.textContent).toContain('Match header heights');
			const details = within(popover).getByText(long);
			expect(details.classList.contains('line-clamp-2')).toBe(true);
			await userEvent.click(toggles[0]);
			expect(toggles[0].getAttribute('aria-expanded')).toBe('true');
			expect(toggles[0].getAttribute('aria-label')).toBe('Hide details');
			expect(details.classList.contains('line-clamp-2')).toBe(false);
			await userEvent.click(details);
			expect(details.classList.contains('line-clamp-2')).toBe(true);
			expect(screen.queryByRole('dialog')).not.toBeNull();
		} finally {
			if (height) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height);
		}
	});

	it('follows a new list as the agent writes it', async () => {
		const { client } = setup(list);
		await act(async () => client.setQueryData(['todos', 's1'], { list: { ...list, todos: [{ content: 'Answer the question', status: 'completed' }] } }));
		expect((await screen.findByRole('button', { name: /Todos: 1 of 1 done/ })).textContent).toBe('1/1Done');
	});
});
