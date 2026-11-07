import type { QueryClient } from '@tanstack/react-query';
import { api, type ComposioAccount, type ConnectorAccount, type ConnectorMailbox, type ConnectorsView, type McpServer } from '@/lib/api';

/**
 * Connectors as the composer's + menu and Settings › Connectors list them: each mailbox whose account is
 * connected, each MCP server added, and each app connected through Composio, with one on/off state for
 * every task. The agent loads a connector's tools only when it uses them, so turning one on costs nothing
 * until then and never changes the cached prompt.
 */

export type ConnectorState = 'on' | 'off' | 'needs-sign-in';

export type ConnectorItem =
	| { key: string; kind: 'mailbox'; name: string; state: ConnectorState; mailbox: ConnectorMailbox; account: ConnectorAccount }
	| { key: string; kind: 'mcp'; name: string; state: ConnectorState; server: McpServer }
	| { key: string; kind: 'composio'; name: string; state: ConnectorState; account: ComposioAccount };

export const connectorKey = { mailbox: (id: string) => `mail:${id}`, mcp: (name: string) => `mcp:${name}`, composio: (toolkit: string) => `composio:${toolkit}` };

export function connectorItems(view: ConnectorsView | undefined): ConnectorItem[] {
	if (!view) return [];
	const mailboxes = view.mailboxes.flatMap((mailbox): ConnectorItem[] => {
		const account = view.accounts.find((item) => item.id === mailbox.account);
		if (!account?.connectedAt) return [];
		const state: ConnectorState = !mailbox.options.enabled ? 'off' : account.problem ? 'needs-sign-in' : 'on';
		return [{ key: connectorKey.mailbox(mailbox.id), kind: 'mailbox', name: mailbox.name, state, mailbox, account }];
	});
	const servers = view.mcpServers.map(
		(server): ConnectorItem => ({
			key: connectorKey.mcp(server.name),
			kind: 'mcp',
			name: server.name,
			state: !server.enabled ? 'off' : server.signIn.state === 'needed' ? 'needs-sign-in' : 'on',
			server,
		}),
	);
	const composio = view.composio.accounts.map((account): ConnectorItem => {
		const state: ConnectorState = !account.enabled ? 'off' : !view.composio.configured || account.status !== 'active' ? 'needs-sign-in' : 'on';
		return { key: connectorKey.composio(account.toolkit), kind: 'composio', name: account.name, state, account };
	});
	return [...mailboxes, ...servers, ...composio];
}

/** Turns a connector on or off for every task, shown at once and replaced by the server's answer. */
export async function setConnectorOn(queryClient: QueryClient, item: ConnectorItem, on: boolean): Promise<void> {
	const patch = (view: ConnectorsView): ConnectorsView =>
		item.kind === 'mailbox'
			? { ...view, mailboxes: view.mailboxes.map((mailbox) => (mailbox.id === item.mailbox.id ? { ...mailbox, options: { ...mailbox.options, enabled: on } } : mailbox)) }
			: item.kind === 'composio'
				? { ...view, composio: { ...view.composio, accounts: view.composio.accounts.map((account) => (account.toolkit === item.account.toolkit ? { ...account, enabled: on } : account)) } }
				: { ...view, mcpServers: view.mcpServers.map((server) => (server.name === item.server.name ? { ...server, enabled: on } : server)) };
	queryClient.setQueryData<ConnectorsView>(['connectors'], (current) => (current ? patch(current) : current));
	try {
		if (item.kind === 'mailbox') {
			const next = await api.setMailboxOptions(item.mailbox.id, { ...item.mailbox.options, enabled: on });
			queryClient.setQueryData<ConnectorsView>(['connectors'], (current) => (current ? { ...current, ...next } : current));
		} else if (item.kind === 'composio') {
			const composio = await api.setComposioEnabled(item.account.toolkit, on);
			queryClient.setQueryData<ConnectorsView>(['connectors'], (current) => (current ? { ...current, composio } : current));
		} else {
			const next = await api.setMcpServerEnabled(item.server.name, on);
			queryClient.setQueryData<ConnectorsView>(['connectors'], (current) => (current ? { ...current, ...next } : current));
		}
	} catch (error) {
		await queryClient.invalidateQueries({ queryKey: ['connectors'] });
		throw error;
	}
}
