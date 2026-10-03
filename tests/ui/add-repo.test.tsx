import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
	addableRepos: vi.fn(async () => ({ repos: ['acme/web', 'acme/api', 'someone/notes'] })),
	addProject: vi.fn(async (repo: string) => ({ id: 'p9', repoFullName: repo })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { AddRepo } = await import('@/components/launcher');

function open(onAdded = vi.fn()) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<AddRepo onAdded={onAdded} onCancel={() => {}} />
		</QueryClientProvider>,
	);
	return onAdded;
}

describe('Adding a repository', () => {
	it('offers the repos the account can reach, narrowed by typing, and adds one on click', async () => {
		const onAdded = open();
		const list = await screen.findByRole('list', { name: 'Your repositories' });
		expect(within(list).getAllByRole('button')).toHaveLength(3);

		fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'ACME/' } });
		expect(within(list).getAllByRole('button').map((button) => button.textContent)).toEqual(['acme/web', 'acme/api']);

		fireEvent.click(within(list).getByText('acme/api'));
		await vi.waitFor(() => expect(onAdded).toHaveBeenCalled());
		expect(api.addProject).toHaveBeenCalledWith('acme/api');
	});

	it('still adds a repo typed by name when it is not in the list', async () => {
		const onAdded = open();
		await screen.findByRole('list', { name: 'Your repositories' });
		fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'elsewhere/tool' } });
		expect(screen.queryByRole('list', { name: 'Your repositories' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		await vi.waitFor(() => expect(onAdded).toHaveBeenCalled());
		expect(api.addProject).toHaveBeenLastCalledWith('elsewhere/tool');
	});
});
