import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeConversationOptions, RuntimeEvent, RuntimeTool, RuntimeToolOutput, SubscriptionModel } from '../src/core/ports.ts';
import type { AcpTransport } from '../src/providers/acp/client.ts';
import { devinAgent } from '../src/providers/acp/devin.ts';
import { acpRuntime, type AcpAccount, type AcpProcess } from '../src/providers/acp/runtime.ts';

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

function fakeAccount(): AcpAccount {
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
	};
}

function rig(callTool: RuntimeConversationOptions['callTool'], model = 'swe-2-high', agent = devinAgent, effort: string | null = null) {
	const acp = fakeChannel();
	const mcp = fakeChannel();
	const process: AcpProcess = {
		acp: acp.transport,
		mcp: mcp.transport,
		writeFile: async () => undefined,
		close: async () => undefined,
		stderrTail: () => '',
	};
	const runtime = acpRuntime(agent, fakeAccount(), { spawn: async () => process });
	const conv = runtime.open({ model, instructions: 'Be brief.', tools: [BASH], effort, callTool });
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
	// agy namespaces the same call mcp_anton_bash.
	await mcpCall(mcp, 'mcp_anton_bash', { command: 'pwd' }, 2);
	await until(() => calls.length === 2, 'callTool');
	assert.deepEqual(calls, ['bash', 'bash']);
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

test('permission requests allow Anton tools and the agent\'s own, whose files and commands come back to Anton', async () => {
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
	// agy's shape: the call names itself mcp_anton_<tool> under "Run ...", with no permissionRule meta.
	const askAgy = (id: number, name: string, title: string) =>
		acp.incoming.push(
			JSON.stringify({
				jsonrpc: '2.0',
				id,
				method: 'session/request_permission',
				params: {
					toolCall: { name, title },
					options: [
						{ optionId: 'allow', name: 'Allow', kind: 'allow_once' },
						{ optionId: 'deny', name: 'Deny', kind: 'reject_once' },
					],
				},
			}),
		);
	ask(7, 'mcp__anton__bash');
	ask(8, 'exec rm -rf /');
	askAgy(9, 'mcp_anton_render_html', 'Run mcp_anton_render_html');
	askAgy(10, 'run_command', 'Run a terminal command');
	// Bare anton_<tool> names and native edits alike: every request is allowed.
	askAgy(11, 'anton_bash', 'Run anton_bash');
	askAgy(12, 'edit_file', 'Edit anton_config.ts');
	await until(() => parse(acp.sent).filter((m) => [7, 8, 9, 10, 11, 12].includes(Number(m.id))).length === 6, 'permission answers');
	const answers = parse(acp.sent).filter((m) => [7, 8, 9, 10, 11, 12].includes(Number(m.id)));
	assert.deepEqual(answers.find((m) => m.id === 11)?.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
	assert.deepEqual(answers.find((m) => m.id === 12)?.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
	assert.deepEqual(answers.find((m) => m.id === 7)?.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
	assert.deepEqual(answers.find((m) => m.id === 8)?.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
	assert.deepEqual(answers.find((m) => m.id === 9)?.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
	assert.deepEqual(answers.find((m) => m.id === 10)?.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
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

test('effort and session config options are applied after session/new, only when they differ', async () => {
	const agent = { ...devinAgent, effortConfigId: 'thought_level', effortMap: { off: 'low' }, sessionConfig: { mode: 'auto' } };
	const { acp, conv } = rig(async () => ({ content: [], isError: false }), 'swe-2-high', agent, 'high');
	conv.send([{ type: 'text', text: 'hi' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', {
		sessionId: 's',
		configOptions: [
			{ id: 'model', currentValue: 'swe-2-high', options: [{ value: 'swe-2-high' }] },
			{ id: 'thought_level', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
			{ id: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'auto' }] },
			{ id: 'unrelated', currentValue: 'x', options: [{ value: 'x' }, { value: 'y' }] },
		],
	});
	// set_config_option calls are sequential: answer each before the next is sent.
	await until(() => parse(acp.sent).filter((m) => m.method === 'session/set_config_option').length === 1, 'first config write');
	await answer(acp, 'session/set_config_option', {});
	await until(() => parse(acp.sent).filter((m) => m.method === 'session/set_config_option').length === 2, 'second config write');
	await answer(acp, 'session/set_config_option', {});
	const writes = parse(acp.sent).filter((m) => m.method === 'session/set_config_option').map((m) => m.params as Record<string, unknown>);
	assert.deepEqual(writes, [
		{ sessionId: 's', configId: 'thought_level', value: 'high' },
		{ sessionId: 's', configId: 'mode', value: 'auto' },
	]);
	conv.close();
});

test('an effort the option does not accept, and one already current, send nothing', async () => {
	const agent = { ...devinAgent, effortConfigId: 'thought_level' };
	const { acp, conv } = rig(async () => ({ content: [], isError: false }), 'swe-2-high', agent, 'max');
	conv.send([{ type: 'text', text: 'hi' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', {
		sessionId: 's',
		configOptions: [
			{ id: 'model', currentValue: 'swe-2-high', options: [{ value: 'swe-2-high' }] },
			{ id: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] },
		],
	});
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	assert.equal(parse(acp.sent).filter((m) => m.method === 'session/set_config_option').length, 0);
	conv.close();
});

test('ensureCli fetches a missing CLI, puts it on PATH, and caches the probe', async () => {
	const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { ensureCli } = await import('../src/providers/acp/local-cli.ts');
	const { release: _release, ...base } = devinAgent;
	const dir = await mkdtemp(join(tmpdir(), 'anton-cli-'));
	const pathBefore = process.env.PATH;
	let fetches = 0;
	const agent = {
		...base,
		id: 'fakecli',
		command: ['fakecli-acp-test', 'acp'],
		install: {
			fallback: () => ({ version: '0', url: 'http://unused.invalid/x.tgz' }),
			fetch: async (_release: unknown, target: string) => {
				fetches++;
				await writeFile(join(target, 'fakecli-acp-test'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
			},
		},
	};
	try {
		assert.equal(await ensureCli(agent, dir), true);
		assert.equal(fetches, 1);
		// The cached localCli probe answers the second call — no reinstall.
		assert.equal(await ensureCli(agent, dir), true);
		assert.equal(fetches, 1);
	} finally {
		process.env.PATH = pathBefore;
		await rm(dir, { recursive: true, force: true });
	}
});

test('ensureCli passes the host platform to release resolution and skips unsupported hosts', async () => {
	const { mkdtemp, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { ensureCli } = await import('../src/providers/acp/local-cli.ts');
	const { release: _release, ...base } = devinAgent;
	const dir = await mkdtemp(join(tmpdir(), 'anton-cli-'));
	const seen: string[] = [];
	let fetches = 0;
	const agent = {
		...base,
		id: 'fakecli-platform',
		command: ['fakecli-platform-test', 'acp'],
		release: {
			floor: '0',
			latest: async (platform: string) => {
				seen.push(`latest:${platform}`);
				return null;
			},
		},
		install: {
			fallback: (platform: string) => {
				seen.push(`fallback:${platform}`);
				return platform === 'linux/arm64' ? { version: '0', url: 'http://unused.invalid/x.tgz' } : null;
			},
			fetch: async () => {
				fetches++;
			},
		},
	};
	// installAttempts throttles per agent id, so each scenario gets its own.
	const variant = (id: string) => ({ ...agent, id });
	try {
		// No host platform (unsupported OS/arch) never reaches the vendor.
		assert.equal(await ensureCli(variant('fakecli-p1'), dir, null), false);
		assert.deepEqual(seen, []);
		assert.equal(fetches, 0);
		// A platform the vendor has no build for fails before fetch.
		assert.equal(await ensureCli(variant('fakecli-p2'), dir, 'plan9/x64'), false);
		assert.deepEqual(seen, ['latest:plan9/x64', 'fallback:plan9/x64']);
		assert.equal(fetches, 0);
		// A supported platform flows through to latest() then fallback(); the probe then fails (no real binary).
		assert.equal(await ensureCli(variant('fakecli-p3'), dir, 'linux/arm64'), false);
		assert.deepEqual(seen, ['latest:plan9/x64', 'fallback:plan9/x64', 'latest:linux/arm64', 'fallback:linux/arm64']);
		assert.equal(fetches, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('a failed CLI install surfaces its reason through sign-in', async () => {
	const { mkdtemp, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { ensureCli, localSignIn } = await import('../src/providers/acp/local-cli.ts');
	const { release: _release, ...base } = devinAgent;
	const dir = await mkdtemp(join(tmpdir(), 'anton-cli-'));
	const agent = {
		...base,
		id: 'badcli',
		command: ['badcli-acp-test', 'acp'],
		install: {
			fallback: () => ({ version: '0', url: 'http://unused.invalid/x.tgz' }),
			fetch: async () => {
				throw new Error('boom');
			},
		},
	};
	try {
		assert.equal(await ensureCli(agent, dir), false);
		await assert.rejects(localSignIn(agent), /CLI is not installed.*boom/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('devin plan status maps only populated quota fields to windows', async () => {
	const { statusWindows } = await import('../src/providers/acp/devin-usage.ts');
	// A Pro/quota account: daily percent + reset times, unlimited prompt credits,
	// no weekly percent, no ACU — only the daily window may appear.
	assert.deepEqual(
		statusWindows({
			dailyQuotaRemainingPercent: 100,
			dailyQuotaResetAtUnix: '1795248000',
			weeklyQuotaResetAtUnix: '1795334400',
			availablePromptCredits: -1,
			overageBalanceMicros: '-973954',
		}),
		[{ label: 'Devin · Daily', usedPercent: 0, resetsAt: '2026-11-21T08:00:00.000Z', limited: false }],
	);
	// Credit and ACU tiers populate their own fields instead.
	const credit = statusWindows({
		weeklyQuotaRemainingPercent: 25,
		weeklyQuotaResetAtUnix: 1795334400,
		usedPromptCredits: 30,
		availablePromptCredits: 100,
		usedFlowCredits: 5,
		availableFlowCredits: 10,
		acuConsumed: 40,
		acuLimit: 200,
	});
	assert.deepEqual(
		credit.map((w) => [w.label, w.usedPercent, w.limited]),
		[
			['Devin · Weekly', 75, false],
			['Devin · Prompt credits', 30, false],
			['Devin · Flow credits', 50, false],
			['Devin · ACU', 20, false],
		],
	);
	// Exhausted quota marks limited; an empty status reports nothing.
	assert.equal(statusWindows({ dailyQuotaRemainingPercent: 0 })?.[0]?.limited, true);
	assert.deepEqual(statusWindows({}), []);
	assert.deepEqual(statusWindows(undefined), []);
});

test('devinUsage posts the CLI credential in metadata and returns plan windows', async () => {
	const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { devinUsage } = await import('../src/providers/acp/devin-usage.ts');
	const dir = await mkdtemp(join(tmpdir(), 'anton-devin-'));
	const credentialFile = join(dir, 'credentials.toml');
	await writeFile(credentialFile, 'windsurf_api_key = "test-key"\n');
	const agent = { ...devinAgent, auth: { ...devinAgent.auth, credentialFile } };
	const realFetch = globalThis.fetch;
	const seen: Request[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		seen.push(request.clone());
		return new Response(
			JSON.stringify({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 40, dailyQuotaResetAtUnix: '1795248000' } } }),
			{ headers: { 'content-type': 'application/json' } },
		);
	}) as typeof fetch;
	try {
		const windows = await devinUsage(agent, 'test-version');
		assert.equal(windows?.[0]?.label, 'Devin · Daily');
		assert.equal(windows?.[0]?.usedPercent, 60);
		assert.equal(seen.length, 1);
		const body = (await seen[0].json()) as { metadata?: { apiKey?: string } };
		assert.equal(body.metadata?.apiKey, 'test-key');
	} finally {
		globalThis.fetch = realFetch;
		await rm(dir, { recursive: true, force: true });
	}
});

test('the MCP server serves the live tool list and announces changes', async () => {
	const { mcpServer } = await import('../src/providers/acp/mcp.ts');
	const pending: string[] = [];
	const out: string[] = [];
	let wake: (() => void) | null = null;
	const transport = {
		write: (data: string) => out.push(data),
		lines: async function* () {
			for (;;) {
				while (pending.length) yield pending.shift()!;
				await new Promise<void>((resolve) => (wake = resolve));
				wake = null;
			}
		},
		closeStdin: async () => {},
		kill: async () => {},
	};
	const feed = (msg: unknown) => {
		pending.push(`${JSON.stringify(msg)}\n`);
		wake?.();
	};
	const waitFor = async (pred: () => boolean) => {
		for (let i = 0; i < 200; i++) {
			if (pred()) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error('timed out waiting for the MCP server');
	};
	let nextId = 0;
	const listed = async () => {
		const id = ++nextId;
		feed({ jsonrpc: '2.0', id, method: 'tools/list' });
		await waitFor(() => out.some((line) => line.includes(`"id":${id}`)));
		const reply = JSON.parse(out.find((line) => line.includes(`"id":${id}`))!) as { result: { tools: { name: string }[] } };
		return reply.result.tools.map((tool) => tool.name);
	};

	let tools = [{ name: 'read', description: 'Reads.', inputSchema: { type: 'object' } }];
	const server = mcpServer(transport, () => tools, async () => ({ content: [], isError: false }));
	assert.deepEqual(await listed(), ['read']);

	tools = [...tools, { name: 'write', description: 'Writes.', inputSchema: { type: 'object' } }];
	server.toolsChanged();
	await waitFor(() => out.some((line) => line.includes('list_changed')));
	assert.deepEqual(await listed(), ['read', 'write']);
	server.close();
});

test('readUsage takes cached tokens out of an input total that already holds them', async () => {
	const { readUsage } = await import('../src/providers/acp/runtime.ts');
	// Devin's numbers from a prod call: 22,707 in, 22,528 of them cached.
	assert.deepEqual(readUsage({ 'cognition.ai/inputTokens': 22_707, 'cognition.ai/cachedReadTokens': 22_528, 'cognition.ai/outputTokens': 201 }, 'cognition.ai'), {
		input: 179,
		output: 201,
		cacheRead: 22_528,
		cacheWrite: 0,
	});
	assert.deepEqual(readUsage({ used: 50_000, size: 262_144 }), { input: 50_000, output: 0, cacheRead: 0, cacheWrite: 0, occupancy: true });
	assert.equal(readUsage({ sessionUpdate: 'usage_update' }), null);
});

test('readUsage counts reasoning as output unless the grand total already holds it', async () => {
	const { readUsage } = await import('../src/providers/acp/runtime.ts');
	assert.equal(readUsage({ inputTokens: 1000, outputTokens: 40, thoughtTokens: 60, totalTokens: 1100 })?.output, 100);
	assert.equal(readUsage({ inputTokens: 1000, outputTokens: 40, thoughtTokens: 60 })?.output, 100);
	assert.equal(readUsage({ inputTokens: 1000, outputTokens: 100, thoughtTokens: 60, totalTokens: 1100 })?.output, 100);
});

test('settle leaves the last step what the turn total has that its steps did not book', async () => {
	const { settle } = await import('../src/providers/acp/runtime.ts');
	const total = { input: 30_000, output: 900, cacheRead: 120_000, cacheWrite: 0 };
	// Earlier steps booked 100K of context as input; 70K of it was cached, so it comes off the cache read.
	assert.deepEqual(settle(total, { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 }), { input: 0, output: 900, cacheRead: 50_000, cacheWrite: 0 });
	assert.deepEqual(settle(total, { input: 10_000, output: 0, cacheRead: 0, cacheWrite: 0 }), { input: 20_000, output: 900, cacheRead: 120_000, cacheWrite: 0 });
	assert.deepEqual(settle(total, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), total);
});

test('an agent that reports only each call\'s context gets the turn\'s output and cache on its last step', async () => {
	const delivered: RuntimeToolOutput[] = [];
	const { acp, mcp, conv, seen } = rig(async () => {
		await until(() => delivered.length > 0, 'a tool result');
		return delivered.shift()!;
	});
	conv.send([{ type: 'text', text: 'hi' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'devin-browser' }] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', { sessionId: 's', configOptions: [{ id: 'model', currentValue: 'swe-2-high', options: [{ value: 'swe-2-high' }] }] });
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	const promptId = parse(acp.sent).find((m) => m.method === 'session/prompt')!.id;
	const deltas = () => seen.filter((e): e is Extract<RuntimeEvent, { type: 'message_delta' }> => e.type === 'message_delta');
	// The first call's context arrives while the session's own note keeps a step open.
	acp.incoming.push(update('s', { sessionUpdate: 'usage_update', used: 20_000, size: 1_000_000 }));
	await until(() => deltas().length === 1, 'the first call\'s context');
	const called = mcpCall(mcp, 'bash', { command: 'ls' });
	await until(() => seen.some((e) => e.type === 'message_stop'), 'the tool step to close');
	delivered.push({ content: [{ type: 'text', text: 'ok' }], isError: false });
	await called;
	// The second call reports before any output, between steps: it opens that call's step rather than being lost.
	const startsBefore = seen.filter((e) => e.type === 'message_start').length;
	acp.incoming.push(update('s', { sessionUpdate: 'usage_update', used: 25_000, size: 1_000_000 }));
	await until(() => seen.filter((e) => e.type === 'message_start').length === startsBefore + 1, 'the second call\'s step');
	// Its 20K shared with the call before is booked as read from the cache.
	assert.deepEqual(seen.at(-1), { type: 'message_delta', stopReason: null, usage: { input: 5000, output: 0, cacheRead: 20_000, cacheWrite: 0 } });
	const again = mcpCall(mcp, 'bash', { command: 'pwd' });
	await until(() => seen.filter((e) => e.type === 'message_stop').length === 2, 'the second tool step to close');
	delivered.push({ content: [{ type: 'text', text: 'ok' }], isError: false });
	await again;
	acp.incoming.push(update('s', { sessionUpdate: 'usage_update', used: 30_000, size: 1_000_000 }));
	acp.incoming.push(chunk('s', 'agent_message_chunk', 'Done.'));
	acp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 75_000, cachedReadTokens: 45_000, outputTokens: 300, thoughtTokens: 200, totalTokens: 75_500 } } }));
	await until(() => seen.some((e) => e.type === 'turn_end'), 'turn_end');
	// The steps booked 45K of context, 20K of it cached: the last step has the other 30K, 25K of it the rest of the cache.
	assert.deepEqual(deltas().at(-1)?.usage, { input: 5000, output: 500, cacheRead: 25_000, cacheWrite: 0 });
	// Each step's usage as the bridge folds it: every delta in the step assigned over the one before.
	const steps: Partial<Record<string, number>>[] = [];
	for (const e of seen) {
		if (e.type === 'message_start') steps.push({ ...e.usage });
		if (e.type === 'message_delta') Object.assign(steps.at(-1)!, e.usage);
	}
	const sum = (key: string) => steps.reduce((n, u) => n + (u[key] ?? 0), 0);
	assert.equal(sum('cacheRead'), 45_000, 'the turn reads as cached as its total says');
	assert.equal(sum('input'), 30_000);
	assert.equal(sum('output'), 500);
	conv.close();
});

test('a turn measured call by call does not book its summed total onto the last step', async () => {
	const { acp, conv, seen } = rig(async () => ({ content: [], isError: false }));
	conv.send([{ type: 'text', text: 'hi' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'devin-browser' }] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', { sessionId: 's', configOptions: [{ id: 'model', currentValue: 'swe-2-high', options: [{ value: 'swe-2-high' }] }] });
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	const promptId = parse(acp.sent).find((m) => m.method === 'session/prompt')!.id;
	acp.incoming.push(update('s', { sessionUpdate: 'usage_update', used: 30_000, size: 262_144, _meta: { 'cognition.ai/inputTokens': 30_000, 'cognition.ai/cachedReadTokens': 29_000, 'cognition.ai/outputTokens': 50 } }));
	acp.incoming.push(chunk('s', 'agent_message_chunk', 'Hello.'));
	acp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 900_000, cachedReadTokens: 880_000, outputTokens: 4000 } } }));
	await until(() => seen.some((e) => e.type === 'turn_end'), 'turn_end');
	const deltas = seen.filter((e): e is Extract<RuntimeEvent, { type: 'message_delta' }> => e.type === 'message_delta');
	assert.deepEqual(deltas[0]?.usage, { input: 1000, output: 50, cacheRead: 29_000, cacheWrite: 0 });
	assert.deepEqual(deltas.at(-1)?.usage, {}, 'the turn total is not added on top');
	conv.close();
});

test('an agent that reports only its turn total still gets it, and a turn ending after a tool result answers that step', async () => {
	const delivered: RuntimeToolOutput[] = [];
	const { acp, mcp, conv, seen } = rig(async () => {
		await until(() => delivered.length > 0, 'a tool result');
		return delivered.shift()!;
	});
	conv.send([{ type: 'text', text: 'hi' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'devin-browser' }] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', { sessionId: 's', configOptions: [{ id: 'model', currentValue: 'swe-2-high', options: [{ value: 'swe-2-high' }] }] });
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	const promptId = parse(acp.sent).find((m) => m.method === 'session/prompt')!.id;
	const called = mcpCall(mcp, 'bash', { command: 'ls' });
	await until(() => seen.some((e) => e.type === 'message_stop'), 'the tool step to close');
	delivered.push({ content: [{ type: 'text', text: 'ok' }], isError: false });
	await called;
	const stopsBefore = seen.filter((e) => e.type === 'message_stop').length;
	acp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 20 } } }));
	await until(() => seen.some((e) => e.type === 'turn_end'), 'turn_end');
	assert.equal(seen.filter((e) => e.type === 'message_stop').length, stopsBefore + 1, 'the last step gets its own closing message');
	const last = [...seen].reverse().find((e): e is Extract<RuntimeEvent, { type: 'message_delta' }> => e.type === 'message_delta');
	assert.deepEqual(last?.usage, { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 });
	conv.close();
});

test('ping and tools/list still answer while a tools/call is parked', async () => {
	let release: (output: RuntimeToolOutput) => void = () => undefined;
	const { acp, mcp, conv } = rig(() => new Promise((resolve) => (release = resolve)));
	conv.send([{ type: 'text', text: 'hi' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', { sessionId: 's', configOptions: [] });
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	const parked = mcpCall(mcp, 'bash', { command: 'sleep 600' });
	await until(() => parse(mcp.sent).some((m) => m.id === 101), 'tools/list before the call');
	await sleep(20);
	mcp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: 200, method: 'ping' }));
	mcp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: 201, method: 'tools/list', params: {} }));
	await until(() => parse(mcp.sent).some((m) => m.id === 200) && parse(mcp.sent).some((m) => m.id === 201), 'ping and tools/list during the call');
	release({ content: [{ type: 'text', text: 'done' }], isError: false });
	await parked;
	conv.close();
});

test('a message sent while the agent waits on a tool goes back with that tool\'s result', async () => {
	let release: (output: RuntimeToolOutput) => void = () => undefined;
	const { acp, mcp, conv } = rig(() => new Promise((resolve) => (release = resolve)));
	conv.send([{ type: 'text', text: 'push the fix' }]);
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', { sessionId: 's', configOptions: [] });
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	const parked = mcpCall(mcp, 'bash', { command: 'git status' });
	await sleep(30);
	// The bridge's order: the result first, then the user's words, in one go.
	release({ content: [{ type: 'text', text: 'clean' }], isError: false });
	conv.send([{ type: 'text', text: "Don't use GitHub directly" }]);
	const reply = (await parked).result as { content: { type: string; text: string }[] };
	assert.equal(reply.content[0]?.text, 'clean');
	assert.match(reply.content[1]?.text ?? '', /Don't use GitHub directly/);
	await sleep(20);
	assert.equal(parse(acp.sent).filter((m) => m.method === 'session/prompt').length, 1, 'no second prompt waits behind the turn');
	conv.close();
});

test('signing out drains compute, and a status check never touches it', async () => {
	let drained = 0;
	let spawned = 0;
	const runtime = acpRuntime(devinAgent, fakeAccount(), {
		spawn: async () => {
			spawned += 1;
			throw new Error('unused');
		},
		drain: () => void (drained += 1),
	});
	await runtime.status();
	await runtime.listModels();
	assert.equal(spawned, 0);
	await runtime.signOut!();
	assert.equal(drained, 1);
});

test('the agent\'s file reads become Anton tool steps, and Anton\'s instructions open the first prompt', async () => {
	const READ: RuntimeTool = { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } };
	const calls: string[] = [];
	const acp = fakeChannel();
	const mcp = fakeChannel();
	const proc: AcpProcess = { acp: acp.transport, mcp: mcp.transport, writeFile: async () => undefined, close: async () => undefined, stderrTail: () => '' };
	const conv = acpRuntime(devinAgent, fakeAccount(), { spawn: async () => proc }).open({
		model: 'swe-2-high',
		instructions: 'Be brief.',
		tools: [READ],
		effort: null,
		callTool: async (_id, name) => {
			calls.push(name);
			return { content: [{ type: 'text', text: 'export const a = 1;' }], isError: false };
		},
	});
	const seen: RuntimeEvent[] = [];
	void (async () => {
		for await (const event of conv.events) seen.push(event);
	})();
	conv.send([{ type: 'text', text: 'hi' }]);
	await until(() => parse(acp.sent).some((m) => m.method === 'initialize'), 'initialize');
	const init = parse(acp.sent).find((m) => m.method === 'initialize')!.params as { clientCapabilities: unknown };
	assert.deepEqual(init.clientCapabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
	await answer(acp, 'initialize', { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
	await answer(acp, 'authenticate', {});
	await answer(acp, 'session/new', { sessionId: 's', configOptions: [] });
	await until(() => parse(acp.sent).some((m) => m.method === 'session/prompt'), 'session/prompt');
	const prompt = parse(acp.sent).find((m) => m.method === 'session/prompt')!.params as { prompt: { text?: string }[] };
	assert.match(prompt.prompt[0]?.text ?? '', /<instructions>\nBe brief\.\n\n.*cannot see the repository.*\n<\/instructions>/);
	assert.equal(prompt.prompt[1]?.text, 'hi');

	acp.incoming.push(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'fs/read_text_file', params: { sessionId: 's', path: '/work/src/a.ts' } }));
	await until(() => parse(acp.sent).some((m) => m.id === 900), 'the read answer');
	assert.deepEqual(parse(acp.sent).find((m) => m.id === 900)?.result, { content: 'export const a = 1;' });
	assert.deepEqual(calls, ['read']);
	const use = seen.find((e): e is Extract<RuntimeEvent, { type: 'block_start' }> => e.type === 'block_start' && e.block.type === 'tool_use');
	assert.equal(use?.block.type === 'tool_use' && use.block.name, 'read');
	const json = seen.find((e): e is Extract<RuntimeEvent, { type: 'block_delta' }> => e.type === 'block_delta' && Boolean(e.json));
	assert.equal(json?.json, '{"path":"src/a.ts"}');
	conv.close();
});
