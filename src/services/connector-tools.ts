import * as v from 'valibot';
import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { redactor } from '../core/redact.ts';
import type { McpServer } from '../core/types.ts';
import { listMcpServers } from '../db/mcp-servers.ts';
import { connectorsView } from './connectors.ts';
import { MAX_SEARCH, type MailApprovalView, readMailThread, requestSend, searchMail, writeDraft } from './mail.ts';
import { mcpServerStates } from './mcp-servers.ts';
import { callServerTool, type McpCallResult, type McpTool, serverTools } from './mcp-tools.ts';
import { logProblem } from './log.ts';
import { secretsToHide } from './secrets.ts';

/**
 * Connectors' tools for the agent, loaded on demand. The agent always has the
 * same two tools, `connector_tools` (what the connectors that are on offer,
 * with each tool's arguments) and `connector_call` (call one), whatever is on,
 * so turning a connector on or off in the composer changes neither the tool
 * list nor the instructions, and the provider's prompt cache holds. A
 * connector costs the conversation context only once the agent looks it up.
 * Both read the connectors' state as they run: one turned on mid-task is
 * there from the agent's next call, one turned off refuses.
 */

/** A connector set up in Settings › Connectors: a connected mailbox, or an added MCP server. */
export type SetUpConnector = { id: string; name: string; kind: 'mailbox' | 'mcp'; codeMode: boolean };

/** The connectors set up now, on or off; what the agent's instructions name, so they change only when one is added or removed. */
export async function setUpConnectors(): Promise<SetUpConnector[]> {
	const [view, servers] = await Promise.all([connectorsView(), listMcpServers()]);
	const connected = new Set(view.accounts.filter((account) => account.connectedAt).map((account) => account.id));
	return [
		...view.mailboxes.filter((mailbox) => connected.has(mailbox.account)).map((mailbox) => ({ id: mailbox.id, name: mailbox.name, kind: 'mailbox' as const, codeMode: false })),
		...servers.map((server) => ({ id: server.name, name: server.name, kind: 'mcp' as const, codeMode: server.codeMode !== false })),
	];
}

/** A tool as the agent calls it through connector_call: its arguments as a JSON schema, and what running it does. */
type ConnectorTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run: (taskId: string, args: unknown, signal: AbortSignal) => Promise<{ output: string; approval?: MailApprovalView }>;
};

type Connector = { id: string; name: string; kind: SetUpConnector['kind']; state: 'on' | 'off' | 'needs-sign-in'; problem: string | null; tools: () => Promise<ConnectorTool[]> };

const addressList = v.pipe(v.array(v.pipe(v.string(), v.minLength(3), v.maxLength(320), v.regex(/^[^\r\n,]+$/, 'One address per item'))), v.maxLength(50));
const ADDRESSES = { type: 'array', items: { type: 'string' }, maxItems: 50 };

function checked<T extends v.GenericSchema>(schema: T, args: unknown): v.InferOutput<T> {
	const result = v.safeParse(schema, args ?? {});
	if (!result.success) throw new InvalidInputError(`Wrong arguments: ${result.issues.map((issue) => `${v.getDotPath(issue) ?? 'arguments'}: ${issue.message}`).join('; ')}`);
	return result.output;
}

