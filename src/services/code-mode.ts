import { CodemodeSandbox, type CodemodeResult, type CodemodeTool, renderDeclarations } from '@earendil-works/pi-codemode';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Question } from '../core/ports.ts';
import { redactor } from '../core/redact.ts';
import { mcpServersFor } from './agent-runner.ts';
import { ask, hasDecisionModel } from './decisions.ts';
import { logProblem } from './log.ts';
import { repoPaths, repoText, searchRepo } from './repo-snapshot.ts';
import { secretsToHide } from './secrets.ts';

/**
 * Code mode: the agent writes one short JavaScript program that calls tools,
 * and only what the program prints or returns comes back to it, so many
 * reads, searches or lookups cost one turn and a short answer. Programs run
 * in a fresh QuickJS VM on Anton's side that can reach nothing but the
 * functions handed to it: the read-only repo, the task's MCP servers and the
 * decision model. In a workspace the sandbox's own shell already does this
 * for files and commands.
 */

const TIMEOUT_MS = 60_000;
/** Enough to glue tool results together; a runaway program fails inside its VM instead of growing Anton. */
const MEMORY_BYTES = 64 * 1024 * 1024;
/** What goes back to the model is cut to this, keeping its start and end. */
const MAX_RESULT_CHARS = 20_000;
/** Decision model calls one program runs at a time; the rest wait their turn. */
const DECISIONS_AT_ONCE = 4;
const MCP_CONNECT_MS = 15_000;

const FILTER = {
	path: { type: 'string', description: 'Only under this folder, relative to the repo root' },
	glob: { type: 'string', description: 'Only paths matching this glob, such as **/*.ts' },
};

/** The repository at the task's base commit, the same files list_files, read_file and search_code read. */
function repoTools(id: string): CodemodeTool[] {
	return [
		{
			name: 'list_files',
			description: 'Every file path in the repository, optionally under a folder or matching a glob.',
			inputSchema: { type: 'object', properties: FILTER },
			outputSchema: { type: 'array', items: { type: 'string' } },
			execute: (args) => repoPaths(id, (args ?? {}) as { path?: string; glob?: string }),
		},
		{
			name: 'read_file',
			description: "A file's whole text. Throws when it does not exist, is binary or is too large.",
			inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
			outputSchema: { type: 'string' },
			execute: (args) => repoText(id, (args as { path: string }).path),
		},
		{
			name: 'search_code',
			description: 'Lines matching a JavaScript regular expression, as "path:line: text" lines, the same as the search_code tool.',
			inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, ignoreCase: { type: 'boolean' }, ...FILTER }, required: ['pattern'] },
			outputSchema: { type: 'string' },
			execute: (args) => searchRepo(id, args as { pattern: string; ignoreCase?: boolean; path?: string; glob?: string }),
		},
	];
}

const QUESTIONS_TYPE = 'Record<string, { type: "yes-no"; instructions: string } | { type: "choice"; instructions: string; options: Record<string, string> }>';
const ANSWERS_TYPE = 'Promise<Record<string, { yes: number } | { choice: string; probabilities: Record<string, number> }>>';

/** The decision model, at most a few calls at a time. */
function decideGlobal(id: string): CodemodeTool {
	let running = 0;
	const waiting: Array<() => void> = [];
	return {
		name: 'decide',
		description:
			'Ask a fast decision model typed questions about some state and get probabilities back, in about a fifth of a second for a fraction of a cent. ' +
			'Use it to judge many items your code cannot judge with a regex: which files or results are relevant, what kind each one is. ' +
			'Keep state small (under about 100,000 characters) and each question specific. `yes` is the probability of yes. It is weak at arithmetic, counting and dates.',
		signature: `(state: Record<string, unknown>, questions: ${QUESTIONS_TYPE}): ${ANSWERS_TYPE}`,
		spread: true,
		async execute(args, { signal }) {
			const [state, questions] = args as [Record<string, unknown>, Record<string, Question>];
			if (running >= DECISIONS_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
			running += 1;
			try {
				return await ask(id, state, questions, signal);
			} finally {
				running -= 1;
				waiting.shift()?.();
			}
		},
	};
}

/** `mcp__<server>__<tool>`, the names the agent already knows these tools by. */
const mcpName = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^\w]/g, '_');

type McpResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };

