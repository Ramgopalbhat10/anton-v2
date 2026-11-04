import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
	imageModel: null,
	titleModel: null,
	compactAt: 200_000,
	claudeCodeCompactAt: 200_000,
	agentModels: { explorer: null, tester: null, browser: null, computer: null, reviewer: null },
};

const api = vi.hoisted(() => ({
	generalSettings: vi.fn(),
	saveGeneralSettings: vi.fn(),
	models: vi.fn(),
	subscriptions: vi.fn(),
	setPinnedModels: vi.fn(),
	imageModels: vi.fn(),
}));

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { GeneralPage } = await import('@/components/settings/general');

function page(settings: object = general, models: object[] = []) {
	api.generalSettings.mockResolvedValue(settings);
	api.models.mockResolvedValue({ models, default: 'openrouter/acme/model' });
	api.subscriptions.mockResolvedValue({ subscriptions: [] });
	api.imageModels.mockResolvedValue({
		available: true,
		default: 'openrouter/openai/gpt-image-2.5-flare',
		models: [
			{ id: 'openrouter/openai/gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', vendor: 'OpenAI', description: '', references: 16, aspectRatios: [], transparent: true },
			{ id: 'openrouter/google/gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image', vendor: 'Google', description: '', references: 14, aspectRatios: [], transparent: false },
		],
	});
	api.saveGeneralSettings.mockImplementation(async (settings: typeof general) => settings);
	return renderWithQueries(<GeneralPage />);
}

describe('General settings', () => {
	it('keeps changes until Save sends them together', async () => {
		page();
		const planMode = await screen.findByRole('switch', { name: 'Start in plan mode' });
		const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		expect(screen.getByText('Title model')).toBeTruthy();

		fireEvent.click(planMode);
		fireEvent.click(screen.getByRole('radio', { name: 'More' }));
		const compactAt = within(screen.getByRole('radiogroup', { name: 'Compact at' }));
		const claudeCode = within(screen.getByRole('radiogroup', { name: 'Compact Claude Code at' }));
		expect(compactAt.getByRole('radio', { name: '200K' }).getAttribute('aria-checked')).toBe('true');
		expect(claudeCode.getByRole('radio', { name: '200K' }).getAttribute('aria-checked')).toBe('true');
		fireEvent.click(compactAt.getByRole('radio', { name: 'Full' }));
		fireEvent.click(claudeCode.getByRole('radio', { name: '400K' }));
		expect(api.saveGeneralSettings).not.toHaveBeenCalled();
		expect(screen.getByText('Unsaved changes')).toBeTruthy();

		fireEvent.click(save);
		await waitFor(() =>
			expect(api.saveGeneralSettings).toHaveBeenCalledWith({ ...general, planMode: true, visualReplies: 'more', compactAt: null, claudeCodeCompactAt: 400_000 }),
		);
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

	it('picks the image model the agent draws with, by maker, or leaves the default', async () => {
		page();
		const picker = await screen.findByRole('button', { name: 'Default · GPT Image 2.5 Flare' });
		fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
		fireEvent.keyDown(await screen.findByRole('menuitem', { name: /Google/ }), { key: 'ArrowRight' });
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Gemini 3.1 Flash Image' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(api.saveGeneralSettings).toHaveBeenCalledWith({ ...general, imageModel: 'openrouter/google/gemini-3.1-flash-image' }));
		expect(await screen.findByRole('button', { name: 'Gemini 3.1 Flash Image' })).toBeTruthy();
	});

	it('saves the effort picked for a background model, as every model picker does', async () => {
		const summarizer = {
			id: 'claude-code/claude-sonnet-5-5',
			name: 'Claude Sonnet 5.5',
			vendor: 'Anthropic',
			description: '',
			createdAt: 0,
			contextLength: 1_000_000,
			maxOutput: null,
			price: { input: 0, output: 0 },
			vision: true,
			reasoning: ['off', 'low', 'medium', 'high'],
			defaultReasoning: 'high',
			subscription: 'Claude',
		};
		const settings = {
			...general,
			backgroundModels: { webDigest: null, vision: null, compaction: summarizer.id },
			backgroundReasoning: { webDigest: null, vision: null, compaction: null },
		};
		page(settings, [summarizer]);
		// The compaction model's picker is the last on the page.
		fireEvent.click((await screen.findAllByRole('button', { name: 'Model and reasoning' })).at(-1)!);
		const effort = await screen.findByRole('radiogroup', { name: 'Reasoning effort' });
		expect(within(effort).getByRole('radio', { checked: true }).textContent).toBe('High');
		fireEvent.click(within(effort).getByRole('radio', { name: 'Low' }));
		expect(within(effort).getByRole('radio', { checked: true }).textContent).toBe('Low');
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(api.saveGeneralSettings).toHaveBeenCalledWith({ ...settings, backgroundReasoning: { webDigest: null, vision: null, compaction: 'low' } }),
		);
	});

	it('says an image model needs an OpenRouter key when there is none', async () => {
		api.imageModels.mockResolvedValueOnce({ available: false, default: 'openrouter/openai/gpt-image-2.5-flare', models: [] });
		page();
		expect(await screen.findByText('Needs an OpenRouter key')).toBeTruthy();
	});
});
