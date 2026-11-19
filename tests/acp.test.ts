import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeConversationOptions, RuntimeEvent, RuntimeTool, RuntimeToolOutput, SubscriptionModel } from '../src/core/ports.ts';
import type { AcpTransport } from '../src/providers/acp/client.ts';
import { devinAgent } from '../src/providers/acp/devin.ts';
import { acpRuntime, type AcpHost, type AcpProcess } from '../src/providers/acp/runtime.ts';

function queue<T>() {
	const items: T[] = [];
	const waiters: ((result: IteratorResult<T>) => void)[] = [];
	let closed = false;
	return {
		push(...more: T[]) {
			for (const item of more) {
				const waiter = waiters.shift();
				if (waiter) waiter({ value: item, done: false });
				else items.push(item);
			}
		},
		close() {
			closed = true;
			for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
		},
		[Symbol.asyncIterator]: () => ({
			next: (): Promise<IteratorResult<T>> =>
				items.length
					? Promise.resolve({ value: items.shift()!, done: false })
					: closed
						? Promise.resolve({ value: undefined, done: true })
						: new Promise((resolve) => waiters.push(resolve)),
		}),
	};
}

/** One direction of a fake exec channel: `incoming` is what the agent sends, `sent` what the host wrote. */
function fakeChannel() {
	const raw = queue<string>();
	const incoming = {
		...raw,
		// ACP and MCP are newline-delimited; tests push bare JSON.
		push: (...items: string[]) => raw.push(...items.map((item) => (item.endsWith('\n') ? item : `${item}\n`))),
	};
	const sent: string[] = [];
	const transport: AcpTransport = {
		write: (data) => sent.push(data),
		lines: () => incoming as AsyncIterable<string>,
		closeStdin: async () => incoming.close(),
		kill: async () => undefined,
	};
	return { incoming, sent, transport };
}

const parse = (sent: string[]) => sent.flatMap((chunk) => chunk.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, what: string, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
		await sleep(5);
	}
}

const BASH: RuntimeTool = { name: 'bash', description: 'Run a command', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } };

function fakeHost(process: AcpProcess): AcpHost {
	return {
		async signedIn() {
			return { signedIn: true, problem: null };
		},
		async credential() {
			return 'test-token';
		},
		signIn: () => Promise.reject(new Error('unused')),
		signOut: async () => undefined,
		async listModels(): Promise<SubscriptionModel[]> {
			return [];
		},
		spawn: async () => process,
	};
}

function rig(callTool: RuntimeConversationOptions['callTool'], model = 'swe-2-high') {
	const acp = fakeChannel();
	const mcp = fakeChannel();
	const process: AcpProcess = {
		acp: acp.transport,
		mcp: mcp.transport,
		writeFile: async () => undefined,
		close: async () => undefined,
		stderrTail: () => '',
	};
	const runtime = acpRuntime(devinAgent, fakeHost(process));
	const conv = runtime.open({ model, instructions: 'Be brief.', tools: [BASH], effort: null, callTool });
	const seen: RuntimeEvent[] = [];
	const collecting = (async () => {
		for await (const event of conv.events) seen.push(event);
	})();
	return { acp, mcp, conv, seen, collecting };
}

/** Answers one ACP request the host sent, matched by method. */
async function answer(acp: ReturnType<typeof fakeChannel>, method: string, result: unknown) {
	await until(() => parse(acp.sent).some((m) => m.method === method && m.id !== undefined), `request ${method}`);
	const request = parse(acp.sent).filter((m) => m.method === method && m.id !== undefined).at(-1)!;
	acp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}

const update = (sessionId: string, u: Record<string, unknown>) =>
	JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const chunk = (sessionId: string, kind: string, text: string) =>
	update(sessionId, { sessionUpdate: kind, content: { type: 'text', text } });

/** MCP handshake then one tools/call, returning once the host's response is on the wire. */
async function mcpCall(mcp: ReturnType<typeof fakeChannel>, name: string, args: unknown, id = 1): Promise<Record<string, unknown>> {
	mcp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '0' } } }));
	await until(() => parse(mcp.sent).some((m) => m.id === 100), 'mcp initialize response');
	mcp.incoming.push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
	mcp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} }));
	await until(() => parse(mcp.sent).some((m) => m.id === 101), 'mcp tools/list response');
	mcp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
	await until(() => parse(mcp.sent).some((m) => m.id === id), `mcp tools/call response for ${name}`);
	return parse(mcp.sent).find((m) => m.id === id)!;
}

