import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelChoice, ModelInfo, Subscription } from '@/lib/api';
import { renderWithQueries } from './render';

const planModel = (id: string, name: string, tokens = 0) => ({
	id,
	name,
	contextLength: 272_000,
	vision: true,
	reasoning: ['low', 'medium', 'high', 'xhigh', 'max'] as ModelInfo['reasoning'],
	defaultReasoning: 'medium' as const,
	tokens,
});

const plan = (patch: Partial<Subscription> = {}): Subscription => ({
	id: 'chatgpt',
	name: 'ChatGPT',
	kind: 'oauth',
	gateway: 'openai',
	state: 'signed-out',
	email: null,
	connectedAt: null,
	problem: null,
	expiresAt: null,
	options: { enabled: true, countAtApiPrices: false },
	models: [],
	monthTokens: 0,
	modelsAt: null,
	login: null,
	plan: null,
	version: null,
	signIn: null,
	limitHitAt: null,
	extraUsageAt: null,
	...patch,
});

const pending = { url: 'https://auth.openai.com/api/accounts/authorize?x=1', redirectUri: 'http://127.0.0.1:1455/auth/callback', listening: false, startedAt: new Date().toISOString() };
const connected = plan({
	state: 'connected',
	email: 'ada@example.com',
	connectedAt: '2026-10-08T22:37:44Z',
	expiresAt: new Date(Date.now() + 52 * 60_000).toISOString(),
	models: [planModel('openai/gpt-6.1-sol', 'GPT-6.1-Sol', 1_200_000), planModel('openai/gpt-6-luna', 'GPT-6-Luna', 300_000)],
	monthTokens: 1_500_000,
	modelsAt: new Date().toISOString(),
});

const general = { model: null, reasoning: null, planMode: false, reviewPullRequests: true, codeMode: false, visualReplies: 'some', agentModels: { explorer: null, tester: null, browser: null, computer: null, reviewer: null } };