/** A mailbox's tools (Gmail): search and read, write drafts, and ask to send one, as its sign-in and switches allow. */
function mailboxTools(id: string, name: string, access: { draft: boolean; send: boolean }): ConnectorTool[] {
	const search = v.object({ query: v.pipe(v.string(), v.maxLength(500)), max: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_SEARCH))) });
	const read = v.object({ thread_id: v.pipe(v.string(), v.minLength(1), v.maxLength(100)) });
	const draft = v.object({
		to: addressList,
		cc: v.optional(addressList),
		bcc: v.optional(addressList),
		subject: v.pipe(v.string(), v.maxLength(500)),
		body: v.pipe(v.string(), v.maxLength(100_000)),
		thread_id: v.optional(v.pipe(v.string(), v.maxLength(100))),
		draft_id: v.optional(v.pipe(v.string(), v.maxLength(100))),
	});
	const send = v.object({ draft_id: v.pipe(v.string(), v.minLength(1), v.maxLength(100)) });
	return [
		{
			name: `${id}_search`,
			description:
				`Search the user's ${name} with its search syntax (from:, to:, subject:, after:2026/10/01, is:unread, has:attachment, label:, "exact words"), newest first. ` +
				"Returns each conversation's thread_id, subject, latest sender, date and snippet.",
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: "The search, as typed in the mailbox's search box; empty lists the newest" },
					max: { type: 'integer', minimum: 1, maximum: MAX_SEARCH, description: `How many conversations, up to ${MAX_SEARCH} (default 10)` },
				},
				required: ['query'],
			},
			run: async (_task, args, signal) => {
				const data = checked(search, args);
				return { output: await searchMail(id, data.query, data.max ?? 10, signal) };
			},
		},
		{
			name: `${id}_read_thread`,
			description: `Read a ${name} conversation in full, oldest message first, with each message's sender, recipients, date, text and attachment names.`,
			inputSchema: { type: 'object', properties: { thread_id: { type: 'string', description: `The thread_id ${id}_search gave` } }, required: ['thread_id'] },
			run: async (_task, args, signal) => ({ output: await readMailThread(id, checked(read, args).thread_id, signal) }),
		},
		...(access.draft
			? [
					{
						name: `${id}_draft`,
						description:
							`Write an email as a draft in the user's ${name}, or rewrite a draft you wrote (give its draft_id). Nothing is sent. ` +
							"With thread_id it is a reply in that conversation, to its latest message; leave subject empty to reply under the conversation's subject. The body is plain text.",
						inputSchema: {
							type: 'object',
							properties: {
								to: { ...ADDRESSES, description: 'Recipients, such as ada@example.com or "Ada Lovelace <ada@example.com>"' },
								cc: ADDRESSES,
								bcc: ADDRESSES,
								subject: { type: 'string' },
								body: { type: 'string', description: 'The message as plain text' },
								thread_id: { type: 'string', description: 'The conversation to reply in' },
								draft_id: { type: 'string', description: 'A draft to rewrite instead of writing a new one' },
							},
							required: ['to', 'subject', 'body'],
						},
						run: async (_task: string, args: unknown, signal: AbortSignal) => {
							const data = checked(draft, args);
							const input = { to: data.to, cc: data.cc ?? [], bcc: data.bcc ?? [], subject: data.subject, body: data.body, threadId: data.thread_id ?? null };
							return { output: await writeDraft(id, input, data.draft_id ?? null, signal) };
						},
					},
				]
			: []),
		...(access.send
			? [
					{
						name: `${id}_send`,
						description:
							`Ask the user to send a draft from their ${name}. The thread shows them the email as it stands, with Send and Don't send; it goes only when they press Send. ` +
							'Write the draft first, and only ask to send what the user wanted sent. Then stop and wait for their answer.',
						inputSchema: { type: 'object', properties: { draft_id: { type: 'string', description: 'The draft to send' } }, required: ['draft_id'] },
						run: (task: string, args: unknown, signal: AbortSignal) => requestSend(task, id, checked(send, args).draft_id, signal),
					},
				]
			: []),
	];
}

/** `mcp__<server>__<tool>`, the name a program calls the tool by too, so both read the same in the thread. */
export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^\w]/g, '_');

/** What the agent reads back from an MCP call: its text, else its structured result, with images and files named rather than dropped. */
function mcpText(result: McpCallResult, tool: string): string {
	const text = (result.content ?? [])
		.map((part) => {
			if (part.type === 'text') return String(part.text ?? '');
			if (part.type === 'image' || part.type === 'audio') return `[${String(part.mimeType ?? part.type)} ${part.type} left out]`;
			if (part.type === 'resource') {
				const resource = (part.resource ?? {}) as { uri?: string; text?: string };
				return resource.text ?? `[resource ${resource.uri ?? ''} left out]`;
			}
			if (part.type === 'resource_link') return `[${String(part.name ?? 'link')}: ${String(part.uri ?? '')}]`;
			return `[${part.type} left out]`;
		})
		.join('\n');
	if (result.isError) throw new Error(text || `${tool} failed`);
	return text || (result.structuredContent === undefined ? '(No result.)' : JSON.stringify(result.structuredContent));
}

function serverToolsFor(server: McpServer, tools: McpTool[]): ConnectorTool[] {
	return tools.map((tool) => ({
		name: mcpToolName(server.name, tool.name),
		description: tool.description ?? '',
		inputSchema: tool.inputSchema ?? { type: 'object' },
		run: async (_task, args, signal) => ({ output: mcpText(await callServerTool(server, tool.name, (args ?? {}) as Record<string, unknown>, signal), tool.name) }),
	}));
}

