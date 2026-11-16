import { announce } from '../../core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../../core/errors.ts';
import type { InstalledMcpServer, McpServer } from '../../core/types.ts';
import { deleteMcpServer, getMcpServer, listMcpServers, saveMcpServer, setMcpServerEnabled } from '../../db/mcp-servers.ts';
import { logProblem } from '../../core/log.ts';
import { forgetMcpSignIn, mcpAccessToken, McpSignInNeeded, type McpSignInView, signInView } from './mcp-sign-in.ts';
import { type McpTool, serverTools } from './mcp-tools.ts';

// A server's token stays here and in the agent's connections, never in a view.

const MAX_SERVERS = 30;

/** Never a token. */
export type McpServerView = Omit<InstalledMcpServer, 'auth'> & { hasAuth: boolean; signIn: McpSignInView };

const present = async ({ auth, ...server }: InstalledMcpServer): Promise<McpServerView> => ({ ...server, hasAuth: Boolean(auth), signIn: await signInView(server.name) });

/** A token left out (or null) keeps the stored one, and an empty one removes it. */
export type McpServerInput = Omit<McpServer, 'auth'> & { auth?: string | null };

export async function mcpServersView(): Promise<McpServerView[]> {
	return Promise.all((await listMcpServers()).map(present));
}

/** A signed-in server's token, renewed if it must be, in place of a pasted one. */
async function connectable({ enabled: _, addedAt: __, ...server }: InstalledMcpServer): Promise<McpServer> {
	const token = await mcpAccessToken(server.name, server.url);
	return token ? { ...server, auth: token } : server;
}

export type McpServerState = { name: string; url: string; codeMode: boolean; state: 'on' | 'off' | 'needs-sign-in'; server: McpServer | null; problem: string | null };

/** Read now, so a server turned on or off in the composer counts from its next call. */
export async function mcpServerStates(): Promise<McpServerState[]> {
	return Promise.all(
		(await listMcpServers()).map(async (installed): Promise<McpServerState> => {
			const base = { name: installed.name, url: installed.url, codeMode: installed.codeMode !== false };
			if (!installed.enabled) return { ...base, state: 'off', server: null, problem: null };
			try {
				return { ...base, state: 'on', server: await connectable(installed), problem: null };
			} catch (error) {
				if (!(error instanceof McpSignInNeeded)) logProblem('warn', `MCP server ${installed.name} was left out`, error);
				return { ...base, state: 'needs-sign-in', server: null, problem: error instanceof Error ? error.message : String(error) };
			}
		}),
	);
}

export async function enabledMcpServers(): Promise<McpServer[]> {
	return (await mcpServerStates()).flatMap((entry) => (entry.server ? [entry.server] : []));
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

/** Its token stays only with the host it was given for, so pointing it at a new host never sends it there. */
export async function updateMcpServer(name: string, input: Omit<McpServerInput, 'name'>): Promise<McpServerView[]> {
	const current = await existing(name);
	const sameHost = originOf(current.url) === originOf(input.url);
	const auth = input.auth === '' ? null : (input.auth ?? (sameHost ? current.auth : null));
	await saveMcpServer({ name, url: input.url, tools: input.tools, codeMode: input.codeMode, auth });
	// A sign-in is for the server it was made with; another address signs in afresh.
	if (current.url !== input.url) await forgetMcpSignIn(name);
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

export async function mcpServerTools(name: string): Promise<Array<Pick<McpTool, 'name' | 'description'>>> {
	const server = await connectable(await existing(name));
	return (await serverTools(server)).map((tool) => ({ name: tool.name, description: tool.description }));
}
