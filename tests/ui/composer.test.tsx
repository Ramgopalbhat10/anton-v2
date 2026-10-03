import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({
	editSession: vi.fn(),
	session: vi.fn(),
	budget: vi.fn(),
	models: vi.fn(),
	files: vi.fn(),
	commands: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { Composer } = await import('@/components/composer');

const model = { id: 'openrouter/test/model', name: 'Test model', vendor: 'Test', description: '', createdAt: 0, contextLength: 128000, maxOutput: null, price: { input: 0, output: 0 }, vision: false, reasoning: [], defaultReasoning: 'off' };

function setup(patch = {}) {
	const onSend = vi.fn(async () => undefined);
	const onStop = vi.fn(async () => undefined);
	const view = renderWithQueries(<Composer sessionId="s1" onSend={onSend} onStop={onStop} />, [
		[['session', 's1'], session(patch)],
		[['models'], { models: [model], default: model.id }],
		[['budget', 's1'], { limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null }],
		[['files', 's1'], { source: 'base', at: null, paths: ['src/app.ts', 'src/server.ts', 'README.md'], changes: [] }],
		[['commands'], { commands: [{ name: 'review', prompt: 'Review the branch for bugs.' }] }],
	]);
	return { ...view, onSend, onStop, box: screen.getByRole('textbox') as HTMLTextAreaElement };
}

describe('Composer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.editSession.mockImplementation(async (_id: string, change: object) => session(change));
	});

	it('sends on Enter and keeps Shift+Enter for a new line', async () => {
		const { box, onSend } = setup();
		await userEvent.type(box, 'Fix the bug{Shift>}{Enter}{/Shift}now');
		expect(box.value).toBe('Fix the bug\nnow');
		await userEvent.type(box, '{Enter}');
		expect(onSend).toHaveBeenCalledWith('Fix the bug\nnow', []);
		expect(box.value).toBe('');
	});

	it('puts the draft back and says why when sending fails', async () => {
		const { box, onSend } = setup();
		onSend.mockRejectedValueOnce(new Error('cap reached'));
		await userEvent.type(box, 'Keep me{Enter}');
		await screen.findByText('Not sent: cap reached');
		expect(box.value).toBe('Keep me');
	});

	it('offers the task files after @ and inserts the chosen path', async () => {
		const { box } = setup();
		await userEvent.type(box, 'Look at @serv');
		expect(await screen.findByRole('option', { name: /server\.ts/ })).toBeTruthy();
		await userEvent.keyboard('{Enter}');
		expect(box.value).toBe('Look at @src/server.ts ');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('fills in a saved command typed with / at the start', async () => {
		const { box, onSend } = setup();
		await userEvent.type(box, '/rev');
		await screen.findByRole('option', { name: /\/review/ });
		await userEvent.keyboard('{Tab}');
		expect(box.value).toBe('Review the branch for bugs.');
		expect(onSend).not.toHaveBeenCalled();
	});

	it('Escape closes the suggestions so Enter sends', async () => {
		const { box, onSend } = setup();
		await userEvent.type(box, 'mail @serv');
		await screen.findByRole('listbox');
		await userEvent.keyboard('{Escape}{Enter}');
		expect(onSend).toHaveBeenCalledWith('mail @serv', []);
	});

	it('turns plan mode on and off for the task', async () => {
		setup();
		const toggle = screen.getByRole('button', { name: /Plan/ });
		expect(toggle.getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(toggle);
		expect(api.editSession).toHaveBeenCalledWith('s1', { planMode: true });
		await waitFor(() => expect(screen.getByRole('button', { name: /Plan/ }).getAttribute('aria-pressed')).toBe('true'));
		expect(screen.getByPlaceholderText('Describe what to plan')).toBeTruthy();
	});

	it('shows Stop while the agent works and refuses to send past a cap', async () => {
		const onStop = vi.fn(async () => undefined);
		renderWithQueries(<Composer sessionId="s1" busy onSend={vi.fn()} onStop={onStop} />, [
			[['session', 's1'], session()],
			[['models'], { models: [model], default: model.id }],
			[['budget', 's1'], { limits: { dailyUsd: 1, taskUsd: null }, today: 1, task: 0, blocked: "Today's spending cap of $1 is reached." }],
		]);
		fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }));
		expect(onStop).toHaveBeenCalled();
		expect(screen.getByText("Today's spending cap of $1 is reached.")).toBeTruthy();
		expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
	});
});