test('streams text, pauses at an Anton tool call with its arguments, resumes and ends the turn', async () => {
	const delivered: RuntimeToolOutput[] = [];
	const calls: { id: string; name: string }[] = [];
	const { acp, mcp, conv, seen } = rig(async (id, name) => {
		calls.push({ id, name });
		await until(() => delivered.length > 0, 'the test to deliver a tool result');
		return delivered.shift()!;
	});
	conv.send([{ type: 'text', text: 'list files' }]);

	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'devin-browser' }] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', {
		sessionId: 'sess-1',
		configOptions: [{ id: 'model', options: [{ value: 'swe-2-high', name: 'SWE 2 High' }] }],
	});
	await answer(acp, 'session/set_config_option', { configOptions: [] });
	const setModel = parse(acp.sent).find((m) => m.method === 'session/set_config_option');
	assert.deepEqual(setModel?.params, { sessionId: 'sess-1', configId: 'model', value: 'swe-2-high' });

	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	const promptId = parse(acp.sent).find((m) => m.method === 'session/prompt')!.id;

	acp.incoming.push(chunk('sess-1', 'agent_message_chunk', 'Checking. '));
	acp.incoming.push(chunk('sess-1', 'agent_message_chunk', 'One moment.'));

	const mcpResult = mcpCall(mcp, 'bash', { command: 'ls' });
	assert.deepEqual(calls, [], 'callTool has not run before the events land');
	await until(() => calls.length === 1, 'callTool to be invoked');
	const firstCall = calls[0] as { id: string; name: string } | undefined;
	assert.equal(firstCall?.name, 'bash');

	const isStart = (e: RuntimeEvent): e is Extract<RuntimeEvent, { type: 'block_start' }> => e.type === 'block_start';
	const isDelta = (e: RuntimeEvent): e is Extract<RuntimeEvent, { type: 'block_delta' }> => e.type === 'block_delta';
	const toolEvents = seen.filter((e) => e.type !== 'message_start' && e.type !== 'message_delta' && e.type !== 'message_stop');
	// Setup announces itself as thinking ([Devin] starting session… / session ready), then
	// the answer's text block and the tool_use pause. The post-tool segment lands later.
	assert.deepEqual(
		toolEvents.map((e) => e.type),
		[
			'block_start',
			'block_delta',
			'block_delta',
			'block_stop',
			'block_start',
			'block_delta',
			'block_delta',
			'block_stop',
			'block_start',
			'block_delta',
			'block_stop',
		],
	);
	const toolUse = toolEvents.filter(isStart).find((e) => e.block.type === 'tool_use');
	assert.ok(toolUse && toolUse.block.type === 'tool_use');
	assert.equal(toolUse.block.name, 'bash');
	assert.equal(firstCall?.id, toolUse.block.id);
	const jsonDelta = toolEvents.filter(isDelta).find((e) => e.json);
	assert.equal(jsonDelta?.json ?? null, '{"command":"ls"}');
	assert.ok(seen.some((e) => e.type === 'message_delta' && e.stopReason === 'tool_use'), 'the step ends at the tool call');
	assert.ok(seen.some((e) => e.type === 'message_stop'), 'message_stop closes the step');

	// Flue delivers the result; the parked MCP call resolves and the agent hears back.
	delivered.push({ content: [{ type: 'text', text: 'file.txt' }], isError: false });
	const result = await mcpResult;
	assert.deepEqual(result.result, { content: [{ type: 'text', text: 'file.txt' }], isError: false });

	acp.incoming.push(chunk('sess-1', 'agent_thought_chunk', 'thinking…'));
	acp.incoming.push(chunk('sess-1', 'agent_message_chunk', 'Done.'));
	acp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 30 } } }));

	await until(() => seen.some((e) => e.type === 'turn_end'), 'turn_end');
	const kinds = seen.map((e) => e.type);
	assert.equal(kinds.filter((k) => k === 'message_start').length, 2, 'one message per model step');
	assert.equal(kinds.filter((k) => k === 'message_stop').length, 2);
	assert.equal(kinds.at(-1), 'turn_end');
	const lastDelta = [...seen].reverse().find((e) => e.type === 'message_delta');
	const lastDeltaTyped = lastDelta as Extract<RuntimeEvent, { type: 'message_delta' }> | undefined;
	assert.equal(lastDeltaTyped?.stopReason ?? null, 'end_turn');
	assert.equal(lastDeltaTyped?.usage.input ?? 0, 120);
	conv.close();
});

test('a namespaced MCP tool name still reaches Anton under its own name', async () => {
	const calls: string[] = [];
	const { acp, mcp, conv } = rig(async (_id, name) => {
		calls.push(name);
		return { content: [{ type: 'text', text: 'ok' }], isError: false };
	});
	conv.send([{ type: 'text', text: 'hi' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', { sessionId: 's', configOptions: [] });
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	const promptId = parse(acp.sent).find((m) => m.method === 'session/prompt')!.id;
	await mcpCall(mcp, 'mcp__anton__bash', { command: 'pwd' });
	await until(() => calls.length === 1, 'callTool');
	assert.deepEqual(calls, ['bash']);
	acp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }));
	conv.close();
});