const api = vi.hoisted(() => ({
	subscriptions: vi.fn(),
	beginSubscriptionLogin: vi.fn(),
	finishSubscriptionLogin: vi.fn(),
	cancelSubscriptionLogin: vi.fn(),
	importSubscriptionLogin: vi.fn(),
	setSubscriptionOptions: vi.fn(),
	refreshSubscriptionModels: vi.fn(),
	disconnectSubscription: vi.fn(),
	connectSubscriptionKey: vi.fn(),
	generalSettings: vi.fn(),
	saveGeneralSettings: vi.fn(),
	models: vi.fn(),
	setPinnedModels: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { SubscriptionsPage } = await import('@/components/settings/subscriptions');
const { ModelPicker } = await import('@/components/model-picker');
const { sourcesOf, visibleModels } = await import('@/lib/model-catalog');
const { logoFor, vendorSlug } = await import('@/lib/provider-logos');

function page() {
	api.generalSettings.mockResolvedValue(general);
	api.models.mockResolvedValue({ models: [], default: 'openrouter/acme/model' });
	return renderWithQueries(<SubscriptionsPage />);
}

describe('Subscriptions', () => {
	it('offers both ways to connect a plan', async () => {
		api.subscriptions.mockResolvedValue({ subscriptions: [plan()] });
		page();
		expect(await screen.findByText('Not connected')).toBeTruthy();
		expect(screen.getByRole('img', { name: /ChatGPT plan not connected yet/ })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy();
		expect(screen.getByLabelText('Sign-in to import')).toBeTruthy();
	});

	const claude = plan({ id: 'claude', name: 'Claude', kind: 'runtime', gateway: 'claude-code', signIn: 'CLAUDE_CONFIG_DIR=/data/claude-code /opt/claude auth login' });

	it('shows a Claude plan with the command that signs Claude Code in on the server', async () => {
		api.subscriptions.mockResolvedValue({ subscriptions: [plan(), claude] });
		api.refreshSubscriptionModels.mockResolvedValue(claude);
		page();
		const tabs = within(await screen.findByRole('tablist', { name: 'Plans' })).getAllByRole('tab');
		expect(tabs.map((tab) => [tab.getAttribute('aria-selected'), tab.querySelector('svg title')?.textContent])).toEqual([
			['true', 'OpenAI'],
			['false', 'Anthropic'],
		]);
		expect(screen.getByRole('tab', { name: 'Claude' })).toBe(tabs[1]);
		expect(screen.queryByLabelText('Command that signs Claude Code in')).toBeNull();
		fireEvent.click(tabs[1]);
		const command = await screen.findByLabelText('Command that signs Claude Code in');
		expect(command.textContent).toBe('CLAUDE_CONFIG_DIR=/data/claude-code /opt/claude auth login');
		expect(screen.getByText('Sign in on the server')).toBeTruthy();
		expect(screen.getByText(/For your own use only/)).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
		await waitFor(() => expect(api.refreshSubscriptionModels).toHaveBeenCalledWith('claude'));
	});

	it('shows a signed-in Claude plan’s account and models, and warns when it bills extra usage', async () => {
		const signedIn = {
			...claude,
			state: 'connected' as const,
			email: 'ada@example.com',
			plan: 'max',
			version: '2.5.0',
			extraUsageAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			models: [{ ...planModel('claude-code/claude-opus-5', 'Claude Opus 5'), contextLength: 200_000 }],
		};
		api.subscriptions.mockResolvedValue({ subscriptions: [signedIn] });
		page();
		expect(await screen.findByText('1 model on your plan')).toBeTruthy();
		expect(screen.getByText('max', { selector: 'dd' })).toBeTruthy();
		expect(screen.getByText('2.5.0', { selector: 'dd' })).toBeTruthy();
		expect(screen.getByText(/calls now bill extra usage/)).toBeTruthy();
		expect(screen.getByLabelText('Command that signs Claude Code out').textContent).toBe('CLAUDE_CONFIG_DIR=/data/claude-code /opt/claude auth logout');
		expect(screen.getByText(/For your own use only/).textContent).not.toContain('auth logout');
		expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
	});

	it('opens ChatGPT in a new tab during the click, then finishes with the pasted address', async () => {
		api.subscriptions.mockResolvedValue({ subscriptions: [plan()] });
		const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
		const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
		api.beginSubscriptionLogin.mockResolvedValue(plan({ login: pending }));
		api.finishSubscriptionLogin.mockResolvedValue(connected);
		page();

		fireEvent.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }));
		expect(open).toHaveBeenCalledWith('', '_blank');
		await waitFor(() => expect(tab.location.href).toBe(pending.url));
		expect(tab.opener).toBeNull();

		const address = await screen.findByLabelText('Address ChatGPT sent you back to');
		expect(screen.getByText('Signing in')).toBeTruthy();
		fireEvent.change(address, { target: { value: 'http://127.0.0.1:1455/auth/callback?code=c&state=s' } });
		fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
		await waitFor(() => expect(api.finishSubscriptionLogin).toHaveBeenCalledWith('chatgpt', 'http://127.0.0.1:1455/auth/callback?code=c&state=s'));
		expect(await screen.findByText('2 models on your plan')).toBeTruthy();
		expect(screen.getByText('GPT-6.1-Sol')).toBeTruthy();
		open.mockRestore();
	});

	it('imports a sign-in from another computer', async () => {
		api.subscriptions.mockResolvedValue({ subscriptions: [plan()] });
		api.importSubscriptionLogin.mockResolvedValue(connected);
		page();
		fireEvent.change(await screen.findByLabelText('Sign-in to import'), { target: { value: '{"openai":{}}' } });
		fireEvent.click(screen.getByRole('button', { name: 'Import sign-in' }));
		await waitFor(() => expect(api.importSubscriptionLogin).toHaveBeenCalledWith('chatgpt', '{"openai":{}}'));
		expect(await screen.findByText('2 models on your plan')).toBeTruthy();
	});

	it('shows a connected plan as a spec sheet and a ranked list of its models', async () => {
		api.subscriptions.mockResolvedValue({ subscriptions: [connected] });
		page();
		expect(await screen.findByRole('img', { name: 'Anton linked to your ChatGPT plan' })).toBeTruthy();
		expect(screen.getByText('2 models on your plan')).toBeTruthy();
		expect(screen.getByText('ada@example.com', { selector: 'dd' })).toBeTruthy();
		expect(screen.getByText('in 52m')).toBeTruthy();
		expect(screen.getByText('1.5M tokens')).toBeTruthy();
		const rows = within(screen.getByRole('list', { name: 'ChatGPT models' })).getAllByRole('listitem');
		expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('gpt-6.1-sol'), expect.stringContaining('gpt-6-luna')]);
		expect(rows[0].textContent).toContain('low – max');
		expect(rows[0].textContent).toContain('1.2M');
	});

	it('makes a plan model the default for new tasks', async () => {
		api.subscriptions.mockResolvedValue({ subscriptions: [connected] });
		api.saveGeneralSettings.mockImplementation(async (settings: typeof general) => settings);
		page();
		const rows = within(await screen.findByRole('list', { name: 'ChatGPT models' })).getAllByRole('listitem');
		await waitFor(() => expect((within(rows[1]).getByRole('button', { name: 'Use for new tasks' }) as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(within(rows[1]).getByRole('button', { name: 'Use for new tasks' }));
		await waitFor(() => expect(api.saveGeneralSettings).toHaveBeenCalledWith({ ...general, model: 'openai/gpt-6-luna', reasoning: null }));
		expect(await within(rows[1]).findByText('Default')).toBeTruthy();
	});

	it('switches a connected plan’s options, and disconnects only on a second click', async () => {
		api.subscriptions.mockResolvedValue({ subscriptions: [connected] });
		api.setSubscriptionOptions.mockResolvedValue({ ...connected, options: { enabled: true, countAtApiPrices: true } });
		api.disconnectSubscription.mockResolvedValue(plan());
		page();
		fireEvent.click(await screen.findByRole('switch', { name: 'Count toward the spending caps' }));
		await waitFor(() => expect(api.setSubscriptionOptions).toHaveBeenCalledWith('chatgpt', { enabled: true, countAtApiPrices: true }));
		expect(await screen.findByText('API prices')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
		expect(api.disconnectSubscription).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Click again to disconnect' }));
		expect(await screen.findByText('Not connected')).toBeTruthy();
	});

	it('shows a revoked sign-in with how to fix it', async () => {
		api.subscriptions.mockResolvedValue({ subscriptions: [plan({ state: 'expired', email: 'ada@example.com', problem: 'The ChatGPT sign-in expired or was revoked.' })] });
		page();
		expect(await screen.findByText('The ChatGPT sign-in expired or was revoked.')).toBeTruthy();
		expect(screen.getAllByText('Sign in again').length).toBeGreaterThan(0);
	});
});

const model = (patch: Partial<ModelInfo>): ModelInfo => ({
	id: 'openrouter/acme/x',
	name: 'X',
	vendor: 'Acme',
	description: '',
	createdAt: 0,
	contextLength: 1000,
	maxOutput: null,
	price: { input: 0, output: 0 },
	vision: false,
	reasoning: [],
	defaultReasoning: 'off',
	...patch,
});

const gpt = model({ id: 'openai/gpt-6.1-sol', name: 'GPT-6.1-Sol', vendor: 'OpenAI', subscription: 'ChatGPT', vision: true, reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'medium' });
const routed = model({ id: 'openrouter/acme/fast', name: 'Fast', reasoning: ['off', 'low', 'high'], defaultReasoning: 'low' });

describe('Model picker', () => {
	it('lists plans first, connected or not, then gateways, and never calls a plan free', () => {
		expect(sourcesOf([routed, gpt], [{ name: 'ChatGPT', connected: true }])).toEqual([
			{ name: 'ChatGPT', plan: true, connected: true, count: 1 },
			{ name: 'OpenRouter', plan: false, connected: true, count: 1 },
		]);
		expect(sourcesOf([routed], [{ name: 'ChatGPT', connected: false }])[0]).toEqual({ name: 'ChatGPT', plan: true, connected: false, count: 0 });
		expect(visibleModels([routed, gpt], '', new Set(['free']), 'newest').map((item) => item.id)).toEqual([routed.id]);
	});

	function Picker({ start }: { start: ModelChoice }) {
		const [value, setValue] = useState(start);
		return <ModelPicker value={value} onChange={(change) => setValue((current) => ({ ...current, ...change }))} side="bottom" />;
	}

	function openPicker(start: ModelChoice, subscriptions: Subscription[] = [connected], models = [routed, gpt], pinned: string[] = []) {
		api.subscriptions.mockResolvedValue({ subscriptions });
		renderWithQueries(<Picker start={start} />, [[['models'], { models, default: routed.id, pinned }]]);
		fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }));
	}

	/** Radix opens menus on pointer down, which fireEvent.click does not send. */
	async function openMenu() {
		const trigger = await screen.findByRole('button', { name: 'Source, filters and sort' });
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
		return screen.findByRole('menu');
	}

	it('shows each source as a section, the plan first, and marks the chosen plan model', async () => {
		openPicker({ model: gpt.id, reasoning: null });
		const list = await screen.findByRole('listbox', { name: 'Models' });
		expect(within(list).getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual(['ChatGPT plan', 'OpenRouter']);
		// The dot on a plan model's mark says it is on a plan, so neither its row nor the trigger spells it out.
		expect(within(within(list).getByRole('group', { name: 'ChatGPT plan' })).getByRole('option').textContent).not.toContain('PLAN');
		expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).not.toContain('PLAN');
	});

	it('narrows to one source, and filters, from one menu that stays open for filters', async () => {
		openPicker({ model: routed.id, reasoning: null });
		const list = await screen.findByRole('listbox', { name: 'Models' });
		let menu = await openMenu();
		expect(within(menu).getByRole('menuitem', { name: /Reasoning/ }).textContent).toContain('2');
		fireEvent.click(within(menu).getByRole('menuitem', { name: /Vision/ }));
		expect(screen.getByRole('menu')).toBeTruthy();
		// The open menu hides the list behind it from assistive tech, as a menu should.
		expect(within(list).getAllByRole('option', { hidden: true }).map((option) => option.textContent)).toEqual([expect.stringContaining('GPT-6.1-Sol')]);
		fireEvent.click(within(menu).getByRole('menuitem', { name: /Vision/ }));
		fireEvent.click(within(menu).getByRole('menuitem', { name: /OpenRouter/ }));
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('Fast')]);
		menu = await openMenu();
		expect(within(menu).getByRole('menuitem', { name: /OpenRouter/ }).textContent).toContain('1');
	});

	it('marks each row with its vendor’s logo, and with initials when there is none', async () => {
		expect(vendorSlug({ id: 'openrouter/~anthropic/claude-latest' })).toBe('anthropic');
		expect(vendorSlug({ id: 'openai/gpt-6.1-sol' })).toBe('openai');
		expect(logoFor({ id: 'openrouter/mistralai/large' })).toContain('<title>Mistral</title>');
		expect(logoFor({ id: 'openrouter/acme/fast' })).toBeUndefined();

		openPicker({ model: gpt.id, reasoning: null });
		const list = await screen.findByRole('listbox', { name: 'Models' });
		const [plan, gateway] = within(list).getAllByRole('option');
		expect(plan.querySelector('svg title')?.textContent).toBe('OpenAI');
		expect(gateway.firstElementChild?.querySelector('svg')).toBeNull();
		expect(gateway.textContent).toContain('Ac');
	});

	it('shows what a million tokens cost in and out, FREE for free models and nothing for a plan’s', async () => {
		const priced = model({ id: 'openrouter/anthropic/haiku', name: 'Haiku', vendor: 'Anthropic', price: { input: 0.1, output: 0.5 } });
		openPicker({ model: gpt.id, reasoning: null }, [connected], [gpt, priced, routed]);
		const list = await screen.findByRole('listbox', { name: 'Models' });
		const [plan, ...gateway] = within(list).getAllByRole('option');
		// A plan's section has no prices, so its context sits at the right edge, where Out would.
		expect([...plan.children].slice(2, 4).map((cell) => cell.textContent)).toEqual(['', '1K']);
		// Input and output prices sit in their own cells, so they line up under the In and Out headers.
		expect([...gateway[0].children].slice(2, 5).map((cell) => cell.textContent)).toEqual(['1K', '$0.1', '$0.5']);
		expect(gateway[1].textContent).toContain('FREE');
		const header = (name: string) => within(list).getByRole('group', { name }).firstElementChild as HTMLElement;
		expect(within(header('OpenRouter')).getByTitle('US dollars per million input tokens').textContent).toBe('In');
		expect(within(header('ChatGPT plan')).queryByTitle('US dollars per million input tokens')).toBeNull();
	});

	it('pins a model to the top without picking it, and unpins it', async () => {
		api.setPinnedModels.mockImplementation(async (pinned: string[]) => ({ pinned }));
		openPicker({ model: gpt.id, reasoning: null });
		const list = await screen.findByRole('listbox', { name: 'Models' });
		const groups = () => within(list).getAllByRole('group').map((group) => group.getAttribute('aria-label'));
		expect(groups()).toEqual(['ChatGPT plan', 'OpenRouter']);

		fireEvent.click(within(list).getByRole('button', { name: 'Pin Fast' }));
		await waitFor(() => expect(api.setPinnedModels).toHaveBeenCalledWith([routed.id]));
		await waitFor(() => expect(groups()).toEqual(['Pinned', 'ChatGPT plan']));
		const pinned = within(list).getByRole('group', { name: 'Pinned' });
		expect(within(pinned).getByRole('option').textContent).toContain('Fast');
		expect(within(pinned).getByRole('button', { name: 'Unpin Fast' }).getAttribute('aria-pressed')).toBe('true');
		// Pinning is not picking: the task keeps its model, and the panel stays open.
		expect(screen.getByRole('button', { name: 'Model and reasoning' }).textContent).toContain('GPT-6.1-Sol');

		fireEvent.click(within(pinned).getByRole('button', { name: 'Unpin Fast' }));
		await waitFor(() => expect(api.setPinnedModels).toHaveBeenLastCalledWith([]));
		await waitFor(() => expect(groups()).toEqual(['ChatGPT plan', 'OpenRouter']));
	});

	it('puts pinned matches first while searching', async () => {
		openPicker({ model: gpt.id, reasoning: null }, [connected], [gpt, routed, model({ id: 'openrouter/acme/fast-two', name: 'Fast Two' })], ['openrouter/acme/fast-two']);
		fireEvent.change(await screen.findByLabelText('Search models'), { target: { value: 'fast' } });
		const list = screen.getByRole('listbox', { name: 'Models' });
		expect(within(list).getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual(['Pinned', 'Matches']);
		expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('Fast Two'), expect.stringContaining('Fast')]);
	});

	it('tells you how to connect a plan that is not signed in', async () => {
		openPicker({ model: routed.id, reasoning: null }, [plan()], [routed]);
		expect(await screen.findByText('ChatGPT is not connected. Sign in under Settings › Subscriptions.')).toBeTruthy();
	});

	it('filters by any number of providers next to the count, and clears them', async () => {
		const claude = model({ id: 'openrouter/anthropic/claude-x', name: 'Claude X', vendor: 'Anthropic' });
		openPicker({ model: routed.id, reasoning: null }, [connected], [routed, gpt, claude]);
		const list = await screen.findByRole('listbox', { name: 'Models' });
		const trigger = await screen.findByRole('button', { name: 'Filter by provider' });
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
		let menu = await screen.findByRole('menu');
		expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([expect.stringMatching(/Acme1$/), expect.stringMatching(/Anthropic1$/), expect.stringMatching(/OpenAI1$/)]);
		fireEvent.click(within(menu).getByRole('menuitem', { name: /Anthropic/ }));
		fireEvent.click(within(menu).getByRole('menuitem', { name: /OpenAI/ }));
		expect(screen.getByRole('menu')).toBeTruthy();
		await userEvent.keyboard('{Escape}');
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('GPT-6.1-Sol'), expect.stringContaining('Claude X')]);
		expect(screen.getByText('2/3')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Providers: Anthropic, OpenAI' })).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Clear the provider filter' }));
		expect(within(list).getAllByRole('option')).toHaveLength(3);
		expect(screen.getByText('3')).toBeTruthy();
		menu = await (async () => {
			fireEvent.pointerDown(screen.getByRole('button', { name: 'Filter by provider' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
			return screen.findByRole('menu');
		})();
		expect(within(menu).queryByRole('button', { name: /Clear/ })).toBeNull();
	});

	it('sets the effort along the bottom, by click or with the arrow keys', async () => {
		openPicker({ model: gpt.id, reasoning: null });
		const effort = await screen.findByRole('radiogroup', { name: 'Reasoning effort' });
		expect(within(effort).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Low', 'Med', 'High', 'X-High', 'Max']);
		expect(within(effort).getByRole('radio', { checked: true }).textContent).toBe('Med');

		fireEvent.click(within(effort).getByRole('radio', { name: 'Max' }));
		expect(within(effort).getByRole('radio', { checked: true }).textContent).toBe('Max');

		within(effort).getByRole('radio', { checked: true }).focus();
		await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
		expect(within(effort).getByRole('radio', { checked: true }).textContent).toBe('High');
		expect(screen.getByRole('listbox', { name: 'Models' })).toBeTruthy();
	});

	it('shows a plan model once, with its larger context and fast mode as controls beside its effort', async () => {
		const variant = (suffix: string, contextLength: number, context: string | null, fast: boolean, description: string) =>
			model({ ...gpt, id: `${gpt.id}${suffix}`, name: `GPT-6.1-Sol${suffix}`, contextLength, description, variant: { of: gpt.id, context, fast } });
		const family = [
			{ ...gpt, contextLength: 272_000 },
			variant('[1m]', 1_000_000, '1m', false, 'Up to 1M of context.'),
			variant('[fast]', 272_000, null, true, 'Fast mode answers sooner.'),
			variant('[1m][fast]', 1_000_000, '1m', true, 'Up to 1M of context. Fast mode answers sooner.'),
		];
		openPicker({ model: gpt.id, reasoning: 'high' }, [connected], [routed, ...family]);
		const list = await screen.findByRole('listbox', { name: 'Models' });
		expect(within(within(list).getByRole('group', { name: 'ChatGPT plan' })).getAllByRole('option')).toHaveLength(1);

		const context = screen.getByRole('radiogroup', { name: 'Context window' });
		expect(within(context).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['272K', '1M']);
		fireEvent.click(within(context).getByRole('radio', { name: /1M/ }));
		const trigger = screen.getByRole('button', { name: 'Model and reasoning' });
		expect(trigger.textContent).toContain('1M');
		// What the variant costs is not spelled out under the controls.
		expect(screen.queryByText('Up to 1M of context.')).toBeNull();

		fireEvent.click(screen.getByRole('switch', { name: 'Fast mode' }));
		expect(screen.getByRole('switch', { name: 'Fast mode' }).getAttribute('aria-checked')).toBe('true');
		// The variant is the same model: it stays the one row marked chosen, at the effort you set.
		expect(within(list).getByRole('option', { selected: true }).textContent).toContain('GPT-6.1-Sol');
		expect(within(screen.getByRole('radiogroup', { name: 'Reasoning effort' })).getByRole('radio', { checked: true }).textContent).toBe('High');

		within(context).getByRole('radio', { checked: true }).focus();
		await userEvent.keyboard('{ArrowLeft}');
		expect(within(context).getByRole('radio', { checked: true }).textContent).toBe('272K');
		expect(screen.getByRole('switch', { name: 'Fast mode' }).getAttribute('aria-checked')).toBe('true');

		// A model without them has neither control.
		fireEvent.click(within(list).getByRole('option', { name: /Fast/ }));
		expect(screen.queryByRole('radiogroup', { name: 'Context window' })).toBeNull();
		expect(screen.queryByRole('switch', { name: 'Fast mode' })).toBeNull();
	});
});

