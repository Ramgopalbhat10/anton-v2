import { json, post } from './http';

/** `clientId` is a client you pasted for a server that lets no app register itself. */
export type McpSignIn = { state: 'signed-in' | 'needed' | 'none'; since: string | null; problem: string | null; clientId: string | null; pastedClient: boolean };
/** Its token is never sent back, only whether it has one. `codeMode: false` keeps run_script's programs from calling it. */
export type McpServer = { name: string; url: string; tools: string[]; hasAuth: boolean; signIn: McpSignIn; codeMode?: boolean; enabled: boolean; addedAt: string };
/** A server as saved: a token left null keeps the stored one, and an empty one removes it. */
export type McpServerInput = { name: string; url: string; tools: string[]; codeMode?: boolean; auth?: string | null };

/** Signed in on your own OAuth client; its secret and tokens never leave the server. */
export type ConnectorAccount = {
	id: string;
	name: string;
	client: { clientId: string; fromEnv: boolean } | null;
	email: string | null;
	connectedAt: string | null;
	scopes: string[];
	problem: string | null;
	callbackPath: string;
};
export type MailboxOptions = { enabled: boolean; draft: boolean; send: boolean };
/** A mailbox on an account (Gmail), on or off for every task (`options.enabled`); `access` is what the agent may do now, null when it is off or not connected. */
export type ConnectorMailbox = {
	id: string;
	name: string;
	account: string;
	options: MailboxOptions;
	canDraft: boolean;
	access: { read: true; draft: boolean; send: boolean } | null;
};
export type ConnectorsView = { accounts: ConnectorAccount[]; mailboxes: ConnectorMailbox[]; mcpServers: McpServer[]; composio: ComposioView };
/** Composio holds its sign-in and runs its tools; Anton keeps only its state. */
export type ComposioAccount = {
	toolkit: string;
	name: string;
	description: string;
	category: string;
	appUrl: string;
	logo: string;
	enabled: boolean;
	status: 'none' | 'pending' | 'active' | 'failed';
	statusReason: string | null;
	connectedAt: string | null;
	addedAt: string;
	account: string | null;
};
export type ComposioView = { configured: boolean; keyFromEnv: boolean; accounts: ComposioAccount[] };
export type ComposioToolkitHit = {
	slug: string;
	name: string;
	description: string;
	logo: string;
	appUrl: string | null;
	categories: string[];
	toolsCount: number;
	noAuth: boolean;
};

export type ComposioAuthField = { name: string; label: string; description: string; required: boolean; secret: boolean; default: string | null };
export type ComposioAuthMethod = { scheme: string; name: string; configFields: ComposioAuthField[]; connectFields: ComposioAuthField[]; hintUrl: string | null };
/** How the app's sign-in will run: Composio's shared app, your own auth config, one Anton makes on Connect, or your credentials are needed first. */
export type ComposioAuthSetup = { state: 'managed' | 'custom' | 'automatic' | 'credentials'; methods: ComposioAuthMethod[]; guideUrl: string | null };

export const connectorsApi = {
	connectors: () => json<ConnectorsView>('/api/connectors'),
	setConnectorClient: (account: string, client: { clientId: string; clientSecret: string | null }) =>
		json<Omit<ConnectorsView, 'mcpServers'>>(`/api/connectors/accounts/${account}/client`, { method: 'PUT', body: JSON.stringify(client) }),
	disconnectAccount: (account: string) => json<Omit<ConnectorsView, 'mcpServers'>>(`/api/connectors/accounts/${account}`, { method: 'DELETE' }),
	connectMailbox: (id: string, access: 'read' | 'draft') => post<{ url: string }>(`/api/connectors/mailboxes/${id}/connect`, { origin: window.location.origin, access }),
	setMailboxOptions: (id: string, options: MailboxOptions) =>
		json<Omit<ConnectorsView, 'mcpServers'>>(`/api/connectors/mailboxes/${id}`, { method: 'PUT', body: JSON.stringify(options) }),
	addMcpServer: (server: McpServerInput) => post<{ mcpServers: McpServer[] }>('/api/mcp-servers', server),
	updateMcpServer: ({ name, ...server }: McpServerInput) =>
		json<{ mcpServers: McpServer[] }>(`/api/mcp-servers/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(server) }),
	setMcpServerEnabled: (name: string, enabled: boolean) =>
		json<{ mcpServers: McpServer[] }>(`/api/mcp-servers/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
	removeMcpServer: (name: string) => json<{ mcpServers: McpServer[] }>(`/api/mcp-servers/${encodeURIComponent(name)}`, { method: 'DELETE' }),
	mcpServerTools: (name: string) => json<{ tools: Array<{ name: string; description?: string }> }>(`/api/mcp-servers/${encodeURIComponent(name)}/tools`),
	/** Starts a server's sign-in: the address to send the browser to, or null when it signed in without one. */
	signInMcpServer: (name: string, client?: { clientId: string; clientSecret: string | null } | null) =>
		post<{ url: string | null; mcpServers: McpServer[] }>(`/api/mcp-servers/${encodeURIComponent(name)}/sign-in`, { origin: window.location.origin, client: client ?? null }),
	signOutMcpServer: (name: string) => json<{ mcpServers: McpServer[] }>(`/api/mcp-servers/${encodeURIComponent(name)}/sign-in`, { method: 'DELETE' }),
	setComposioKey: (key: string | null) => json<ComposioView>('/api/composio/key', { method: 'PUT', body: JSON.stringify({ key }) }),
	addComposioAccount: (toolkit: string) => post<ComposioView>('/api/composio/accounts', { toolkit }),
	composioToolkits: (search: string) => json<{ toolkits: ComposioToolkitHit[] }>(`/api/composio/toolkits?search=${encodeURIComponent(search)}`),
	composioToolkit: (slug: string) => json<ComposioToolkitHit>(`/api/composio/toolkits/${encodeURIComponent(slug)}`),
	composioTools: (toolkit: string) =>
		json<{ tools: Array<{ slug: string; name: string; description: string; inputSchema: Record<string, unknown>; tags: string[]; toolkit: string }> }>(
			`/api/composio/accounts/${encodeURIComponent(toolkit)}/tools`,
		),
	setComposioEnabled: (toolkit: string, enabled: boolean) => json<ComposioView>(`/api/composio/accounts/${encodeURIComponent(toolkit)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
	connectComposio: (toolkit: string) => post<{ url: string }>(`/api/composio/accounts/${encodeURIComponent(toolkit)}/connect`, { callbackUrl: `${window.location.origin}/settings/connectors` }),
	composioAuth: (toolkit: string) => json<ComposioAuthSetup>(`/api/composio/accounts/${encodeURIComponent(toolkit)}/auth`),
	/** The credentials go to Composio; Anton keeps none of them. */
	saveComposioCredentials: (toolkit: string, scheme: string, credentials: Record<string, string>) =>
		post<{ url: string }>(`/api/composio/accounts/${encodeURIComponent(toolkit)}/auth`, { scheme, credentials, callbackUrl: `${window.location.origin}/settings/connectors` }),
	refreshComposio: (toolkit: string) => post<ComposioView>(`/api/composio/accounts/${encodeURIComponent(toolkit)}/refresh`, {}),
	disconnectComposio: (toolkit: string) => post<ComposioView>(`/api/composio/accounts/${encodeURIComponent(toolkit)}/disconnect`, {}),
	removeComposio: (toolkit: string) => json<ComposioView>(`/api/composio/accounts/${encodeURIComponent(toolkit)}`, { method: 'DELETE' }),
};
