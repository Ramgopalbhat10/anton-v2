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
	attachToTask: vi.fn(),
	connectors: vi.fn(),
	setMailboxOptions: vi.fn(),
	setMcpServerEnabled: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { Composer } = await import('@/components/composer');

const model = {
	id: 'openrouter/test/model',
	name: 'Test model',
	vendor: 'Test',
	description: '',
	createdAt: 0,
	contextLength: 128000,
	maxOutput: null,
	price: { input: 0, output: 0 },
	vision: false,
	reasoning: [],
	defaultReasoning: 'off',
};

const CONNECTORS = {
	accounts: [{ id: 'google', name: 'Google', client: null, email: 'me@example.com', connectedAt: '2026-10-17T08:00:00Z', scopes: [], problem: null, callbackPath: '' }],
	mailboxes: [{ id: 'gmail', name: 'Gmail', account: 'google', options: { enabled: true, draft: true, send: true }, canDraft: true, access: { read: true, draft: true, send: true } }],
	mcpServers: [
		{ name: 'tracker', url: 'https://tracker.example.test/mcp', tools: [], hasAuth: true, signIn: { state: 'none', since: null, problem: null, clientId: null, pastedClient: false }, enabled: false, addedAt: '' },
	],
};

function setup(patch = {}) {
	const onSend = vi.fn(async () => undefined);
	const onStop = vi.fn(async () => undefined);
	const view = renderWithQueries(<Composer sessionId="s1" onSend={onSend} onStop={onStop} />, [
		[['session', 's1'], session(patch)],
		[['models'], { models: [model], default: model.id }],
		[['budget', 's1'], { limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null }],
		[['files', 's1'], { source: 'base', at: null, paths: ['src/app.ts', 'src/server.ts', 'README.md'], changes: [] }],
		[['commands'], { commands: [{ name: 'review', prompt: 'Review the branch for bugs.' }] }],
		[['connectors'], CONNECTORS],
	]);
	return { ...view, onSend, onStop, box: screen.getByRole('textbox') as HTMLElement };
}

