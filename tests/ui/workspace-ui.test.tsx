import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ContextView, ModelInfo, PlanUsage, Session } from '@/lib/api';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({
	models: vi.fn(),
	context: vi.fn(),
	usage: vi.fn(),
	budget: vi.fn(),
	generalSettings: vi.fn(),
	stopSession: vi.fn(),
	forkSession: vi.fn(),
	session: vi.fn(async () => ({})),
	changes: vi.fn(async () => ({ source: 'base', patch: '' })),
	resumeSession: vi.fn(async () => ({})),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { RackCard } = await import('@/components/task-rack');
const { ContextMeter } = await import('@/components/context-meter');
const { StackedDaysChart } = await import('@/components/charts');
const { VmPanel } = await import('@/components/vm-panel');

const model = (patch: Partial<ModelInfo>): ModelInfo => ({
	id: 'openai/gpt-6-luna',
	name: 'GPT-6-Luna',
	vendor: 'OpenAI',
	description: '',
	createdAt: 0,
	contextLength: 272_000,
	maxOutput: 128_000,
	price: { input: 0, output: 0 },
	vision: true,
	reasoning: [],
	defaultReasoning: 'off',
	...patch,
});
const planModel = model({ subscription: 'ChatGPT' });
const routed = model({ id: 'openrouter/acme/fast', name: 'Fast', vendor: 'Acme', price: { input: 1, output: 4 } });

function inRouter(ui: React.ReactNode, seed: Array<[unknown[], unknown]>) {
	const root = createRootRoute({ component: () => ui });
	const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
	return renderWithQueries(<RouterProvider router={router} />, seed);
}

describe('Rack card', () => {
	const models: Array<[unknown[], unknown]> = [[['models'], { models: [planModel], default: planModel.id }]];

	it('shows the task’s latest input, when it came, and that the task bills a plan', async () => {
		const task: Session = session({
			title: 'What is this project about?',
			model: planModel.id,
			lastInput: 'Is the app using SQLite for persistence?',
			lastInputAt: new Date(Date.now() - 3 * 60_000).toISOString(),
			createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
			usage: { inputTokens: 60_000, outputTokens: 4_000, cost: 0 },
		});
		inRouter(<RackCard sessions={[task]} />, models);
		fireEvent.focus(await screen.findByRole('link', { name: /What is this project about\?/ }));
		const card = await screen.findByRole('dialog', { name: 'What is this project about?' });
		expect(within(card).getByText('Latest input')).toBeTruthy();
		expect(within(card).getByText('Is the app using SQLite for persistence?')).toBeTruthy();
		expect(within(card).getByText('3m ago')).toBeTruthy();
		expect(within(card).getByText('started 2h ago')).toBeTruthy();
		expect(within(card).getByText('billed').previousElementSibling?.textContent).toBe('plan');
	});

	it('falls back to the first message for a task from before inputs were kept', async () => {
		inRouter(<RackCard sessions={[session({ title: 'Fix the flaky upload test', lastInput: null, lastInputAt: null })]} />, models);
		fireEvent.focus(await screen.findByRole('link', { name: /Fix the flaky upload test/ }));
		const card = await screen.findByRole('dialog');
		expect(within(card).getByText('Input')).toBeTruthy();
		expect(within(card).getAllByText('Fix the flaky upload test').length).toBe(2);
	});
});

describe('Context meter', () => {
	const view: ContextView = {
		model: planModel.id,
		window: 272_000,
		used: 136_000,
		autocompactAt: 252_000,
		parts: [
			{ key: 'messages', tokens: 100_000 },
			{ key: 'tools', tokens: 20_000 },
			{ key: 'systemPrompt', tokens: 10_000 },
			{ key: 'skills', tokens: 4_000 },
			{ key: 'mcpTools', tokens: 2_000 },
		],
		at: new Date(Date.now() - 60_000).toISOString(),
		task: { calls: 9, tokens: 377_000 },
	};
	const plan: PlanUsage = {
		id: 'chatgpt',
		name: 'ChatGPT',
		gateway: 'openai',
		connected: true,
		tokens: { today: 64_000, week: 300_000, month: 1_000_000 },
		calls: 6,
		apiValue: 1.23,
		daily: [],
		limitHitAt: null,
		usagePage: 'https://chatgpt.com/settings/usage',
	};

	it('shows how full the window is, and opens on what fills it, how far it is from compacting, and the plan', () => {
		renderWithQueries(<ContextMeter sessionId="s1" model={planModel.id} />, [
			[['context', 's1'], view],
			[['models'], { models: [planModel], default: planModel.id }],
			[['usage'], { since: '', today: 0, month: 0, byRepo: [], byModel: [], daily: [], plans: [plan] }],
		]);
		const trigger = screen.getByRole('button', { name: 'Context window 50% full' });
		expect(trigger.textContent).toBe('50%');
		fireEvent.click(trigger);
		expect(screen.getByText('Context window')).toBeTruthy();
		for (const label of ['Messages', 'Agent tools', 'System prompt', 'Skills', 'MCP tools', 'Autocompact buffer', 'Free space']) expect(screen.getByText(label)).toBeTruthy();
		expect(screen.getByText('Messages').parentElement?.textContent).toContain('37%');
		expect(screen.getByText('until the agent compacts older turns').previousElementSibling?.textContent).toBe('116K');
		// The total beside the task's title counts every call, each reading the whole conversation again.
		expect(screen.getByText(/This task processed/).textContent).toMatch(/377K tokens over 9 model calls/);
		expect(screen.getByText('ChatGPT plan')).toBeTruthy();
		expect(screen.getByText('≈ $1.23')).toBeTruthy();
		expect(screen.getByRole('link', { name: /Limits in ChatGPT/ }).getAttribute('href')).toBe('https://chatgpt.com/settings/usage');
	});

	it('before the first reply says it will be measured, and for a per-token model shows the spend', () => {
		renderWithQueries(<ContextMeter sessionId="s1" model={routed.id} />, [
			[['context', 's1'], { model: null, window: 0, used: 0, autocompactAt: 0, parts: [], at: null }],
			[['models'], { models: [routed], default: routed.id }],
			[['budget', 's1'], { limits: { dailyUsd: 10, taskUsd: null }, today: 2.5, task: 0.75, blocked: null }],
		]);
		fireEvent.click(screen.getByRole('button', { name: 'Context window' }));
		expect(screen.getByText(/Measured from the agent's next reply/)).toBeTruthy();
		expect(screen.getByText('$0.750')).toBeTruthy();
		expect(screen.getByText('$2.50').parentElement?.textContent).toContain('/ $10');
	});
});

describe('Daily chart', () => {
	it('labels the busiest day, and reads a day by pointer or arrow keys', () => {
		const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 600, height: 168, top: 0, left: 0, right: 600, bottom: 168, x: 0, y: 0, toJSON: () => ({}) });
		const days = ['2026-10-06', '2026-10-07', '2026-10-08'];
		const { container } = renderWithQueries(
			<StackedDaysChart
				rows={[
					{ day: '2026-10-06', series: 'Luna', value: 1_000_000 },
					{ day: '2026-10-08', series: 'Luna', value: 40_000 },
					{ day: '2026-10-08', series: 'Sol', value: 24_000 },
				]}
				days={days}
				series={['Luna', 'Sol']}
				format={(value) => `${Math.round(value / 1000)}K`}
				label="Tokens per day"
			/>,
		);
		const chart = screen.getByRole('figure', { name: 'Tokens per day' });
		// The top tick and the busiest day's label.
		expect(within(chart).getAllByText('1000K')).toHaveLength(2);
		expect(within(chart).getByText('Today')).toBeTruthy();

		fireEvent.pointerEnter(container.querySelectorAll('svg > g > rect[fill="transparent"]')[2]);
		const tooltip = chart.querySelector('.in-pop') as HTMLElement;
		expect(tooltip.textContent).toContain('64K');
		expect(tooltip.textContent).toContain('Sol');

		fireEvent.keyDown(chart, { key: 'ArrowLeft' });
		expect(chart.querySelector('[aria-live]')?.textContent).toBe('Oct 7: 0K');
		fireEvent.keyDown(chart, { key: 'ArrowLeft' });
		expect(chart.querySelector('[aria-live]')?.textContent).toBe('Oct 6: 1000K');
		rect.mockRestore();
	});
});

describe('Workspace panel header', () => {
	const panel = (status: Session['status']) =>
		renderWithQueries(
			<VmPanel sessionId="s1" tabs={['Changes', 'Files']} active={null} onTabsChange={() => {}} onActiveChange={() => {}} expanded={false} onToggleExpanded={() => {}} onClose={() => {}} />,
			[
				[['session', 's1'], session({ id: 's1', status })],
				[['changes', 's1'], { source: 'base', patch: '' }],
			],
		);

	it('offers Resume among its icons while the sandbox is stopped, and each tab closes from its own button', async () => {
		panel('stopped');
		const tabs = screen.getByRole('tablist', { name: 'Workspace panels' });
		expect(within(tabs).getAllByRole('tab')).toHaveLength(2);
		expect(within(tabs).getByRole('button', { name: 'Close Files' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: /^Resume: start the sandbox/ }));
		await waitFor(() => expect(api.resumeSession).toHaveBeenCalledTimes(1));
	});

	it('hides Resume once the sandbox runs', () => {
		panel('running');
		expect(screen.queryByRole('button', { name: /^Resume/ })).toBeNull();
	});
});
