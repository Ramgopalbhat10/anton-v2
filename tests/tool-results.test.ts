import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolResultCutInterceptor } from '../src/flue/tool-result-cut.ts';
import { cutResult, forgetResults, MAX_RESULT_BYTES, partAt, readFullResult } from '../src/services/tool-results.ts';

const result = (text: string, ...more: Array<Record<string, unknown>>) => ({ content: [{ type: 'text', text }, ...more], details: { customTool: 'web_fetch' } });
const page = (size: number) => Array.from({ length: Math.ceil(size / 10) }, (_, index) => String(index).padStart(9, '0') + '\n').join('').slice(0, size);

test('a result up to 50KB joins the conversation whole', () => {
	const small = result(page(MAX_RESULT_BYTES));
	assert.equal(cutResult('task', 'c1', 'web_fetch', small), small);
	assert.equal(cutResult('task', 'c1', 'web_fetch', 'not a result'), 'not a result');
});

test('a longer one keeps its first 50KB and a note, and the agent reads on from where it was cut', () => {
	forgetResults('task');
	const text = page(130_000);
	const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
	const cut = cutResult('task', 'call-1', 'connector_call', result(text, image));
	const [head, picture] = cut.content as Array<{ type: string; text?: string }>;
	assert.deepEqual(picture, image, 'pictures pass as they are');
	assert.equal(cut.details.customTool, 'web_fetch', 'what the thread shows is left alone');
	assert.ok(head.text!.startsWith(text.slice(0, MAX_RESULT_BYTES)));
	assert.match(head.text!, /\[Result cut at 50KB: characters up to 51,200 of 130,000 shown\. Call read_full_result with id "call-1" and offset 51200 for more, or ask the tool for less\.\]$/);

	const second = readFullResult('task', 'call-1', 51_200);
	assert.ok(second.startsWith(text.slice(51_200, 102_400)));
	assert.match(second, /offset 102400 for more/);
	const last = readFullResult('task', 'call-1', 102_400);
	assert.equal(last, text.slice(102_400), 'the last part has no note');
	assert.match(readFullResult('task', 'missing', 0), /^No result "missing" is kept/);
	assert.match(readFullResult('other', 'call-1', 0), /^No result/, 'each conversation reads only its own');
});

test('the runtime’s read and bash cut their own output, and reading on is never cut again', () => {
	const long = result(page(80_000));
	for (const tool of ['read', 'bash', 'read_full_result']) assert.equal(cutResult('task', 'c2', tool, long), long);
});

test('a cut never splits a character', () => {
	const text = 'é'.repeat(30_000);
	const part = partAt(text, 0);
	assert.ok(Buffer.byteLength(part) <= MAX_RESULT_BYTES);
	assert.equal(part, 'é'.repeat(25_600));
	assert.equal(partAt('😀😀', 0, 5), '😀', 'nor a surrogate pair');
});

test('only the agents’ own conversations are cut: a subagent’s calls and other work pass whole', async () => {
	const long = result(page(80_000));
	const run = (operation: Parameters<typeof toolResultCutInterceptor>[0], ctx: Parameters<typeof toolResultCutInterceptor>[1]) =>
		toolResultCutInterceptor(operation, ctx, async () => long);
	const tool = { type: 'tool' as const, toolCallId: 'c3', toolName: 'web_fetch' };
	assert.notEqual(await run(tool, { instanceId: 'task', session: 'default' }), long);
	assert.notEqual(await run(tool, { instanceId: 'project' }), long, 'a coordinator’s');
	assert.equal(await run(tool, { instanceId: 'task', taskId: 'browser-1', session: 'task:default:browser-1' }), long);
	assert.equal(await run(tool, { instanceId: 'task', harness: 'invocation-1' }), long);
	assert.equal(await run({ type: 'task', taskId: 'browser-1' }, { instanceId: 'task' }), long);
	assert.equal(await run(tool, {}), long);
});
