import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorsView, MailApproval } from '@/lib/api';
import { renderWithQueries } from './render';

const { api } = vi.hoisted(() => ({
	api: {
		connectors: vi.fn(),
		setConnectorClient: vi.fn(),
		connectMailbox: vi.fn(),
		setMailboxOptions: vi.fn(),
		disconnectAccount: vi.fn(),
		addMcpServer: vi.fn(),
		updateMcpServer: vi.fn(),
		setMcpServerEnabled: vi.fn(),
		removeMcpServer: vi.fn(),
		mcpServerTools: vi.fn(),
		signInMcpServer: vi.fn(),
		signOutMcpServer: vi.fn(),
		mailApprovals: vi.fn(),
		decideMail: vi.fn(),
	},
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { ConnectorsPage } = await import('@/components/settings/connectors');
const { MailSendCard } = await import('@/components/mail-card');
const { ReplyActions } = await import('@/components/reply-cards');
const { GOOGLE, MCP, serverMark } = await import('@/components/brand-marks');
const brands = await import('@/lib/brand-icons');

const google = (patch: Partial<ConnectorsView['accounts'][number]> = {}): ConnectorsView['accounts'][number] => ({
	id: 'google',
	name: 'Google',
	client: null,
	email: null,
	connectedAt: null,
	scopes: [],
	problem: null,
	callbackPath: '/api/connectors/google/callback',
	...patch,
});
const gmail = (patch: Partial<ConnectorsView['mailboxes'][number]> = {}): ConnectorsView['mailboxes'][number] => ({
	id: 'gmail',
	name: 'Gmail',
	account: 'google',
	options: { enabled: true, draft: true, send: true },
	canDraft: false,
	access: null,
	...patch,
});
const NO_SIGN_IN = { state: 'none', since: null, problem: null, clientId: null, pastedClient: false } as const;
const tracker = { name: 'tracker', url: 'https://tracker.example.test/mcp', tools: [], hasAuth: true, signIn: NO_SIGN_IN, enabled: true, addedAt: '2026-10-17T00:00:00Z' };
const linear = { ...tracker, name: 'linear', url: 'https://mcp.linear.app/mcp', hasAuth: false };

function open(view: ConnectorsView) {
	api.connectors.mockResolvedValue(view);
	const root = createRootRoute({ component: Outlet });
	const page = createRoute({ getParentRoute: () => root, path: '/settings/connectors', component: ConnectorsPage });
	const router = createRouter({ routeTree: root.addChildren([page]), history: createMemoryHistory({ initialEntries: ['/settings/connectors'] }) });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	for (const mock of Object.values(api)) mock.mockReset();
	document.body.innerHTML = '';
});

describe('Settings › Connectors', () => {
	it('walks through the one-time Google client, with the redirect address to paste', async () => {
		api.setConnectorClient.mockResolvedValue({ accounts: [google({ client: { clientId: 'id-1', fromEnv: false } })], mailboxes: [gmail()] });
		open({ accounts: [google()], mailboxes: [gmail()], mcpServers: [] });
		expect(await screen.findByText('Set up the consent screen, then publish it')).toBeTruthy();
		expect(screen.getByDisplayValue(`${window.location.origin}/api/connectors/google/callback`)).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Client id'), { target: { value: 'id-1' } });
		fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret-1' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save client' }));
		await waitFor(() => expect(api.setConnectorClient).toHaveBeenCalledWith('google', { clientId: 'id-1', clientSecret: 'secret-1' }));
		expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeTruthy();
	});

	it('connects with the access picked, by going to Google', async () => {
		api.connectMailbox.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
		const assign = vi.fn();
		vi.stubGlobal('location', { ...window.location, assign, origin: window.location.origin });
		open({ accounts: [google({ client: { clientId: 'id-1.apps.googleusercontent.com', fromEnv: true } })], mailboxes: [gmail()], mcpServers: [] });
		fireEvent.click(await screen.findByRole('radio', { name: /Read only/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }));
		await waitFor(() => expect(api.connectMailbox).toHaveBeenCalledWith('gmail', 'read'));
		await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
		vi.unstubAllGlobals();
	});

	it('shows the signed-in account, and turns sending off', async () => {
		const connected = google({ client: { clientId: 'id-1', fromEnv: false }, email: 'me@example.com', connectedAt: '2026-10-17T08:00:00Z' });
		const on = gmail({ canDraft: true, access: { read: true, draft: true, send: true } });
		api.setMailboxOptions.mockResolvedValue({ accounts: [connected], mailboxes: [{ ...on, options: { ...on.options, send: false } }] });
		open({ accounts: [connected], mailboxes: [on], mcpServers: [] });
		expect(await screen.findByText('me@example.com')).toBeTruthy();
		expect(screen.getByText('Connected')).toBeTruthy();
		fireEvent.click(screen.getByRole('switch', { name: 'Send after you press Send' }));
		await waitFor(() => expect(api.setMailboxOptions).toHaveBeenCalledWith('gmail', { enabled: true, draft: true, send: false }));
	});

	it('says when Google no longer accepts the sign-in, with a way back', async () => {
		const failing = google({ client: { clientId: 'id-1', fromEnv: false }, email: 'me@example.com', connectedAt: '2026-10-17T08:00:00Z', problem: 'Google no longer accepts Anton’s sign-in.' });
		open({ accounts: [failing], mailboxes: [gmail({ canDraft: true, access: { read: true, draft: true, send: true } })], mcpServers: [] });
		expect(await screen.findByText('Needs sign-in')).toBeTruthy();
		expect(screen.getByText('Google no longer accepts Anton’s sign-in.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Connect again' })).toBeTruthy();
	});

	it('lists MCP servers for every task, turns one off, and adds one', async () => {
		api.setMcpServerEnabled.mockResolvedValue({ mcpServers: [{ ...tracker, enabled: false }] });
		api.addMcpServer.mockResolvedValue({ mcpServers: [tracker, { ...tracker, name: 'docs', hasAuth: false }] });
		open({ accounts: [], mailboxes: [], mcpServers: [tracker] });
		expect(await screen.findByText('tracker')).toBeTruthy();
		expect(screen.getByText('token · all tools · through code mode')).toBeTruthy();
		fireEvent.click(screen.getByRole('switch', { name: 'Use tracker' }));
		await waitFor(() => expect(api.setMcpServerEnabled).toHaveBeenCalledWith('tracker', false));

		fireEvent.click(screen.getByRole('button', { name: 'Add a server' }));
		fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'docs' } });
		fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://docs.example.test/mcp' } });
		fireEvent.change(screen.getByLabelText('Tools'), { target: { value: 'search, fetch' } });
		fireEvent.click(screen.getByRole('switch', { name: 'Through code mode' }));
		fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
		await waitFor(() =>
			expect(api.addMcpServer).toHaveBeenCalledWith({ name: 'docs', url: 'https://docs.example.test/mcp', auth: '', tools: ['search', 'fetch'], codeMode: false }),
		);
	});

	it('draws each server as the product its address belongs to, else as an MCP server', async () => {
		open({ accounts: [], mailboxes: [], mcpServers: [linear, tracker] });
		expect(await screen.findByRole('img', { name: 'Linear' })).toBeTruthy();
		expect(screen.getByRole('img', { name: 'MCP server' })).toBeTruthy();
	});
});

