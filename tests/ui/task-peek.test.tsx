import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithQueries, session } from './render';

const { TaskPeek } = await import('@/components/task-peek');

const peekOf = async (task: ReturnType<typeof session>) => {
	renderWithQueries(
		<TaskPeek session={task} disabled={false}>
			<a href="#task">{task.title}</a>
		</TaskPeek>,
	);
	fireEvent.pointerEnter(screen.getByRole('link', { name: task.title }), { pointerType: 'mouse' });
	return (await screen.findByLabelText('Numbers')).closest('.in-pop') as HTMLElement;
};

describe('Task peek', () => {
	it('leads with the task’s numbers, then lists where it lives, its pull request as a chip with a pip per check', async () => {
		const peek = await peekOf(
			session({
				title: 'Fix the checkout',
				workspace: true,
				usage: { inputTokens: 300_000, outputTokens: 20_000, cost: 0.4 },
				prUrl: 'https://github.com/acme/demo/pull/42',
				pullRequest: {
					state: 'open',
					checks: 'failed',
					runs: [
						{ name: 'types', status: 'passed', url: '' },
						{ name: 'ui', status: 'failed', url: '' },
					],
				},
			}),
		);
		const numbers = within(peek).getByLabelText('Numbers');
		expect([...numbers.querySelectorAll('dt')].map((term) => `${term.textContent} ${term.nextSibling?.textContent}`)).toEqual(['Spend $0.400', 'Tokens 320K', expect.stringMatching(/^Active \d+d ago$/)]);
		expect(within(peek).getByText('acme/demo')).toBeTruthy();
		expect(within(peek).getByText('anton/task-s1')).toBeTruthy();
		const pull = within(peek).getByRole('link', { name: /#42/ });
		expect(pull.getAttribute('href')).toBe('https://github.com/acme/demo/pull/42');
		expect(pull.getAttribute('title')).toBe('Open, checks failing');
		expect(within(pull).getByText('Open')).toBeTruthy();
		expect(within(pull).getByRole('img', { name: 'checks failing' }).children).toHaveLength(2);
	});

	it('shows a dash for numbers a task has not run up yet', async () => {
		const peek = await peekOf(session({ title: 'Fresh task' }));
		const values = [...within(peek).getByLabelText('Numbers').querySelectorAll('dd')].map((value) => value.textContent);
		expect(values.slice(0, 2)).toEqual(['—', '—']);
		expect(within(peek).queryByText('Pull request')).toBeNull();
	});
});
