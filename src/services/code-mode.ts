import { CodemodeSandbox, type CodemodeJsonSchema, type CodemodeResult, type CodemodeTool, renderDeclarations, renderToolSample } from '@earendil-works/pi-codemode';
import type { Question } from '../core/ports.ts';
import { redactor } from '../core/redact.ts';
import type { McpServer } from '../core/types.ts';
import { connectorsFor, isWebServer, mcpServersFor } from './agent-runner.ts';
import { mcpToolName } from './connector-tools.ts';
import { ask, hasDecisionModel } from './decisions.ts';
import { logProblem } from './log.ts';
import { enabledMcpServers } from './mcp-servers.ts';
import { callServerTool, type McpCallResult, type McpTool, serverTools } from './mcp-tools.ts';
import { repoPaths, repoText, searchRepo } from './repo-snapshot.ts';
import type { ScriptCall } from './script-runs.ts';
import { secretsToHide } from './secrets.ts';

/**
 * Code mode: the agent writes one short JavaScript program that calls tools,
 * and only what the program prints or returns comes back to it, so many
 * reads, searches or lookups cost one turn and a short answer. Programs run
 * in a fresh QuickJS VM on Anton's side that can reach nothing but the
 * functions handed to it: the read-only repo, the task's MCP servers and the
 * decision model. In a workspace the sandbox's own shell already does this
 * for files and commands.
 *
 * Programs also reach the MCP servers of the connectors that are on (unless a
 * server opts out), read as each program starts: the agent finds their tools
 * with `connector_tools` or `search_tools()`, never in run_script's
 * description, which stays the same whichever connectors are on, so turning
 * one on or off keeps the cached prompt. The built-in web search is a direct
 * tool as well.
 */

const TIMEOUT_MS = 60_000;
/** Enough to glue tool results together; a runaway program fails inside its VM instead of growing Anton. */
const MEMORY_BYTES = 64 * 1024 * 1024;
/** What goes back to the model is cut to this, keeping its start and end. */
const MAX_RESULT_CHARS = 20_000;
/** Decision model calls one program runs at a time; the rest wait their turn. */
const DECISIONS_AT_ONCE = 4;
const SEARCH_RESULTS = 8;

/** Where a program runs: before a workspace it can read the repo; a subagent may have no MCP servers. */
export type ScriptScope = { repo: boolean; mcp: boolean };

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

/** Whether programs can reach any MCP server: web search, or a connector's server that has not opted out, on or off for now. */
function reachesServers(id: string): boolean {
	return mcpServersFor(id).length > 0 || connectorsFor(id).some((connector) => connector.kind === 'mcp' && connector.codeMode);
}

/** The servers a program reaches, read as it starts: web search, and the connectors' servers that are on, unless one opted out. */
export async function scriptServers(id: string): Promise<McpServer[]> {
	const connected = connectorsFor(id).some((connector) => connector.kind === 'mcp') ? await enabledMcpServers() : [];
	return [...mcpServersFor(id), ...connected].filter((server) => server.codeMode !== false);
}

/**
 * Whether the agent connects to this server itself. With code mode on, only web search and servers that
 * opted out of code mode do; the rest are reached through run_script.
 */
export function directServer(server: McpServer, scripts: boolean): boolean {
	return !scripts || server.codeMode === false || isWebServer(server);
}

/** What a program reads back from an MCP call: its structured result, else its text, with images and files named rather than dropped silently. */
function mcpValue(result: McpCallResult, tool: string): unknown {
	const text = (result.content ?? [])
		.map((part) => {
			if (part.type === 'text') return String(part.text ?? '');
			if (part.type === 'image' || part.type === 'audio') return `[${String(part.mimeType ?? part.type)} ${part.type} left out: a program cannot pass it on]`;
			if (part.type === 'resource') {
				const resource = (part.resource ?? {}) as { uri?: string; text?: string };
				return resource.text ?? `[resource ${resource.uri ?? ''} left out]`;
			}
			if (part.type === 'resource_link') return `[${String(part.name ?? 'link')}: ${String(part.uri ?? '')}]`;
			return `[${part.type} left out]`;
		})
		.join('\n');
	if (result.isError) throw new Error(text || `${tool} failed`);
	return result.structuredContent ?? text;
}

function mcpTool(server: McpServer, tool: McpTool): CodemodeTool {
	return {
		name: mcpToolName(server.name, tool.name),
		description: tool.description,
		inputSchema: (tool.inputSchema ?? { type: 'object' }) as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema ?? { type: 'string' }) as CodemodeJsonSchema,
		execute: async (args, { signal }) => mcpValue(await callServerTool(server, tool.name, (args ?? {}) as Record<string, unknown>, signal), tool.name),
	};
}

/** The task's MCP tools for one program; a server that cannot be reached leaves its tools out. */
async function mcpTools(id: string): Promise<CodemodeTool[]> {
	const lists = await Promise.all(
		(await scriptServers(id)).map(async (server) => {
			try {
				return (await serverTools(server)).map((tool) => mcpTool(server, tool));
			} catch (error) {
				logProblem('warn', `run_script could not reach the ${server.name} MCP server`, error, id);
				return [];
			}
		}),
	);
	return lists.flat();
}

