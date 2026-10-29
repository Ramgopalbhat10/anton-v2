import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({
	editSession: vi.fn(),
	session: vi.fn(),
	budget: vi.fn(),
	models: vi.fn(),
	modelEndpoints: vi.fn(),
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
	const onSend = vi.fn(async (_text: string, _images: unknown[]) => undefined);
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

	it('routes the task by a provider or a sort from the menus beside the pin, never both', async () => {
		api.modelEndpoints.mockResolvedValue({
			endpoints: [
				{ slug: 'groq', name: 'Groq', price: { input: 1, output: 3 }, contextLength: 128000, latency: 0.2, throughput: 400, uptime: 100 },
				{ slug: 'deepinfra/fp8', name: 'DeepInfra', price: { input: 0.5, output: 1 }, contextLength: 128000, latency: null, throughput: null, uptime: 99 },
			],
		});
		const { client } = setup();
		await userEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }));
		expect(screen.getByRole('button', { name: 'Provider: any' })).toBeTruthy();
		await userEvent.click(screen.getByRole('button', { name: 'Sort providers: default' }));
		await userEvent.click(screen.getByRole('menuitem', { name: /Price/ }));
		await waitFor(() => expect(api.editSession).toHaveBeenCalledWith('s1', { route: { sort: 'price' } }));

		// With a sort, only its icon stays: the provider menu goes, and the picker's button shows the sort.
		await waitFor(() => expect(screen.getByRole('button', { name: 'Sort providers: Price' })).toBeTruthy());
		expect(screen.queryByRole('button', { name: /^Provider:/ })).toBeNull();
		expect(within(screen.getByRole('button', { name: 'Model and reasoning' })).getByTitle('Sorted by price')).toBeTruthy();

		// With a provider, only the provider's mark stays, and its menu says where calls fall back to.
		client.setQueryData(['session', 's1'], session({ route: { provider: 'groq' } }));
		await userEvent.click(await screen.findByRole('button', { name: 'Provider: Groq' }));
		expect(screen.queryByRole('button', { name: /^Sort providers:/ })).toBeNull();
		expect(await screen.findByRole('menuitem', { name: /Groq/ })).toBeTruthy();
		expect(screen.getByText(/If the provider you pick fails, OpenRouter falls back to its default routing/)).toBeTruthy();
		await userEvent.click(screen.getByRole('menuitem', { name: 'Any provider' }));
		await waitFor(() => expect(api.editSession).toHaveBeenCalledWith('s1', { route: null }));
	});

	it('routes another gateway model from its own row, picking that model in the same change', async () => {
		const other = { ...model, id: 'openrouter/test/other', name: 'Other model' };
		renderWithQueries(<Composer sessionId="s1" onSend={vi.fn()} onStop={vi.fn()} />, [
			[['session', 's1'], session()],
			[['models'], { models: [model, other], default: model.id }],
			[['budget', 's1'], { limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null }],
			[['connectors'], CONNECTORS],
		]);
		await userEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }));
		const row = screen.getByRole('option', { name: /Other model/ });
		await userEvent.click(within(row).getByRole('button', { name: 'Sort providers: default' }));
		await userEvent.click(screen.getByRole('menuitem', { name: /Latency/ }));
		await waitFor(() => expect(api.editSession).toHaveBeenCalledWith('s1', { model: 'openrouter/test/other', reasoning: null, route: { sort: 'latency' } }));
		// The providers are asked for only when a provider menu opens.
		expect(api.modelEndpoints).not.toHaveBeenCalled();
	});

	it('offers no routing for a model on a plan', async () => {
		renderWithQueries(<Composer sessionId="s1" onSend={vi.fn()} onStop={vi.fn()} />, [
			[['session', 's1'], session({ model: 'openai/gpt-5.5' })],
			[['models'], { models: [{ ...model, id: 'openai/gpt-5.5', subscription: 'ChatGPT' }], default: model.id }],
			[['budget', 's1'], { limits: { dailyUsd: null, taskUsd: null }, today: 0, task: 0, blocked: null }],
			[['connectors'], CONNECTORS],
		]);
		await userEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }));
		expect(screen.queryByRole('button', { name: /^Provider:|^Sort providers:/ })).toBeNull();
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

	it('retains both task drafts and renames duplicate files before retrying the upload', async () => {
		const { box, onSend } = setup();
		let reject!: (error: Error) => void;
		api.attachToTask.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
		paste(box, [new File(['old bytes'], 'report.pdf', { type: 'application/pdf' })]);
		await screen.findByText('report.pdf');
		await userEvent.type(box, 'Earlier message{Enter}');
		await waitFor(() => expect(api.attachToTask).toHaveBeenCalledTimes(1));
		await userEvent.type(box, 'New message');
		paste(box, [new File(['new bytes'], 'report.pdf', { type: 'application/pdf' })]);
		await screen.findByText('report.pdf');
		reject(new Error('offline'));
		await screen.findByText('Not sent: offline');
		expect(box.textContent).toBe('Earlier message\n\nNew message');
		expect(screen.getByText('report.pdf')).toBeTruthy();
		expect(screen.getByText('report-2.pdf')).toBeTruthy();
		api.attachToTask.mockImplementation(async (_id: string, file: File) => ({ name: file.name, path: `uploads/${file.name}`, size: file.size, kind: 'PDF', text: await file.text(), cut: null }));
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
		await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
		const uploads = api.attachToTask.mock.calls.slice(1).map((call) => call[1] as File);
		expect(uploads.map((file) => file.name)).toEqual(['report.pdf', 'report-2.pdf']);
		expect(await Promise.all(uploads.map((file) => file.text()))).toEqual(['old bytes', 'new bytes']);
		expect(onSend.mock.calls[0][0]).toContain('Earlier message\n\nNew message');
		expect(onSend.mock.calls[0][0]).toContain('uploads/report-2.pdf');
	});

	it('keeps excess restored images visible and blocks sending until the limit is met', async () => {
		const { box, onSend, client } = setup();
		client.setQueryData(['models'], { models: [{ ...model, vision: true }], default: model.id });
		let reject!: (error: Error) => void;
		api.attachToTask.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
		paste(box, [...Array.from({ length: 4 }, (_, i) => new File([String(i)], `picture-${i}.png`, { type: 'image/png' })), new File(['x'], 'pending.pdf', { type: 'application/pdf' })]);
		await screen.findByText('pending.pdf');
		await waitFor(() => expect(screen.getAllByRole('button', { name: /^Remove picture-/ })).toHaveLength(4));
		await userEvent.type(box, 'Check pictures{Enter}');
		await waitFor(() => expect(api.attachToTask).toHaveBeenCalled());
		paste(box, [new File(['new'], 'new-picture.png', { type: 'image/png' })]);
		await screen.findByRole('button', { name: 'Remove new-picture.png' });
		reject(new Error('offline'));
		expect(await screen.findByText('Remove 1 image to send (up to 4 per message).')).toBeTruthy();
		expect(screen.getAllByRole('button', { name: /^Remove .*picture.*png/ })).toHaveLength(5);
		expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
		paste(box, [new File(['more'], 'extra.png', { type: 'image/png' })]);
		await waitFor(() => expect(screen.getAllByRole('button', { name: /^Remove .*picture.*png/ })).toHaveLength(5));
		await userEvent.click(screen.getByRole('button', { name: 'Remove new-picture.png' }));
		expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(false);
		api.attachToTask.mockResolvedValueOnce({ name: 'pending.pdf', path: 'uploads/pending.pdf', size: 1, kind: 'PDF', text: null, cut: null });
		await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
		await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
		expect(onSend.mock.calls[0][1]).toHaveLength(4);
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

	it('keeps a long draft to a few lines, with a chevron to open it out and fold it back', async () => {
		// No layout here: a draft's height is its length, a line a line.
		const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
			return this.classList.contains('sg-draft') ? Math.max(1, (this.textContent ?? '').split('\n').length) * 22 : 0;
		});
		const { box } = setup();
		expect(screen.queryByRole('button', { name: 'Show the whole message' })).toBeNull();
		box.textContent = Array.from({ length: 12 }, (_, line) => `Line ${line + 1}`).join('\n');
		fireEvent.input(box);
		const open = await screen.findByRole('button', { name: 'Show the whole message' });
		expect(box.style.maxHeight).toBe('110px');
		fireEvent.click(open);
		expect(screen.getByRole('button', { name: 'Fold the message back' }).getAttribute('aria-expanded')).toBe('true');
		expect(box.style.maxHeight).toBe(`${Math.min(12 * 22, Math.round(window.innerHeight * 0.6))}px`);
		expect(box.style.transition).toContain('max-height');
		// Cut back to a few lines, it folds, and the chevron goes.
		box.textContent = 'Short';
		fireEvent.input(box);
		await waitFor(() => expect(screen.queryByRole('button', { name: /whole message|Fold the message/ })).toBeNull());
		expect(box.style.maxHeight).toBe('110px');
		height.mockRestore();
	});
});
