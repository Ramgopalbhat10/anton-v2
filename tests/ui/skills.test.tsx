import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogItem, Plugin, PluginPreview } from '@/lib/api';

const installed: Plugin = {
	id: 'plugin_1',
	name: 'document-skills',
	description: 'Excel, Word, PowerPoint and PDF',
	source: { repo: 'anthropics/skills', path: '', ref: null },
	sha: '8a1541c4aaaaaaaa',
	marketplace: 'anthropics/skills',
	skills: [
		{ name: 'pdf', description: 'Work with PDFs', active: true },
		{ name: 'xlsx', description: 'Work with spreadsheets', active: false },
	],
	mcpServers: [],
	skipped: [],
	enabled: true,
	installedAt: '2026-10-03T00:00:00Z',
	pick: { marketplace: 'anthropics/skills', name: 'document-skills' },
};

const entry = (name: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({
	id: name,
	name,
	description: `About ${name}`,
	source: { repo: 'anthropics/skills', path: '', ref: 'abc' },
	skills: null,
	installed: false,
	...extra,
});

const preview: PluginPreview = {
	id: 'plugin_9',
	name: 'brand-kit',
	description: 'Keeps documents on brand',
	source: { repo: 'acme/kit', path: 'plugins/brand', ref: 'f'.repeat(40) },
	sha: 'f'.repeat(40),
	marketplace: 'anthropics/skills',
	pick: { marketplace: 'anthropics/skills', name: 'brand-kit' },
	skills: [
		{ name: 'colors', description: 'Picks brand colors', folder: 'plugins/brand/skills/colors', license: 'MIT' },
		{ name: 'fonts', description: 'Picks brand fonts', folder: 'plugins/brand/skills/fonts', license: null },
	],
	mcpServers: ['figma'],
	skipped: [],
	files: ['plugins/brand/README.md', 'plugins/brand/skills/colors/SKILL.md', 'plugins/brand/skills/fonts/SKILL.md'],
	truncated: false,
	readme: 'plugins/brand/README.md',
	installed: null,
	update: null,
};

const text = (value: string) => new TextEncoder().encode(value);

const api = vi.hoisted(() => ({
	plugins: vi.fn(),
	catalog: vi.fn(async (repo: string) => ({
		entries: repo === 'anthropics/skills' ? [entry('document-skills'), entry('brand-kit'), entry('document-skills/pdf', { bundle: 'document-skills' })] : [entry('devin-tools')],
	})),
	installPlugin: vi.fn(async () => ({ plugins: [] as Plugin[] })),
	setPluginEnabled: vi.fn(async () => ({ plugins: [] as Plugin[] })),
	removePlugin: vi.fn(async () => ({ plugins: [] as Plugin[] })),
	saveMarketplaces: vi.fn(async (marketplaces: string[]) => ({ marketplaces })),
	searchGitHub: vi.fn(async () => ({
		skills: [{ address: 'someone/agents/skills/lint', repo: 'someone/agents', name: 'lint', description: 'Lints before commits' }],
		repos: [{ address: 'someone/agents', description: 'Agent skills', stars: 1200 }],
		problems: ['GitHub’s code search limit is reached; it frees up within a minute.'],
	})),
	previewPlugin: vi.fn(async () => preview),
	pluginFile: vi.fn(async (_repo: string, _sha: string, path: string) => text(path.endsWith('README.md') ? '# Brand kit\n\nEverything on brand.' : '---\nname: colors\n---\nUse the palette.')),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { SkillsPage } = await import('@/components/settings/skills');
const { SkillDetailPage } = await import('@/components/settings/skill-detail');

function open(at = '/settings/skills') {
	const root = createRootRoute({ component: Outlet });
	const tree = root.addChildren([
		createRoute({
			getParentRoute: () => root,
			path: '/settings/$section',
			validateSearch: (search: Record<string, unknown>) => search as { tab?: 'installed' | 'discover'; q?: string },
			component: SkillsPage,
		}),
		createRoute({
			getParentRoute: () => root,
			path: '/settings/skills/view',
			validateSearch: (search: Record<string, unknown>) => search as Record<string, string>,
			component: SkillDetailPage,
		}),
	]);
	const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [at] }) });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
}

