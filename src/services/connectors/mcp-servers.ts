import { announce } from '../../core/changes.ts';
import { ConflictError, InvalidInputError, NotFoundError } from '../../core/errors.ts';
import type { InstalledMcpServer, McpServer } from '../../core/types.ts';
import { deleteMcpServer, getMcpServer, insertMcpServer, listMcpServers, setMcpServerEnabled, updateMcpServerRow } from '../../db/mcp-servers.ts';
import { logProblem } from '../../core/log.ts';
import { forgetMcpSignIn, mcpAccessToken, McpSignInNeeded, type McpSignInView, signInView } from './mcp-sign-in.ts';
import { type McpTool, serverTools } from './mcp-tools.ts';

// A server's token and custom header values stay here and in the agent's connections, never in a view.

const MAX_SERVERS = 30;

/** Never a token or custom header values. */
export type McpServerView = Omit<InstalledMcpServer, 'auth' | 'headers'> & { hasAuth: boolean; headerNames: string[]; signIn: McpSignInView };

const present = async ({ auth, headers, ...server }: InstalledMcpServer): Promise<McpServerView> => ({
	...server,
	hasAuth: Boolean(auth),
	headerNames: Object.keys(headers ?? {}).sort((a, b) => a.localeCompare(b)),
	signIn: await signInView(server.name),
});

/** A token left out (or null) keeps the stored one, and an empty one removes it. In `headers`, null keeps a stored value and omitting a key removes it. */
export type McpServerInput = Omit<McpServer, 'auth' | 'headers'> & { auth?: string | null; headers?: Record<string, string | null> };

export async function mcpServersView(): Promise<McpServerView[]> {
	return Promise.all((await listMcpServers()).map(present));
}

const hasCustomAuthHeader = (headers?: Record<string, string>) =>
	Boolean(headers && Object.keys(headers).some((name) => name.toLowerCase() === 'authorization'));

/** A custom Authorization header wins over OAuth; otherwise a signed-in server's token, renewed if it must be, stands in for a pasted one. */
async function connectable({ enabled: _, addedAt: __, ...server }: InstalledMcpServer): Promise<McpServer> {
	if (hasCustomAuthHeader(server.headers)) return server;
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

function mergeHeaders(stored: Record<string, string>, change: Record<string, string | null> | undefined, sameHost: boolean): Record<string, string> {
	if (change === undefined) return sameHost ? stored : {};
	const storedByLower = new Map(Object.entries(stored).map(([k, v]) => [k.toLowerCase(), v]));
	const seen = new Set<string>();
	const next: Record<string, string> = {};
	for (const [rawKey, value] of Object.entries(change)) {
		const key = rawKey.trim();
		if (!key) continue;
		const lower = key.toLowerCase();
		if (seen.has(lower)) throw new InvalidInputError(`Header ${key} is listed more than once.`);
		seen.add(lower);
		const resolved = value === null ? (sameHost ? storedByLower.get(lower) : undefined) : value;
		if (resolved !== undefined) next[key] = resolved;
	}
	return next;
}

export async function addMcpServer(input: McpServerInput): Promise<McpServerView[]> {
	const headers = mergeHeaders({}, input.headers, false);
	await insertMcpServer({ name: input.name, url: input.url, tools: input.tools, codeMode: input.codeMode, auth: input.auth || null, headers }, MAX_SERVERS);
	announce({ kind: 'connectors' });
	return mcpServersView();
}

/** Its token and custom headers stay only with the host they were given for, so pointing it at a new host never sends them there. */
export async function updateMcpServer(name: string, input: Omit<McpServerInput, 'name'>): Promise<McpServerView[]> {
	const current = await existing(name);
	const sameHost = originOf(current.url) === originOf(input.url);
	const auth = input.auth === '' ? null : (input.auth ?? (sameHost ? current.auth : null));
	const headers = mergeHeaders(current.headers ?? {}, input.headers, sameHost);
	const updated = await updateMcpServerRow({ name, url: input.url, tools: input.tools, codeMode: input.codeMode, auth, headers }, current.addedAt);
	if (!updated) {
		if (await getMcpServer(name)) throw new ConflictError(`MCP server ${name} was replaced while editing`);
		throw new NotFoundError(`No MCP server is named ${name}`);
	}
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
