import { announce } from '../core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.ts';
import type { InstalledMcpServer, McpServer } from '../core/types.ts';
import { deleteMcpServer, getMcpServer, listMcpServers, saveMcpServer, setMcpServerEnabled } from '../db/mcp-servers.ts';
import { type McpTool, serverTools } from './mcp-tools.ts';

/**
 * MCP servers added once in Settings › Connectors, for every task and thread,
 * as skills are: each can be turned off without removing it. Tokens stay
 * here and in the agent's connections, never in a view.
 */

const MAX_SERVERS = 30;

/** An MCP server as the browser sees it: whether it has a token, never the token. */
export type McpServerView = Omit<InstalledMcpServer, 'auth'> & { hasAuth: boolean };

const present = ({ auth, ...server }: InstalledMcpServer): McpServerView => ({ ...server, hasAuth: Boolean(auth) });

/** What the browser sends: a token left out (or null) keeps the stored one, and an empty one removes it. */
export type McpServerInput = Omit<McpServer, 'auth'> & { auth?: string | null };

export async function mcpServersView(): Promise<McpServerView[]> {
	return (await listMcpServers()).map(present);
}

/** The servers every task's agent connects to now: the ones that are on. */
export async function enabledMcpServers(): Promise<McpServer[]> {
	return (await listMcpServers()).filter((server) => server.enabled).map(({ enabled: _, addedAt: __, ...server }) => server);
}

async function existing(name: string): Promise<InstalledMcpServer> {
	const server = await getMcpServer(name);
	if (!server) throw new NotFoundError(`No MCP server is named ${name}`);
	return server;
}

const originOf = (url: string) => (URL.canParse(url) ? new URL(url).origin : url);

export async function addMcpServer(input: McpServerInput): Promise<McpServerView[]> {
	if (await getMcpServer(input.name)) throw new ConflictError(`An MCP server is already named ${input.name}`);
	if ((await listMcpServers()).length >= MAX_SERVERS) throw new InvalidInputError(`Anton keeps up to ${MAX_SERVERS} MCP servers`);
	await saveMcpServer({ name: input.name, url: input.url, tools: input.tools, codeMode: input.codeMode, auth: input.auth || null });
	announce({ kind: 'connectors' });
	return mcpServersView();
}

/** Changes a server; its token stays only with the host it was given for, so pointing it at a new host never sends it there. */
export async function updateMcpServer(name: string, input: Omit<McpServerInput, 'name'>): Promise<McpServerView[]> {
	const current = await existing(name);
	const kept = originOf(current.url) === originOf(input.url) ? current.auth : null;
	const auth = input.auth === '' ? null : (input.auth ?? kept);
	await saveMcpServer({ name, url: input.url, tools: input.tools, codeMode: input.codeMode, auth });
	announce({ kind: 'connectors' });
	return mcpServersView();
}

export async function toggleMcpServer(name: string, enabled: boolean): Promise<McpServerView[]> {
	await existing(name);
	await setMcpServerEnabled(name, enabled);
	announce({ kind: 'connectors' });
	return mcpServersView();
}

export async function removeMcpServer(name: string): Promise<McpServerView[]> {
	await existing(name);
	await deleteMcpServer(name);
	announce({ kind: 'connectors' });
	return mcpServersView();
}

/** The server's tools as the agent would see them, read now: a check that its address and token work. */
export async function mcpServerTools(name: string): Promise<Array<Pick<McpTool, 'name' | 'description'>>> {
	const { enabled: _, addedAt: __, ...server } = await existing(name);
	return (await serverTools(server)).map((tool) => ({ name: tool.name, description: tool.description }));
}
