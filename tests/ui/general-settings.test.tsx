import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQueries } from './render';

const general = {
	model: null,
	reasoning: null,
	planMode: false,
	reviewPullRequests: true,
	codeMode: false,
	visualReplies: 'some',
	pageNetwork: true,
	agentModels: { explorer: null, tester: null, browser: null, computer: null, reviewer: null },
};

const api = vi.hoisted(() => ({
	generalSettings: vi.fn(),
	saveGeneralSettings: vi.fn(),
	models: vi.fn(),
	subscriptions: vi.fn(),
	setPinnedModels: vi.fn(),
}));

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { GeneralPage } = await import('@/components/settings/general');

function page() {
	api.generalSettings.mockResolvedValue(general);
	api.models.mockResolvedValue({ models: [], default: 'openrouter/acme/model' });
	api.subscriptions.mockResolvedValue({ subscriptions: [] });
	api.saveGeneralSettings.mockImplementation(async (settings: typeof general) => settings);
	return renderWithQueries(<GeneralPage />);
}

describe('General settings', () => {
	it('keeps changes until Save sends them together', async () => {
		page();
		const planMode = await screen.findByRole('switch', { name: 'Start in plan mode' });
		const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
		expect(save.disabled).toBe(true);

		fireEvent.click(planMode);
		fireEvent.click(screen.getByRole('radio', { name: 'More' }));
		expect(api.saveGeneralSettings).not.toHaveBeenCalled();
		expect(screen.getByText('Unsaved changes')).toBeTruthy();

		fireEvent.click(save);
		await waitFor(() => expect(api.saveGeneralSettings).toHaveBeenCalledWith({ ...general, planMode: true, visualReplies: 'more' }));
		expect(await screen.findByText('Saved.')).toBeTruthy();
		expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('puts the page back as saved on Cancel', async () => {
		page();
		const codeMode = await screen.findByRole('switch', { name: 'Code mode' });
		fireEvent.click(codeMode);
		expect(codeMode.getAttribute('aria-checked')).toBe('true');
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(codeMode.getAttribute('aria-checked')).toBe('false');
		expect(screen.queryByText('Unsaved changes')).toBeNull();
		expect(api.saveGeneralSettings).not.toHaveBeenCalled();
	});
});