describe('Composer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.editSession.mockImplementation(async (_id: string, change: object) => session(change));
	});

	it("turns connectors on and off from the + menu, for every task, without touching the task", async () => {
		api.connectors.mockResolvedValue(CONNECTORS);
		api.setMailboxOptions.mockResolvedValue({ accounts: CONNECTORS.accounts, mailboxes: [{ ...CONNECTORS.mailboxes[0], options: { enabled: false, draft: true, send: true } }] });
		api.setMcpServerEnabled.mockResolvedValue({ mcpServers: [{ ...CONNECTORS.mcpServers[0], enabled: true }] });
		setup();
		await userEvent.click(screen.getByRole('button', { name: 'Add files and connectors' }));
		expect(screen.getByRole('menuitem', { name: 'Attach files' })).toBeTruthy();
		await userEvent.click(screen.getByRole('menuitem', { name: /Connectors/ }));
		const gmail = await screen.findByRole('menuitemcheckbox', { name: /Gmail/ });
		expect(gmail.getAttribute('aria-checked')).toBe('true');
		expect(screen.getByRole('menuitemcheckbox', { name: /tracker/ }).getAttribute('aria-checked')).toBe('false');
		await userEvent.click(gmail);
		await waitFor(() => expect(api.setMailboxOptions).toHaveBeenCalledWith('gmail', { enabled: false, draft: true, send: true }));
		// The menu stays open, so another can be flipped in a row.
		await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /tracker/ }));
		await waitFor(() => expect(api.setMcpServerEnabled).toHaveBeenCalledWith('tracker', true));
		expect(screen.getByText(/Tools load only when a task uses them/)).toBeTruthy();
		expect(api.editSession).not.toHaveBeenCalled();
	});

	it('sends on Enter and keeps Shift+Enter for a new line', async () => {
		const { box, onSend } = setup();
		await userEvent.type(box, 'Fix the bug{Shift>}{Enter}{/Shift}now');
		expect(box.textContent).toBe('Fix the bug\nnow');
		await userEvent.type(box, '{Enter}');
		expect(onSend).toHaveBeenCalledWith('Fix the bug\nnow', []);
		expect(box.textContent).toBe('');
	});

	it('puts the draft back and says why when sending fails', async () => {
		const { box, onSend } = setup();
		onSend.mockRejectedValueOnce(new Error('cap reached'));
		await userEvent.type(box, 'Keep me{Enter}');
		await screen.findByText('Not sent: cap reached');
		expect(box.textContent).toBe('Keep me');
	});

	it('offers the task files after @ and inserts the chosen path', async () => {
		const { box } = setup();
		await userEvent.type(box, 'Look at @serv');
		expect(await screen.findByRole('option', { name: /server\.ts/ })).toBeTruthy();
		await userEvent.keyboard('{Enter}');
		expect(box.textContent).toBe('Look at @server.ts ');
		expect(screen.getByLabelText('File src/server.ts').getAttribute('title')).toBe('src/server.ts');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('fills in a saved command typed with / at the start', async () => {
		const { box, onSend } = setup();
		await userEvent.type(box, '/rev');
		await screen.findByRole('option', { name: /\/review/ });
		await userEvent.keyboard('{Tab}');
		expect(screen.getByLabelText('Command /review')).toBeTruthy();
		await userEvent.keyboard('{Enter}');
		expect(onSend).toHaveBeenCalledWith('Review the branch for bugs.', []);
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
		expect(screen.getByRole('textbox', { name: 'Describe what to plan' })).toBeTruthy();
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

describe('attachments', () => {
	beforeEach(() => vi.clearAllMocks());
	const paste = (box: HTMLElement, files: File[], text = '') =>
		fireEvent.paste(box, { clipboardData: { files, getData: (type: string) => (type === 'text/plain' ? text : '') } });

	it('attaches any pasted file, uploads it on send and sends what it says after the message', async () => {
		const { box, onSend } = setup();
		paste(box, [new File(['%PDF-1.4'], 'spec.pdf', { type: 'application/pdf' })]);
		expect(await screen.findByText('spec.pdf')).toBeTruthy();
		api.attachToTask.mockResolvedValueOnce({ name: 'spec.pdf', path: 'uploads/spec.pdf', size: 8, kind: 'PDF', text: 'Invoices are monthly.', cut: null });
		await userEvent.type(box, 'Summarize it{Enter}');
		await waitFor(() => expect(onSend).toHaveBeenCalled());
		expect(api.attachToTask).toHaveBeenCalledWith('s1', expect.any(File));
		const [message, images] = onSend.mock.calls[0] as unknown as [string, unknown[]];
		expect(message).toBe('Summarize it\n\n<attachment name="spec.pdf" path="uploads/spec.pdf" kind="PDF" size="8">\nInvoices are monthly.\n</attachment>');
		expect(images).toEqual([]);
		expect(screen.queryByText('spec.pdf')).toBeNull();
	});

	it('picks files with the paperclip, and sends one alone', async () => {
		const { container, onSend } = setup();
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		expect(input.getAttribute('accept')).toBeNull();
		api.attachToTask.mockResolvedValueOnce({ name: 'data.csv', path: 'uploads/data.csv', size: 4, kind: 'CSV', text: 'a,b', cut: null });
		await userEvent.upload(input, new File(['a,b'], 'data.csv', { type: 'text/csv' }));
		expect(await screen.findByText('data.csv')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
		await waitFor(() => expect(onSend).toHaveBeenCalled());
		expect((onSend.mock.calls[0] as unknown as [string])[0]).toMatch(/^Look at the attached file\.\n\n<attachment name="data\.csv"/);
	});

	it('pastes text copied from an office app as text, though it brings a picture along', async () => {
		const { box } = setup();
		paste(box, [new File(['png'], 'image.png', { type: 'image/png' })], 'Q1 revenue');
		expect(box.textContent).toBe('Q1 revenue');
		expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
	});

	it('keeps the files and says why when the upload fails', async () => {
		const { box, onSend } = setup();
		paste(box, [new File(['x'], 'notes.docx')]);
		await screen.findByText('notes.docx');
		api.attachToTask.mockRejectedValueOnce(new Error('Files up to 20 MB can be attached.'));
		await userEvent.type(box, 'Read{Enter}');
		await screen.findByText('Not sent: Files up to 20 MB can be attached.');
		expect(screen.getByText('notes.docx')).toBeTruthy();
		expect(box.textContent).toBe('Read');
		expect(onSend).not.toHaveBeenCalled();
	});
});

describe('selected file references', () => {
	it('sends full paths even though the editor shows only filenames', async () => {
		const { box, onSend } = setup();
		await userEvent.type(box, 'Review @serv');
		await screen.findByRole('option', { name: /server.ts/ });
		await userEvent.keyboard('{Tab}');
		expect(screen.getByLabelText('File src/server.ts').textContent).toBe('@server.ts');
		await userEvent.keyboard('{Enter}');
		expect(onSend).toHaveBeenCalledWith('Review @src/server.ts', []);
	});
});