describe('Skills settings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.plugins.mockResolvedValue({ plugins: [installed], marketplaces: ['anthropics/skills', 'CognitionAI/devin-marketplace'] });
	});

	it('shows installed plugins as cards with their skills, and turns one off', async () => {
		open();
		const skills = await screen.findByLabelText('Skills in document-skills');
		expect(within(skills).getByText('/pdf')).toBeTruthy();
		expect(within(skills).getByText('/xlsx').getAttribute('title')).toMatch(/earlier plugin/);
		await userEvent.click(screen.getByRole('switch', { name: 'Use document-skills' }));
		expect(api.setPluginEnabled).toHaveBeenCalledWith('plugin_1', false);
	});

	it('opens on Discover when nothing is installed, and lists every marketplace', async () => {
		api.plugins.mockResolvedValue({ plugins: [], marketplaces: ['anthropics/skills', 'CognitionAI/devin-marketplace'] });
		open();
		expect(await screen.findByRole('link', { name: 'devin-tools' })).toBeTruthy();
		expect(screen.getByRole('tab', { name: 'Discover' }).getAttribute('aria-selected')).toBe('true');
		// A bundle's own skills wait for its page, or a search.
		expect(screen.queryByRole('link', { name: 'pdf' })).toBeNull();
		await userEvent.click(screen.getByRole('button', { name: 'Install brand-kit' }));
		expect(api.installPlugin).toHaveBeenCalledWith({ marketplace: 'anthropics/skills', name: 'brand-kit' });
	});

	it('searches the marketplaces at once and GitHub when typing pauses', async () => {
		const router = open('/settings/skills?tab=discover');
		await screen.findByRole('link', { name: 'brand-kit' });
		await userEvent.type(screen.getByRole('searchbox', { name: 'Search skills' }), 'pdf');
		expect(screen.getByRole('link', { name: 'pdf' })).toBeTruthy();
		expect(screen.queryByRole('link', { name: 'brand-kit' })).toBeNull();
		expect(router.state.location.search).toMatchObject({ tab: 'discover', q: 'pdf' });

		const github = await screen.findByRole('region', { name: 'On GitHub' });
		await within(github).findByRole('link', { name: 'lint' });
		expect(api.searchGitHub).toHaveBeenCalledTimes(1);
		expect(api.searchGitHub).toHaveBeenCalledWith('pdf', expect.anything());
		expect(within(github).getByText(/code search limit/)).toBeTruthy();
		expect(within(github).getByRole('link', { name: /someone\/agents.*1,200/ })).toBeTruthy();
	});

	it('offers to open a pasted GitHub address', async () => {
		const router = open('/settings/skills?tab=discover&q=acme/kit');
		await userEvent.click(await screen.findByRole('link', { name: /Open acme\/kit/ }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/settings/skills/view'));
		expect(api.previewPlugin).toHaveBeenCalledWith({ address: 'acme/kit' });
		expect(api.searchGitHub).not.toHaveBeenCalled();
	});
});

describe('A plugin page', () => {
	beforeEach(() => vi.clearAllMocks());

	it('shows the README, the skills and every file before installing, then installs', async () => {
		open('/settings/skills/view?marketplace=anthropics%2Fskills&name=brand-kit');
		expect(await screen.findByRole('heading', { name: 'brand-kit' })).toBeTruthy();
		expect(api.previewPlugin).toHaveBeenCalledWith({ marketplace: 'anthropics/skills', name: 'brand-kit' });
		expect(await screen.findByText('Everything on brand.')).toBeTruthy();
		expect(screen.getByText(/Also declares MCP servers \(figma\)/)).toBeTruthy();

		// The Files tab opens the README the Overview already read.
		await userEvent.click(screen.getByRole('tab', { name: /Files/ }));
		expect(await screen.findByText('Everything on brand.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'README.md' }).getAttribute('aria-current')).toBe('true');

		await userEvent.click(screen.getByRole('tab', { name: /Skills/ }));
		expect(screen.getByText('/fonts')).toBeTruthy();
		await userEvent.click(screen.getAllByRole('button', { name: 'View SKILL.md' })[0] as HTMLElement);
		expect(await screen.findByText('Use the palette.')).toBeTruthy();
		expect(api.pluginFile).toHaveBeenCalledWith('acme/kit', 'f'.repeat(40), 'plugins/brand/skills/colors/SKILL.md');
		expect(screen.getByRole('button', { name: 'SKILL.md' }).getAttribute('aria-current')).toBe('true');

		await userEvent.click(screen.getByRole('button', { name: 'Install 2 skills' }));
		expect(api.installPlugin).toHaveBeenCalledWith({ marketplace: 'anthropics/skills', name: 'brand-kit' });
	});

	it('updates an installed plugin to its newer commit', async () => {
		api.previewPlugin.mockResolvedValueOnce({ ...preview, installed: { sha: preview.sha, enabled: true }, update: 'e'.repeat(40) });
		open('/settings/skills/view?plugin=plugin_9');
		await userEvent.click(await screen.findByRole('button', { name: 'Update' }));
		expect(api.installPlugin).toHaveBeenCalledWith({ plugin: 'plugin_9' });
	});
});