/** Every connector set up, as it stands this moment, with its tools read only when asked for. */
async function connectorsNow(): Promise<Connector[]> {
	const [view, servers] = await Promise.all([connectorsView(), mcpServerStates()]);
	const mailboxes = view.mailboxes.flatMap((mailbox): Connector[] => {
		const account = view.accounts.find((item) => item.id === mailbox.account);
		if (!account?.connectedAt) return [];
		const state = !mailbox.options.enabled ? 'off' : account.problem || !mailbox.access ? 'needs-sign-in' : 'on';
		const access = mailbox.access;
		return [{ id: mailbox.id, name: mailbox.name, kind: 'mailbox', state, problem: account.problem, tools: async () => (access ? mailboxTools(mailbox.id, mailbox.name, access) : []) }];
	});
	return [
		...mailboxes,
		...servers.map((entry): Connector => {
			const server = entry.server;
			return { id: entry.name, name: entry.name, kind: 'mcp', state: entry.state, problem: entry.problem, tools: async () => (server ? serverToolsFor(server, await serverTools(server)) : []) };
		}),
	];
}

const OFF = "it is off. If the work needs it, ask the user to turn it on from the composer's + menu, under Connectors; it works from your next call after that.";
/** At most this many tools are given in full at once; a query narrows a longer list. */
const MAX_LISTED = 30;

/** What connector_tools answers: each connector's state, and the matching tools of those that are on, each with its arguments in full. */
export async function connectorToolsText(query: string, signal?: AbortSignal): Promise<string> {
	const connectors = await connectorsNow();
	if (!connectors.length) return 'No connectors are set up. The user adds them in Settings › Connectors.';
	const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	const sections: string[] = [];
	let listed = 0;
	let unlisted = 0;
	for (const connector of connectors) {
		if (signal?.aborted) break;
		if (connector.state === 'off') {
			sections.push(`## ${connector.name}: ${OFF}`);
			continue;
		}
		if (connector.state === 'needs-sign-in') {
			sections.push(`## ${connector.name}: it is on, but its sign-in needs the user (${connector.problem ?? 'sign in again in Settings › Connectors'}). Ask them to sign in again in Settings › Connectors.`);
			continue;
		}
		let tools: ConnectorTool[];
		try {
			tools = await connector.tools();
		} catch (error) {
			logProblem('warn', `Could not list the ${connector.name} connector's tools`, error);
			sections.push(`## ${connector.name}: it is on, but could not be reached just now (${error instanceof Error ? error.message : String(error)}).`);
			continue;
		}
		const scored = tools
			.map((tool) => {
				const name = tool.name.toLowerCase();
				const text = `${connector.name} ${tool.description} ${JSON.stringify(tool.inputSchema)}`.toLowerCase();
				return { tool, score: words.reduce((total, word) => total + (name.includes(word) ? 3 : 0) + (text.includes(word) ? 1 : 0), 0) };
			})
			.filter((entry) => !words.length || entry.score > 0)
			.sort((a, b) => b.score - a.score);
		const shown = scored.slice(0, Math.max(0, MAX_LISTED - listed));
		listed += shown.length;
		unlisted += scored.length - shown.length;
		const body = shown.map(({ tool }) => `### ${tool.name}\n${tool.description.trim()}\nArguments: ${JSON.stringify(tool.inputSchema)}`);
		sections.push([`## ${connector.name}: on, ${tools.length} tool${tools.length === 1 ? '' : 's'}${words.length ? `, ${scored.length} matching` : ''}`, ...body].join('\n\n'));
	}
	const more = unlisted ? `\n\n${unlisted} more tools match; search with fewer, more specific words to see them.` : '';
	return `Call a tool with connector_call, giving its name and arguments.\n\n${sections.join('\n\n')}${more}`;
}

/** How long a call may take when the runtime gives no signal of its own. */
const CALL_MS = 5 * 60_000;

/** Runs one connector tool for a task, if its connector is on now. A mailbox's send only asks: the answer carries the approval the thread shows. */
export async function callConnectorTool(taskId: string, name: string, args: unknown, signal = AbortSignal.timeout(CALL_MS)): Promise<{ output: string; approval?: MailApprovalView }> {
	for (const connector of await connectorsNow()) {
		if (!name.startsWith(connector.kind === 'mcp' ? mcpToolName(connector.id, '') : `${connector.id}_`)) continue;
		if (connector.state === 'off') throw new InvalidInputError(`${connector.name} is off: ${OFF}`);
		if (connector.state === 'needs-sign-in') throw new InvalidInputError(`${connector.name} needs the user to sign in again in Settings › Connectors.`);
		const tool = (await connector.tools()).find((item) => item.name === name);
		if (!tool) continue;
		const result = await tool.run(taskId, args, signal);
		return { ...result, output: redactor(await secretsToHide(taskId))(result.output) };
	}
	throw new NotFoundError(`No connector that is on has a tool named ${name}. List them with connector_tools.`);
}
