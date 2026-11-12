import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const project = {
	id: 'p1',
	repoFullName: 'acme/web',
	defaultBranch: 'main',
	memory: '',
	warmedAt: null,
	envKeys: [],
	setupScript: 'npm ci',
	checkCommand: '',
	previewPorts: [3000],
	baseImage: null,
	fullVm: false,
	followUps: true,
	reviewOthers: false,
};

const api = vi.hoisted(() => ({
	projects: vi.fn(),
	automations: vi.fn(async () => ({ automations: [] })),
	updateProjectSettings: vi.fn(async (_id: string, change: object) => ({ ...change, envKeys: [] })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { RepoSettingsPage } = await import('@/components/repo-settings');

function open(path: string) {
	const root = createRootRoute({ component: Outlet });
	const page = createRoute({ getParentRoute: () => root, path: '/settings/repos/$projectId', component: RepoSettingsPage });
	const router = createRouter({ routeTree: root.addChildren([page]), history: createMemoryHistory({ initialEntries: [path] }) });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe('Repository settings', () => {
	it('shows the check command under the setup script and saves it trimmed', async () => {
		api.projects.mockResolvedValue({ projects: [project] });
		open('/settings/repos/p1');
		const field = (await screen.findByLabelText('Check command')) as HTMLInputElement;
		expect(field.value).toBe('');
		expect(field.getAttribute('placeholder')).toBe('npm run check:types');
		expect(screen.getByText(/Runs after the agent changes files and tells it only of failures/)).toBeTruthy();
		// It sits after the setup script, before the preview ports.
		const setup = screen.getByText('Setup script');
		const check = screen.getByText('Check command', { selector: 'div, span, p, h3, h4, label' });
		expect(setup.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		fireEvent.change(field, { target: { value: '  npm run check:types  ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
		await waitFor(() => expect(api.updateProjectSettings).toHaveBeenCalled());
		const [id, change] = api.updateProjectSettings.mock.calls[0] as unknown as [string, { checkCommand: string; setupScript: string }];
		expect(id).toBe('p1');
		expect(change.checkCommand).toBe('npm run check:types');
		expect(change.setupScript).toBe('npm ci');
	});

	it('shows a saved check command', async () => {
		api.projects.mockResolvedValue({ projects: [{ ...project, checkCommand: 'npx tsc --noEmit' }] });
		open('/settings/repos/p1');
		expect(((await screen.findByLabelText('Check command')) as HTMLInputElement).value).toBe('npx tsc --noEmit');
	});
});
