import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Session } from '@/lib/api/sessions';
import { deleteInBackground, withoutDeleting } from '@/lib/deleting';
import { DeletionNotices } from '@/components/shell/deletion-notices';
import { renderWithQueries, session } from './render';

type List = { sessions: Session[] };

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const listed = (client: { getQueryData: (key: unknown[]) => unknown }) => (client.getQueryData(['sessions']) as List).sessions.map((item) => item.id);

describe('deleting a thread', () => {
	it('leaves the lists at once, stays out of a refetch while the server works, and says when it is done', async () => {
		const threads = [session({ id: 'a', title: 'First', spaceId: 'sp' }), session({ id: 'b', title: 'Second', spaceId: 'sp' })];
		const { client } = renderWithQueries(<DeletionNotices />, [[['sessions'], { sessions: threads }]]);
		const server = deferred();
		act(() => deleteInBackground(client, threads[0], () => server.promise));
		expect(listed(client)).toEqual(['b']);
		expect(screen.getByRole('status').textContent).toContain('Deleting “First”');
		// The server lists it until its delete is done; a refetch meanwhile keeps it out.
		expect(withoutDeleting(threads).map((item) => item.id)).toEqual(['b']);
		await act(async () => server.resolve());
		expect(await screen.findByText(/Deleted “First”/)).toBeTruthy();
		expect(screen.getByText(/Its files are in the project Library/)).toBeTruthy();
		// Once the server stops listing it, the page lets the id go.
		withoutDeleting([threads[1]]);
		expect(withoutDeleting(threads).map((item) => item.id)).toEqual(['a', 'b']);
	});

	it('puts a thread back where it was when the delete fails, and says why until dismissed', async () => {
		const threads = [session({ id: 'x', title: 'One', spaceId: 'sp' }), session({ id: 'y', title: 'Two', spaceId: 'sp' }), session({ id: 'z', title: 'Three', spaceId: 'sp' })];
		const { client } = renderWithQueries(<DeletionNotices />, [[['sessions'], { sessions: threads }]]);
		const server = deferred();
		act(() => deleteInBackground(client, threads[1], () => server.promise));
		expect(listed(client)).toEqual(['x', 'z']);
		await act(async () => server.reject(new Error('This thread is resolved. Reopen it to delete it.')));
		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('Could not delete “Two”');
		expect(alert.textContent).toContain('Reopen it to delete it');
		expect(listed(client)).toEqual(['x', 'y', 'z']);
		expect(withoutDeleting(threads)).toHaveLength(3);
		await userEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
		expect(screen.queryByRole('alert')).toBeNull();
	});
});
