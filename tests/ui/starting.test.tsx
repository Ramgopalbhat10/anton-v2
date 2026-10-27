import { QueryClient } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/api';
import { StartingTask } from '@/components/starting-task';
import { draftSession, newTaskId, startInBackground, useStarting, withStarting } from '@/lib/starting';
import { session } from './render';

/** A task's page while it is made, as SessionPage draws it. */
function Page({ id, onDiscard = () => {} }: { id: string; onDiscard?: () => void }) {
	const starting = useStarting(id);
	return starting ? <StartingTask starting={starting} workspace={false} onDiscard={onDiscard} /> : <p>The task</p>;
}

/** A promise settled from the test, as the server answers when it is ready. */
function later<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe('starting a task', () => {
	it('lists it and opens it at once, as a skeleton, until the server has made it', async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['sessions'], { sessions: [session({ id: 'older', title: 'Older task' })] });
		const id = newTaskId();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const answer = later<Session>();
		const draft = draftSession({ id, title: 'Fix the upload retries', prompt: 'Fix the upload retries', projectId: 'p1', repo: 'acme/demo', model: 'openrouter/test/cheap' });
		startInBackground(queryClient, draft, 'Fix the upload retries', () => answer.promise);
		render(<Page id={id} />);

		expect(screen.getByText('Fix the upload retries', { selector: 'span' })).toBeTruthy();
		expect(screen.getByText('Starting the task')).toBeTruthy();
		const listed = queryClient.getQueryData<{ sessions: Session[] }>(['sessions'])!.sessions;
		expect(listed.map((item) => [item.id, item.threadState])).toEqual([
			[id, 'working'],
			['older', session({}).threadState],
		]);
		// A list read from the server before it is made still shows it.
		expect(withStarting([session({ id: 'older' })]).map((item) => item.id)).toEqual([id, 'older']);

		await act(async () => answer.resolve(session({ id, title: 'Fix the upload retries', working: false, threadState: 'idle' })));
		expect(await screen.findByText('The task')).toBeTruthy();
		expect(queryClient.getQueryData<Session>(['session', id])?.working).toBe(true);
		expect(withStarting([]).map((item) => item.id)).toEqual([]);
	});

	it('says why it could not start, and tries again or gives up', async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['sessions'], { sessions: [] });
		const id = newTaskId();
		const first = later<Session>();
		const second = later<Session>();
		const make = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const onDiscard = vi.fn();
		startInBackground(queryClient, draftSession({ id, title: 'Compare vendors', prompt: 'Compare vendors', model: 'm' }), 'Compare vendors', make);
		render(<Page id={id} onDiscard={onDiscard} />);
		expect(screen.getByText('Starting the chat')).toBeTruthy();

		await act(async () => first.reject(new Error('Unknown model: m')));
		expect(await screen.findByText('Could not start the chat: Unknown model: m')).toBeTruthy();
		expect(queryClient.getQueryData<{ sessions: Session[] }>(['sessions'])!.sessions).toEqual([]);

		await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(make).toHaveBeenCalledTimes(2);
		expect(screen.getByText('Starting the chat')).toBeTruthy();
		await act(async () => second.reject(new Error('Still no')));
		await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
		expect(onDiscard).toHaveBeenCalled();
		expect(screen.getByText('The task')).toBeTruthy();
	});
});