test('an unknown tool fails inside MCP without emitting runtime events', async () => {
	const seen: RuntimeEvent[] = [];
	const { acp, mcp, conv } = rig(async () => ({ content: [], isError: false }));
	void (async () => {
		for await (const event of conv.events) seen.push(event);
	})();
	conv.send([{ type: 'text', text: 'hi' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', { sessionId: 's', configOptions: [] });
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	const promptId = parse(acp.sent).find((m) => m.method === 'session/prompt')!.id;
	const result = await mcpCall(mcp, 'rm_rf', {});
	assert.equal((result.result as { isError?: boolean }).isError, true);
	acp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }));
	await sleep(20);
	assert.equal(
		seen.filter((e) => e.type === 'block_start' && e.block.type === 'tool_use').length,
		0,
		'no tool_use was announced for a tool Anton does not have',
	);
	conv.close();
});

test('a model already selected in session/new skips set_config_option', async () => {
	const { acp, conv } = rig(async () => ({ content: [], isError: false }));
	conv.send([{ type: 'text', text: 'hi' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', {
		sessionId: 's',
		configOptions: [{ id: 'model', currentValue: 'swe-2-high', options: [{ value: 'swe-2-high' }] }],
	});
	// applyModel runs before the prompt is sent; its absence by then means it was skipped.
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	assert.equal(parse(acp.sent).some((m) => m.method === 'session/set_config_option'), false);
	conv.close();
});

test('permission requests allow Anton tools and refuse the agent\'s own', async () => {
	const { acp, conv } = rig(async () => ({ content: [], isError: false }));
	conv.send([{ type: 'text', text: 'hi' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', { sessionId: 's', configOptions: [] });
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');

	const ask = (id: number, rule: string) =>
		acp.incoming.push(
			JSON.stringify({
				jsonrpc: '2.0',
				id,
				method: 'session/request_permission',
				params: {
					toolCall: { title: rule },
					_meta: { 'cognition.ai/permissionRule': rule },
					options: [
						{ optionId: 'allow', kind: 'allow_once', name: 'Allow' },
						{ optionId: 'reject', kind: 'reject_once', name: 'Reject' },
					],
				},
			}),
		);
	ask(7, 'mcp__anton__bash');
	ask(8, 'exec rm -rf /');
	await until(() => parse(acp.sent).filter((m) => m.id === 7 || m.id === 8).length === 2, 'permission answers');
	const answers = parse(acp.sent).filter((m) => m.id === 7 || m.id === 8);
	assert.deepEqual(answers.find((m) => m.id === 7)?.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
	assert.deepEqual(answers.find((m) => m.id === 8)?.result, { outcome: { outcome: 'selected', optionId: 'reject' } });
	conv.close();
});

test('devin catalog parse reads context and list price per variant', () => {
	const text = [
		'Available models (54 families)',
		'',
		'Adaptive (adaptive)',
		'  adaptive                              Adaptive  [$0.5 / 1M Input · $0.1 / 1M Cached input · $2 / 1M Output]',
		'SWE-2 (swe-2)',
		'  aliases: swe',
		'  swe-2-high                            SWE-2 High  [262K context, Free]',
		'  swe-2-medium-lightning                SWE-2 Medium Lightning  [262K context, $1 / 1M Input · $0.1 / 1M Cached input · $5 / 1M Output]',
		'  gpt-6-sol-low-priority                GPT-6 Sol Low Thinking Fast  [1M context, $2 / 1M Input · $0.2 / 1M Cached input · $10 / 1M Output]',
		'  glm-5-2-1m                            GLM-5.2 High 1M  [1M context, $0.5 / 1M Input · $0.1 / 1M Cached input · $2 / 1M Output]',
	].join('\n');
	const catalog = devinAgent.catalog!.parse(text);
	assert.equal(catalog.size, 5);
	assert.equal(catalog.get('adaptive')?.contextLength, 0);
	assert.deepEqual(catalog.get('adaptive')?.listPrice, { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0 });
	assert.equal(catalog.get('swe-2-high')?.contextLength, 262_000);
	assert.equal(catalog.get('swe-2-high')?.listPrice, null);
	assert.equal(catalog.get('swe-2-medium-lightning')?.contextLength, 262_000);
	assert.deepEqual(catalog.get('swe-2-medium-lightning')?.listPrice, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 });
	assert.equal(catalog.get('gpt-6-sol-low-priority')?.contextLength, 1_000_000);
	assert.equal(catalog.get('glm-5-2-1m')?.contextLength, 1_000_000);
});