/** Finds tools a program can call by words in their names, descriptions and arguments; the best matches come back declared in full. */
function searchGlobal(tools: () => CodemodeTool[]): CodemodeTool {
	return {
		name: 'search_tools',
		description: 'Find the tools you can call here by words in their names, descriptions and arguments, best first, each with its full declaration. Use it before calling a tool that is not listed.',
		signature: '(query: string, limit?: number): Promise<Array<{ name: string; declaration: string }>>',
		spread: true,
		execute(args) {
			const [query, limit] = args as [string, number | undefined];
			const words = String(query ?? '')
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter(Boolean);
			const scored = tools().map((tool) => {
				const name = tool.name.toLowerCase();
				const text = `${tool.description ?? ''} ${JSON.stringify(tool.inputSchema ?? {})}`.toLowerCase();
				const score = words.reduce((total, word) => total + (name.includes(word) ? 3 : 0) + (text.includes(word) ? 1 : 0), 0);
				return { tool, score };
			});
			return scored
				.filter((entry) => entry.score > 0 || words.length === 0)
				.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
				.slice(0, Math.max(1, Math.min(50, Number(limit) || SEARCH_RESULTS)))
				.map(({ tool }) => ({ name: tool.name, declaration: renderToolSample(tool) }));
		},
	};
}

/** Whether run_script has anything to offer: the repo, the decision model or an MCP server. */
export function hasScriptTools(id: string, scope: ScriptScope): boolean {
	return scope.repo || hasDecisionModel() || (scope.mcp && reachesServers(id));
}

/**
 * The run_script tool's description. It names no connector's tools and does not change when one is turned on or
 * off, so the cached prompt stays valid.
 */
export function scriptToolDescription(id: string, scope: ScriptScope): string {
	const globals = [...(hasDecisionModel() ? [decideGlobal(id)] : []), ...(scope.mcp ? [searchGlobal(() => [])] : [])];
	const declared = renderDeclarations({ tools: scope.repo ? repoTools(id) : [], globals });
	const web = scope.mcp && mcpServersFor(id).some(isWebServer) ? ['The web search tools in your tool list (mcp__web__…) can be called here too, as tools.<that name>(args).'] : [];
	const connected = scope.mcp && connectorsFor(id).some((connector) => connector.kind === 'mcp' && connector.codeMode);
	const connectors = connected
		? [
				"The MCP tools of the user's connectors that are on can be called here too, as tools.mcp__<server>__<tool>(args), the names connector_tools gives; they resolve to the tool's structured result when it has one, else its text. search_tools() finds them from a program.",
			]
		: [];
	return [
		'Run a short JavaScript program that calls tools, and get back only what it prints with text() or console.log() and what it returns.',
		'Use it instead of many separate tool calls when a job needs several reads, searches or lookups, or when results are large and you only need part of them: loop, filter and combine in code.',
		'The code is the body of an async function: top-level await and return work. There is no file system, network, require, fetch or timers; it can only call what is declared below.',
		'Run independent calls together with Promise.all. Return something small: paths, short excerpts, counts, a summary.',
		...web,
		...connectors,
		declared,
	].join('\n\n');
}

/** Text items, the return value and any error, as the model reads them. */
function resultText(result: CodemodeResult): string {
	const printed = result.output.flatMap((item) => (item.type === 'text' ? [item.text] : [`[${item.mimeType} image left out]`]));
	const value = result.ok ? (result.value === undefined ? [] : [typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 1)]) : [];
	const failure = result.ok ? [] : [`${result.error.kind === 'timeout' ? 'The program ran out of time.' : 'The program failed.'} ${result.error.stack ?? result.error.message}`];
	const text = [...printed, ...value, ...failure].join('\n') || '(The program printed and returned nothing.)';
	if (text.length <= MAX_RESULT_CHARS) return text;
	const half = MAX_RESULT_CHARS / 2;
	return `${text.slice(0, half)}\n… ${text.length - MAX_RESULT_CHARS} characters left out; return less …\n${text.slice(-half)}`;
}

/** Each call the program makes is told to `onCalls` as it starts and ends, the whole list each time. */
function watched(tool: CodemodeTool, calls: ScriptCall[], told: () => void): CodemodeTool {
	return {
		...tool,
		async execute(args, context) {
			const call: ScriptCall = { tool: tool.name, input: args as never, state: 'running', durationMs: null };
			calls.push(call);
			told();
			const started = Date.now();
			try {
				const value = await tool.execute(args, context);
				call.state = 'done';
				return value;
			} catch (error) {
				call.state = 'failed';
				throw error;
			} finally {
				call.durationMs = Date.now() - started;
				told();
			}
		},
	};
}

type RunOptions = ScriptScope & { signal?: AbortSignal; onCalls?: (calls: ScriptCall[]) => void };

/** Runs one program for a task and returns what the model reads back. */
export async function runScript(id: string, code: string, { repo, mcp, signal, onCalls }: RunOptions): Promise<string> {
	const calls: ScriptCall[] = [];
	const told = () => onCalls?.(calls.map((call) => ({ ...call })));
	// Listing MCP tools may mean connecting, so only for programs that name one or search for one.
	const reachesMcp = mcp && /mcp__|search_tools/.test(code);
	const tools = [...(repo ? repoTools(id) : []), ...(reachesMcp ? await mcpTools(id) : [])];
	const sandbox = new CodemodeSandbox({
		tools: tools.map((tool) => watched(tool, calls, told)),
		globals: [...(hasDecisionModel() ? [watched(decideGlobal(id), calls, told)] : []), ...(mcp ? [searchGlobal(() => tools)] : [])],
		timeoutMs: TIMEOUT_MS,
		memoryLimitBytes: MEMORY_BYTES,
	});
	try {
		const result = await sandbox.execute(code, { signal });
		return redactor(await secretsToHide(id))(resultText(result));
	} finally {
		await sandbox.close();
	}
}