describe('Plans used with a key', () => {
	const go = plan({ id: 'opencode-go', name: 'OpenCode Go', kind: 'key', gateway: 'opencode-go', keyPage: 'https://opencode.ai/auth', keyHint: null, windows: null });
	const cursor = plan({ id: 'cursor', name: 'Cursor', kind: 'key', gateway: 'cursor', keyPage: 'https://cursor.com/dashboard/api', keyHint: null, windows: null });
	const goConnected = {
		...go,
		state: 'connected' as const,
		connectedAt: '2026-10-08T22:37:44Z',
		keyHint: 'a1b2',
		models: [planModel('opencode-go/glm-5.1', 'GLM-5.1', 800_000)],
		monthTokens: 800_000,
		windows: [
			{ label: '5 hours', usedPercent: 12.5, resetsAt: null, limited: false },
			{ label: 'Week', usedPercent: 100, resetsAt: null, limited: true },
		],
	};

	it('takes a key, checks it on the server, and shows the plan’s models', async () => {
		api.subscriptions.mockResolvedValue({ subscriptions: [go, cursor] });
		api.connectSubscriptionKey.mockResolvedValue(goConnected);
		page();
		const tabs = within(await screen.findByRole('tablist', { name: 'Plans' })).getAllByRole('tab');
		expect(tabs.map((tab) => [tab.getAttribute('aria-selected'), tab.textContent?.endsWith(tab.id === 'plan-tab-cursor' ? 'Cursor' : 'OpenCode Go'), Boolean(tab.querySelector('svg'))])).toEqual([
			['true', true, true],
			['false', true, true],
		]);
		expect(screen.getByRole('link', { name: /Open the key page/ }).getAttribute('href')).toBe('https://opencode.ai/auth');
		const key = screen.getByLabelText('OpenCode Go key') as HTMLInputElement;
		expect(key.type).toBe('password');
		fireEvent.change(key, { target: { value: 'sk-go-a1b2' } });
		fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
		await waitFor(() => expect(api.connectSubscriptionKey).toHaveBeenCalledWith('opencode-go', 'sk-go-a1b2'));
		expect(await screen.findByText('1 model on your plan')).toBeTruthy();
		expect(screen.getByText('…a1b2', { selector: 'dd' })).toBeTruthy();
		const limits = within(screen.getByRole('list', { name: 'Plan limits' })).getAllByRole('listitem');
		expect(limits.map((row) => row.textContent)).toEqual(['5 hours13% used', 'WeekLimit reached']);
		expect(screen.getByRole('switch', { name: 'Count toward the spending caps' })).toBeTruthy();
	});

	it('leaves the spending-caps switch out for Cursor, which has no prices to count at', async () => {
		api.subscriptions.mockResolvedValue({
			subscriptions: [{ ...cursor, state: 'connected' as const, email: 'ada@example.com', keyHint: 'zz99', models: [planModel('cursor/gpt-5.5', 'GPT-5.5')] }],
		});
		page();
		expect(await screen.findByText('1 model on your plan')).toBeTruthy();
		expect(screen.getByText('ada@example.com', { selector: 'dd' })).toBeTruthy();
		expect(screen.getByRole('switch', { name: 'Use Cursor models' })).toBeTruthy();
		expect(screen.queryByRole('switch', { name: 'Count toward the spending caps' })).toBeNull();
		expect(screen.getByText(/under Cursor's terms/)).toBeTruthy();
		expect(logoFor({ id: 'cursor/gpt-5.5' })).toBeTruthy();
		expect(logoFor({ id: 'opencode-go/glm-5.1' })).toBeTruthy();
	});
});
