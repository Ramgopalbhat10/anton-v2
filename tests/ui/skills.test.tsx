import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogItem, Plugin } from '@/lib/api';

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
	mcpServers: ['docs'],
	skipped: [],
	enabled: true,
	installedAt: '2026-10-03T00:00:00Z',
};

const api = vi.hoisted(() => ({
	plugins: vi.fn(async () => ({ plugins: [] as Plugin[], marketplaces: ['anthropics/skills', 'CognitionAI/devin-marketplace'] })),
	catalog: vi.fn(async () => ({
		entries: [
			{
				id: 'plugin_1',
				name: 'document-skills',
				description: 'Documents',
				source: { repo: 'anthropics/skills', path: '', ref: 'abc' },
				skills: ['./skills/pdf'],
				installed: false,
			},
			{
				id: 'plugin_2',
				name: 'claude-api',
				description: 'The Claude API',
				source: { repo: 'anthropics/skills', path: '', ref: 'abc' },
				skills: null,
				installed: false,
			},
		] as CatalogItem[],
	})),
	installPlugin: vi.fn(async () => ({ plugins: [] as Plugin[] })),
	setPluginEnabled: vi.fn(async () => ({ plugins: [] as Plugin[] })),
	removePlugin: vi.fn(async () => ({ plugins: [] as Plugin[] })),
	saveMarketplaces: vi.fn(async (marketplaces: string[]) => ({ marketplaces })),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { SkillsPage } = await import('@/components/settings/skills');

function open() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<SkillsPage />
		</QueryClientProvider>,
	);
}

describe('Skills settings', () => {
	it('browses a marketplace and installs a plugin from it, then shows it with its skills', async () => {
		api.installPlugin.mockResolvedValueOnce({ plugins: [installed] });
		open();
		expect(await screen.findByText('Nothing installed yet.')).toBeTruthy();
		fireEvent.click(await screen.findByRole('button', { name: 'Install document-skills' }));
		await vi.waitFor(() => expect(api.installPlugin).toHaveBeenCalledWith({ marketplace: 'anthropics/skills', name: 'document-skills' }));
		const skills = await screen.findByLabelText('Skills in document-skills');
		expect(within(skills).getByText('/pdf')).toBeTruthy();
		expect(within(skills).getByText('/xlsx').getAttribute('title')).toMatch(/earlier plugin/);
		expect(screen.getByText(/Also declares MCP servers \(docs\)/)).toBeTruthy();
	});

	it('installs from a GitHub address, and switches marketplaces', async () => {
		open();
		fireEvent.change(await screen.findByLabelText('GitHub address'), { target: { value: 'acme/tools/skills/lint' } });
		fireEvent.click(screen.getByRole('button', { name: 'Install' }));
		await vi.waitFor(() => expect(api.installPlugin).toHaveBeenCalledWith({ address: 'acme/tools/skills/lint' }));
		fireEvent.click(screen.getByRole('tab', { name: 'CognitionAI/devin-marketplace' }));
		await vi.waitFor(() => expect(api.catalog).toHaveBeenCalledWith('CognitionAI/devin-marketplace'));
	});
});

it('browses individual skills from a bundle in another repository before installing one', async () => {
	api.catalog.mockResolvedValueOnce({
		entries: [
			{
				id: 'remote',
				name: 'remote',
				description: 'Remote skills',
				source: { repo: 'acme/remote', path: '', ref: 'abc' },
				skills: null,
				installed: false,
				browseable: true,
			},
		],
	});
	api.catalog.mockResolvedValueOnce({
		entries: [
			{
				id: 'pdf',
				name: 'remote/pdf',
				bundle: 'remote',
				description: 'PDF skill',
				source: { repo: 'acme/remote', path: 'skills/pdf', ref: 'abc' },
				skills: null,
				installed: false,
			},
		],
	});
	open();
	fireEvent.click(await screen.findByRole('button', { name: 'Browse skills in remote' }));
	expect(await screen.findByRole('button', { name: 'Install remote/pdf' })).toBeTruthy();
	expect(api.catalog).toHaveBeenCalledWith('anthropics/skills', 'remote');
});