/** Connects to the task's MCP servers for one program; one that cannot be reached leaves its tools out. */
async function mcpTools(id: string): Promise<{ tools: CodemodeTool[]; close: () => Promise<void> }> {
	const clients: Client[] = [];
	const lists = await Promise.all(
		mcpServersFor(id).map(async (server) => {
			try {
				const client = new Client({ name: 'anton', version: '1' });
				const headers = server.auth ? { Authorization: `Bearer ${server.auth}` } : undefined;
				await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }), { signal: AbortSignal.timeout(MCP_CONNECT_MS) });
				clients.push(client);
				const { tools } = await client.listTools(undefined, { signal: AbortSignal.timeout(MCP_CONNECT_MS) });
				return tools
					.filter((tool) => server.tools.length === 0 || server.tools.includes(tool.name))
					.map(
						(tool): CodemodeTool => ({
							name: mcpName(server.name, tool.name),
							description: tool.description,
							inputSchema: tool.inputSchema as CodemodeTool['inputSchema'],
							async execute(args, { signal }) {
								const result = (await client.callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> }, { signal })) as McpResult;
								const text = (result.content ?? []).map((part) => part.text ?? '').join('\n');
								if (result.isError) throw new Error(text || `${tool.name} failed`);
								return result.structuredContent ?? text;
							},
						}),
					);
			} catch (error) {
				logProblem('warn', `run_script could not reach the ${server.name} MCP server`, error, id);
				return [];
			}
		}),
	);
	return { tools: lists.flat(), close: async () => void (await Promise.allSettled(clients.map((client) => client.close()))) };
}

/** Whether run_script has anything to offer: in a workspace it only adds MCP servers and the decision model. */
export function hasScriptTools(id: string, workspace: boolean): boolean {
	return !workspace || hasDecisionModel() || mcpServersFor(id).length > 0;
}

/** The run_script tool's description: the same for the whole task, so the cached prompt stays valid. */
export function scriptToolDescription(id: string, workspace: boolean): string {
	const declared = renderDeclarations({ tools: workspace ? [] : repoTools(id), globals: hasDecisionModel() ? [decideGlobal(id)] : [] });
	return [
		'Run a short JavaScript program that calls tools, and get back only what it prints with text() or console.log() and what it returns.',
		'Use it instead of many separate tool calls when a job needs several reads, searches or lookups, or when results are large and you only need part of them: loop, filter and combine in code.',
		'The code is the body of an async function: top-level await and return work. There is no file system, network, require, fetch or timers; it can only call what is declared below.',
		'Run independent calls together with Promise.all. Return something small: paths, short excerpts, counts, a summary.',
		'Every MCP tool in your tool list (names starting mcp__) can be called here as tools.<that name>(args), with the same arguments; it resolves to its text, or to its structured result when it has one.',
		declared,
	].join('\n\n');
}

/** Text items, the return value and any error, as the model reads them. */
function resultText(result: CodemodeResult): string {
	const printed = result.output.flatMap((item) => (item.type === 'text' ? [item.text] : []));
	const value = result.ok ? (result.value === undefined ? [] : [typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 1)]) : [];
	const failure = result.ok ? [] : [`${result.error.kind === 'timeout' ? 'The program ran out of time.' : 'The program failed.'} ${result.error.stack ?? result.error.message}`];
	const text = [...printed, ...value, ...failure].join('\n') || '(The program printed and returned nothing.)';
	if (text.length <= MAX_RESULT_CHARS) return text;
	const half = MAX_RESULT_CHARS / 2;
	return `${text.slice(0, half)}\n… ${text.length - MAX_RESULT_CHARS} characters left out; return less …\n${text.slice(-half)}`;
}

/** Runs one program for a task and returns what the model reads back. */
export async function runScript(id: string, code: string, { workspace, signal }: { workspace: boolean; signal?: AbortSignal }): Promise<string> {
	// Connecting costs a round trip per server, so only for programs that name an MCP tool.
	const mcp = code.includes('mcp__') ? await mcpTools(id) : { tools: [], close: async () => undefined };
	const sandbox = new CodemodeSandbox({
		tools: [...(workspace ? [] : repoTools(id)), ...mcp.tools],
		globals: hasDecisionModel() ? [decideGlobal(id)] : [],
		timeoutMs: TIMEOUT_MS,
		memoryLimitBytes: MEMORY_BYTES,
	});
	try {
		const result = await sandbox.execute(code, { signal });
		return redactor(await secretsToHide(id))(resultText(result));
	} finally {
		await sandbox.close();
		await mcp.close();
	}
}
