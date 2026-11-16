import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '../../core/types.ts';

/*
 * Connections to MCP servers kept between programs, and tool lists kept so run_script can be described while the agent
 * renders (synchronously). Shared by tasks using the same server and token; idle connections close after a few minutes.
 */

const CONNECT_MS = 15_000;
const IDLE_MS = 5 * 60_000;
const LIST_MS = 10 * 60_000;
const FAILED_MS = 60_000;

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> };
export type McpContent =
	| { type: 'text'; text: string }
	| { type: 'image' | 'audio'; mimeType: string; data: string }
	| { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string } }
	| { type: 'resource_link'; uri: string; name: string }
	| { type: string; [key: string]: unknown };
export type McpCallResult = { content?: McpContent[]; structuredContent?: unknown; isError?: boolean };

type Listing = { at: number; tools: Promise<McpTool[]>; settled: McpTool[] | null };
type Connection = { client: Promise<Client>; idle: ReturnType<typeof setTimeout> | null };

const connections = new Map<string, Connection>();
const listings = new Map<string, Listing>();

/** The token never leaves this module's memory. */
const connectionKey = (server: McpServer) => `${server.url}\n${server.auth ?? ''}`;
/** A listing also depends on the tools the repo allows. */
const listingKey = (server: McpServer) => `${connectionKey(server)}\n${server.tools.join(',')}`;

function release(key: string, entry: Connection) {
	if (entry.idle) clearTimeout(entry.idle);
	entry.idle = setTimeout(() => {
		if (connections.get(key) !== entry) return;
		connections.delete(key);
		void entry.client.then((client) => client.close()).catch(() => undefined);
	}, IDLE_MS);
	entry.idle.unref?.();
}

function drop(key: string, entry: Connection) {
	if (connections.get(key) !== entry) return;
	connections.delete(key);
	if (entry.idle) clearTimeout(entry.idle);
	void entry.client.then((client) => client.close()).catch(() => undefined);
}

async function withClient<T>(server: McpServer, use: (client: Client) => Promise<T>): Promise<T> {
	const key = connectionKey(server);
	let entry = connections.get(key);
	if (!entry) {
		const client = (async () => {
			const next = new Client({ name: 'anton', version: '1' });
			const headers = server.auth ? { Authorization: `Bearer ${server.auth}` } : undefined;
			await next.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }), { signal: AbortSignal.timeout(CONNECT_MS) });
			return next;
		})();
		entry = { client, idle: null };
		connections.set(key, entry);
	}
	const current = entry;
	if (current.idle) clearTimeout(current.idle);
	current.idle = null;
	try {
		return await use(await current.client);
	} catch (error) {
		// A connection that failed, or a call that did, starts afresh next time; a call the script left behind does not.
		if (!(error instanceof Error && error.name === 'AbortError')) drop(key, current);
		throw error;
	} finally {
		if (connections.get(key) === current) release(key, current);
	}
}

export function serverTools(server: McpServer): Promise<McpTool[]> {
	const key = listingKey(server);
	const known = listings.get(key);
	if (known && Date.now() - known.at < (known.settled?.length === 0 ? FAILED_MS : LIST_MS)) return known.tools;
	const listing: Listing = { at: Date.now(), tools: Promise.resolve([]), settled: known?.settled ?? null };
	listing.tools = withClient(server, (client) => client.listTools(undefined, { signal: AbortSignal.timeout(CONNECT_MS) }))
		.then(({ tools }) => tools.filter((tool) => server.tools.length === 0 || server.tools.includes(tool.name)) as McpTool[])
		.then(
			(tools) => {
				listing.settled = tools;
				return tools;
			},
			(error: unknown) => {
				// A list read before stays (its tools fail when called), so the agent's prompt does not change under it;
				// a server never read offers nothing until it is tried again after FAILED_MS.
				listing.settled = known?.settled ?? [];
				throw error;
			},
		);
	listings.set(key, listing);
	return listing.tools;
}

export function knownServerTools(server: McpServer): McpTool[] | null {
	return listings.get(listingKey(server))?.settled ?? null;
}

/** Only a server never read is waited for: one read before keeps its list for this message. */
export async function warmServerTools(servers: McpServer[], waitMs: number): Promise<void> {
	const unread = servers.flatMap((server) => {
		const tools = serverTools(server).catch(() => []);
		return knownServerTools(server) === null ? [tools] : [];
	});
	if (!unread.length) return;
	const all = Promise.allSettled(unread);
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
	clearTimeout(timer);
}

export function callServerTool(server: McpServer, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
	return withClient(server, async (client) => (await client.callTool({ name, arguments: args }, { signal })) as McpCallResult);
}

export async function resetMcpToolsForTests(): Promise<void> {
	const open = [...connections.values()];
	connections.clear();
	listings.clear();
	await Promise.allSettled(open.map(async (entry) => (entry.idle ? clearTimeout(entry.idle) : undefined, (await entry.client).close())));
}
