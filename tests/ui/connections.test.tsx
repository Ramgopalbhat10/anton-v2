import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SetupField, SetupSlot } from '@/lib/api/settings';

const field = (env: string, label: string, extra: Partial<SetupField> = {}): SetupField => ({ env, label, secret: false, optional: false, fallback: null, source: null, value: null, hint: null, ...extra });
const slot = (id: string, name: string, required: boolean, provider: string | null, options: SetupSlot['options'], extra: Partial<SetupSlot> = {}): SetupSlot => ({
	id,
	name,
	required,
	live: true,
	provider,
	restart: false,
	saved: false,
	options,
	...extra,
});

/** A new server: no model key, no GitHub token, this server's sandbox and disk by default. */
function freshSlots(): SetupSlot[] {
	return [
		slot('models', 'Models', true, null, [{ id: 'openrouter', label: 'OpenRouter', fields: [field('OPENROUTER_API_KEY', 'API key', { secret: true })] }]),
		slot('git', 'Code host', true, 'github', [{ id: 'github', label: 'GitHub', fields: [field('ANTON_GITHUB_TOKEN', 'Personal access token', { secret: true })] }]),
		slot('sandbox', 'Sandboxes', true, 'local', [{ id: 'local', label: 'This server', fields: [] }, { id: 'docker', label: 'Docker', fields: [] }], { live: false }),
		slot('store', 'Object storage', true, 'disk', [{ id: 'disk', label: 'This server', fields: [] }], { live: false }),
		slot('web', 'Web search', false, 'parallel', [{ id: 'parallel', label: 'Parallel', fields: [] }]),
	];
}

const { api } = vi.hoisted(() => ({
	api: {
		setup: vi.fn(),
		connections: vi.fn(),
		testSetup: vi.fn(async () => ({ detail: 'OpenRouter accepted the key.' })),
		saveSetup: vi.fn(async () => ({ detail: 'OpenRouter accepted the key.', restart: false })),
		clearSetup: vi.fn(async () => ({ ok: true })),
	},
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { ConnectionsPage } = await import('@/components/settings/connections');

function open() {
	const root = createRootRoute({ component: Outlet });
	const tree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: '/settings/connections', component: ConnectionsPage }),
		createRoute({ getParentRoute: () => root, path: '/settings/$section', component: () => null }),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/settings/connections'] }) });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe('Connections as the setup', () => {
	it('opens on the first needed slot, and saves a key only after it passes its test', async () => {
		api.setup.mockResolvedValue({ slots: freshSlots(), plans: [], canRunTasks: false });
		api.connections.mockResolvedValue({
			connections: [
				{ id: 'sandbox', name: 'Sandboxes', provider: 'local', detail: 'Tasks run in folders under the data directory.', state: 'ok' },
				{ id: 'store', name: 'Object storage', provider: 'disk', detail: 'Files under the data directory on this server.', state: 'ok' },
			],
		});
		open();
		const health = await screen.findByRole('region', { name: 'Health' });
		await waitFor(() => expect(within(health).getByText('2 to set up')).toBeTruthy());
		const models = screen.getByRole('region', { name: 'Models' });
		expect(within(models).getByRole('button', { name: /Models/ }).getAttribute('aria-expanded')).toBe('true');

		const save = within(models).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		fireEvent.change(within(models).getByLabelText('API key'), { target: { value: 'sk-or-v1-abcd1234' } });
		fireEvent.click(within(models).getByRole('button', { name: 'Test' }));
		await waitFor(() => expect(within(models).getByText(/Test passed\. OpenRouter accepted the key\./)).toBeTruthy());
		expect(api.testSetup).toHaveBeenCalledWith('models', { provider: 'openrouter', values: { OPENROUTER_API_KEY: 'sk-or-v1-abcd1234' } });

		// Changing the key again asks for another test before it can be saved.
		fireEvent.change(within(models).getByLabelText('API key'), { target: { value: 'sk-or-v1-abcd12345' } });
		expect((within(models).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(within(models).getByRole('button', { name: 'Test' }));
		await waitFor(() => expect((within(models).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(within(models).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(api.saveSetup).toHaveBeenCalledWith('models', { provider: 'openrouter', values: { OPENROUTER_API_KEY: 'sk-or-v1-abcd12345' } }));
	});

	it('shows a value from the environment locked with its variable, and a failing check with why', async () => {
		const slots = freshSlots();
		slots[1].options[0].fields[0] = field('ANTON_GITHUB_TOKEN', 'Personal access token', { secret: true, source: 'environment', hint: 'a4f2' });
		slots[0].provider = 'openrouter';
		api.setup.mockResolvedValue({ slots, plans: ['ChatGPT plan'], canRunTasks: true });
		api.connections.mockResolvedValue({
			connections: [
				{ id: 'models', name: 'Models', provider: 'openrouter', detail: '316 models that can call tools.', state: 'ok' },
				{ id: 'git', name: 'Code host', provider: 'github', detail: 'api.github.com did not answer within 10.0s. The address lookup took 9.8s, so this server is slow to resolve names; check its DNS.', state: 'failing' },
				{ id: 'sandbox', name: 'Sandboxes', provider: 'local', detail: 'Tasks run in folders.', state: 'ok' },
				{ id: 'store', name: 'Object storage', provider: 'disk', detail: 'Files on disk.', state: 'ok' },
			],
		});
		open();
		const health = await screen.findByRole('region', { name: 'Health' });
		await waitFor(() => expect(within(health).getByText('1 failing')).toBeTruthy());
		expect(screen.getByText('316 models that can call tools. ChatGPT plan signed in.')).toBeTruthy();
		const git = screen.getByRole('region', { name: 'Code host' });
		expect(within(git).getByText(/The address lookup took 9\.8s/)).toBeTruthy();

		fireEvent.click(within(git).getByRole('button', { name: /Code host/ }));
		expect(within(git).getByText('ANTON_GITHUB_TOKEN')).toBeTruthy();
		expect(within(git).getByText('…a4f2')).toBeTruthy();
		expect(within(git).getByRole('alert').textContent).toMatch(/slow to resolve names/);
		fireEvent.click(within(git).getByRole('button', { name: 'Paste a key instead' }));
		expect((within(git).getByLabelText('Personal access token') as HTMLInputElement).type).toBe('password');
	});
});