describe('Signing in to an MCP server', () => {
	it("sends you to the server's sign-in from its row", async () => {
		api.signInMcpServer.mockResolvedValue({ url: 'https://linear.app/oauth/authorize?x=1', mcpServers: [linear] });
		const assign = vi.fn();
		vi.stubGlobal('location', { ...window.location, assign, origin: window.location.origin });
		open({ accounts: [], mailboxes: [], mcpServers: [linear] });
		fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
		await waitFor(() => expect(api.signInMcpServer).toHaveBeenCalledWith('linear', undefined));
		await waitFor(() => expect(assign).toHaveBeenCalledWith('https://linear.app/oauth/authorize?x=1'));
		vi.unstubAllGlobals();
	});

	it('says when a sign-in needs you again, and shows a signed-in one as such', async () => {
		const refused = { ...linear, signIn: { ...NO_SIGN_IN, state: 'needed' as const, problem: 'The server no longer accepts the sign-in. Sign in again.' } };
		const notion = { ...linear, name: 'notion', url: 'https://mcp.notion.com/mcp', signIn: { ...NO_SIGN_IN, state: 'signed-in' as const, since: '2026-10-17T08:00:00Z' } };
		open({ accounts: [], mailboxes: [], mcpServers: [refused, notion] });
		expect(await screen.findByText('The server no longer accepts the sign-in. Sign in again.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
		expect(screen.getByText('signed in · all tools · through code mode')).toBeTruthy();
	});

	it('takes an OAuth app of your own for a server that lets no app register itself', async () => {
		api.signInMcpServer.mockRejectedValueOnce(new Error("This server doesn't let apps register themselves. Create an OAuth app in the service's settings with the redirect URI shown here, then paste its client id."));
		api.signInMcpServer.mockResolvedValueOnce({ url: null, mcpServers: [linear] });
		open({ accounts: [], mailboxes: [], mcpServers: [linear] });
		fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
		expect(await screen.findByDisplayValue(`${window.location.origin}/api/mcp-servers/callback`)).toBeTruthy();
		fireEvent.change(screen.getByLabelText('OAuth client id'), { target: { value: 'my-app' } });
		fireEvent.click(screen.getByRole('button', { name: 'Sign in with this app' }));
		await waitFor(() => expect(api.signInMcpServer).toHaveBeenLastCalledWith('linear', { clientId: 'my-app', clientSecret: null }));
	});

	it('fills in a popular server with a click', async () => {
		open({ accounts: [], mailboxes: [], mcpServers: [] });
		fireEvent.click(await screen.findByRole('button', { name: 'Add a server' }));
		fireEvent.click(await screen.findByRole('button', { name: /Notion/ }));
		expect((screen.getByLabelText('Server name') as HTMLInputElement).value).toBe('notion');
		expect((screen.getByLabelText('Server URL') as HTMLInputElement).value).toBe('https://mcp.notion.com/mcp');
	});
});

describe('Product marks', () => {
	it('match a server by its domain or any subdomain of it, and nothing else', () => {
		expect(serverMark('https://mcp.notion.com/mcp', brands).title).toBe('Notion');
		expect(serverMark('https://api.githubcopilot.com/mcp/', brands).title).toBe('GitHub');
		expect(serverMark('https://bindings.mcp.cloudflare.com/sse', brands).title).toBe('Cloudflare');
		expect(serverMark('https://gmail.googleapis.com/mcp', brands)).toBe(GOOGLE);
		expect(serverMark('https://notlinear.app/mcp', brands)).toBe(MCP);
		expect(serverMark('https://linear.app.evil.test/mcp', brands)).toBe(MCP);
		expect(serverMark('not a url', brands)).toBe(MCP);
		expect(serverMark('https://mcp.linear.app/mcp', undefined)).toBe(MCP);
	});

	it('keep every mark a product of its own, with a colour and a path', () => {
		for (const [domain, id] of Object.entries(brands.BRAND_DOMAINS)) {
			if (id === 'google') continue;
			const brand = brands.BRANDS[id];
			expect(brand, domain).toBeTruthy();
			expect(brand.hex).toMatch(/^#[0-9A-F]{6}$/i);
			expect(brand.path.length).toBeGreaterThan(10);
		}
	});
});

describe('An email the agent asks to send', () => {
	const approval: MailApproval = {
		id: 'mail_1',
		connector: 'gmail',
		draftId: 'd1',
		to: ['Ada <ada@example.com>'],
		cc: [],
		bcc: [],
		subject: 'Re: Invoice',
		body: 'Attached.\nThanks',
		state: 'pending',
		decidedAt: null,
	};

	it('shows the email as it will go, and sends it only on Send, telling the agent', async () => {
		api.mailApprovals.mockResolvedValue({ approvals: [approval] });
		const sent: MailApproval = { ...approval, state: 'sent', decidedAt: '2026-10-17T10:42:00Z' };
		api.decideMail.mockImplementation(async () => {
			api.mailApprovals.mockResolvedValue({ approvals: [sent] });
			return sent;
		});
		const reply = vi.fn();
		renderWithQueries(
			<ReplyActions.Provider value={{ send: reply, busy: false }}>
				<MailSendCard sessionId="s1" approvalId="mail_1" place={{ latest: true, answer: null }} />
			</ReplyActions.Provider>,
		);
		const card = await screen.findByRole('region', { name: 'Email to send' });
		expect(within(card).getByText('Re: Invoice')).toBeTruthy();
		expect(within(card).getByText('Ada <ada@example.com>')).toBeTruthy();
		expect(api.decideMail).not.toHaveBeenCalled();
		fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
		await waitFor(() => expect(api.decideMail).toHaveBeenCalledWith('s1', 'mail_1', true));
		await waitFor(() => expect(reply).toHaveBeenCalledWith('I sent the email "Re: Invoice".'));
		expect(await within(card).findByText(/Sent/)).toBeTruthy();
	});

	it("says it was not sent after Don't send", async () => {
		api.mailApprovals.mockResolvedValue({ approvals: [{ ...approval, state: 'declined' }] });
		renderWithQueries(<MailSendCard sessionId="s1" approvalId="mail_1" place={{ latest: false, answer: "Don't send" }} />);
		expect(await screen.findByText('Not sent')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
	});
});
