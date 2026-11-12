import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai';
import type { ModelInfo } from '../src/core/ports.ts';
import { devinProvider } from '../src/flue/devin-models.ts';
import { devinPlan } from '../src/providers/devin/plan.ts';
import { discoverDevinModels, runDevinWorker, type DevinModel } from '../src/providers/devin/worker.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-devin-test-'));
const script = path.join(dir, 'fake.mjs');
writeFileSync(script, `
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const request=JSON.parse(raw),send=x=>console.log(JSON.stringify(x));
if(request.mode==='hang'){setInterval(()=>{},1000);}
else if(request.mode==='bad'){console.log('not JSON');}
else if(request.mode==='crash'){process.exitCode=2;}
else if(request.mode==='secret'){send({type:'failure',message:'rejected '+request.key});}
else if(request.mode==='environment'){send({type:'environment',message:process.env.ANTON_DEVIN_TEST_SECRET??'absent'});send({type:'complete'});}
else if(request.mode==='events'){for(const event of request.events)send({type:'event',event});send({type:'complete'});}
else{send({type:'models',models:request.mode==='empty'?[]:[{id:'swe-2',name:'SWE-2'}]});send({type:'complete'});}
`);
const options = { executable: process.execPath, script, timeoutMs: 5000 };
after(() => rmSync(dir, { recursive: true, force: true }));

const spec = (id: string): DevinModel => ({ id, name: id === 'swe-2-flash' ? 'SWE-2 Flash' : 'SWE-2', contextWindow: 262144, maxTokens: 8192, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const info = (id = 'swe-2-flash'): ModelInfo => ({ id: `devin/${id}`, name: spec(id).name, vendor: 'Cognition', description: '', createdAt: 0, contextLength: 262144, maxOutput: 8192, vision: false, reasoning: [], defaultReasoning: 'off', price: spec(id).cost, subscription: 'Devin' });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test('Devin prefers SWE-2 Flash, offers SWE-2 fallback, and reuses validation discovery', async () => {
	let calls = 0;
	const plan = devinPlan(async () => { calls++; return [spec('swe-2'), spec('unrelated'), { ...spec('swe-2-flash'), requestModelId: 'swe-2-flash-medium' }]; });
	assert.deepEqual(await plan.check('test-key'), { email: null });
	const models = await plan.listModels('test-key');
	assert.deepEqual(models.map((m) => m.id), ['devin/swe-2-flash', 'devin/swe-2']);
	assert.equal(calls, 1);
	assert.equal(models[0].vendor, 'Cognition');
	assert.equal(models[0].requestModelId, 'swe-2-flash-medium', 'persist the callable wire id, not just the picker family');
	assert.deepEqual(models[0].reasoning, [], 'do not advertise unverified effort controls');
	await plan.listModels('test-key');
	assert.equal(calls, 2, 'an explicit refresh discovers again');
	assert.deepEqual((await devinPlan(async () => [spec('swe-2')]).listModels('other-key')).map((m) => m.id), ['devin/swe-2']);
	await assert.rejects(devinPlan(async () => { throw new Error('PAT rejected'); }).check('bad'), /PAT rejected/);
});

test('Devin worker uses private JSONL and does not inherit server credentials', async () => {
	assert.equal((await discoverDevinModels('not-a-real-key', options))[0].id, 'swe-2');
	process.env.ANTON_DEVIN_TEST_SECRET = 'server-only';
	try {
		const messages: string[] = [];
		await runDevinWorker({ action: 'models', key: 'not-a-real-key', mode: 'environment' }, (m) => messages.push(m.message!), undefined, options);
		assert.deepEqual(messages, ['absent']);
	} finally { delete process.env.ANTON_DEVIN_TEST_SECRET; }
	await assert.rejects(runDevinWorker({ action: 'models', key: 'not-a-real-key', mode: 'secret' }, () => {}, undefined, options), (error: Error) => error.message.includes('[redacted]') && !error.message.includes('not-a-real-key'));
});

test('Devin worker fails safely on missing binary, malformed output, exit, timeout and cancellation', async () => {
	await assert.rejects(runDevinWorker({ action: 'models', key: 'test' }, () => {}, undefined, { executable: '/not-installed/bun' }), /setup:devin/);
	for (const mode of ['bad', 'crash']) await assert.rejects(runDevinWorker({ action: 'models', key: 'test', mode }, () => {}, undefined, options), /invalid response|stopped before completing/);
	await assert.rejects(runDevinWorker({ action: 'models', key: 'test', mode: 'hang' }, () => {}, undefined, { ...options, timeoutMs: 100 }), /timed out/);
	const controller = new AbortController();
	const task = runDevinWorker({ action: 'models', key: 'test', mode: 'hang' }, () => {}, controller.signal, options);
	controller.abort();
	await assert.rejects(task, { name: 'AbortError' });
	await assert.rejects(runDevinWorker({ action: 'models', key: 'test' }, () => {}, controller.signal, options), { name: 'AbortError' });
});

const jwtFixture = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.signature';

test('Devin IPC preserves JWT fixtures in streamed text and executable tool arguments', async () => {
	const content = `export const token = '${jwtFixture}';\n`;
	const toolCall = { type: 'toolCall', id: 'write-fixture', name: 'write', arguments: { path: 'fixture.ts', content } };
	const partial = { role: 'assistant', content: [{ type: 'text', text: content }, toolCall] };
	const events = [
		{ type: 'text_delta', contentIndex: 0, delta: content, partial },
		{ type: 'toolcall_delta', contentIndex: 1, delta: JSON.stringify(toolCall.arguments), partial },
		{ type: 'toolcall_end', contentIndex: 1, toolCall, partial },
		{ type: 'done', reason: 'toolUse', message: partial },
	];
	const received: unknown[] = [];
	await runDevinWorker({ action: 'stream', key: 'not-a-real-key', mode: 'events', events }, (m) => received.push(m.event), undefined, options);
	assert.deepEqual(received, events, 'JSONL must not rewrite ordinary data, including serialized argument deltas');
});

test('Devin IPC still sanitizes error diagnostics without rewriting their content blocks', async () => {
	const key = 'quote"slash\\key';
	const diagnostic = `rejected ${key} with token ${jwtFixture}`;
	const event = { type: 'error', reason: 'error', error: { errorMessage: diagnostic, errorClassificationMessage: diagnostic, content: [{ type: 'text', text: jwtFixture }] } };
	const received: unknown[] = [];
	await runDevinWorker({ action: 'stream', key, mode: 'events', events: [event] }, (m) => received.push(m.event), undefined, options);
	assert.deepEqual(received, [{ ...event, error: { ...event.error, errorMessage: 'rejected [redacted] with token [redacted token]', errorClassificationMessage: 'rejected [redacted] with token [redacted token]' } }]);
	await assert.rejects(runDevinWorker({ action: 'models', key, mode: 'secret' }, () => {}, undefined, options), (error: Error) => error.message === 'rejected [redacted]');
});

test('Devin adapter streams pi events, preserves tool history, and never discovers models on a call', async () => {
	const models = createModels();
	let live = [info()];
	let requests = 0;
	models.setProvider(devinProvider(() => live, async () => 'test-key', async (request, receive) => {
		requests++;
		assert.equal(request.action, 'stream');
		assert.equal(request.key, 'test-key');
		assert.equal((request.context as { systemPrompt: string }).systemPrompt, 'Test prompt');
		const output = { role: 'assistant', content: [{ type: 'text', text: 'Ready.' }], api: 'devin-agent', provider: 'devin', model: 'swe-2-flash', stopReason: 'stop', timestamp: 0, usage };
		receive({ type: 'event', event: { type: 'start', partial: output } });
		receive({ type: 'event', event: { type: 'text_delta', contentIndex: 0, delta: 'Ready.', partial: output } });
		receive({ type: 'event', event: { type: 'done', reason: 'stop', message: output } });
	}));
	const model = models.getModel('devin', 'swe-2-flash');
	assert.ok(model);
	const context = { systemPrompt: 'Test prompt', messages: [{ role: 'user' as const, content: 'Say ready', timestamp: 0 }] };
	const output = await models.completeSimple(model, context);
	assert.equal(output.api, 'devin');
	assert.equal(output.stopReason, 'stop');
	assert.deepEqual(output.content, [{ type: 'text', text: 'Ready.' }]);
	assert.equal(requests, 1);
	live = [info('swe-2')];
	assert.ok(models.getModel('devin', 'swe-2'), 'catalog updates without restart');
});

test('Devin adapter closes the stream on worker failure or a missing terminal event', async () => {
	for (const run of [async () => { throw new Error('Worker refused request'); }, async () => {}]) {
		const models = createModels();
		models.setProvider(devinProvider(() => [info()], async () => 'test', run));
		const model = models.getModel('devin', 'swe-2-flash')!;
		const result = await models.completeSimple(model, { messages: [] });
		assert.equal(result.stopReason, 'error');
		assert.match(result.errorMessage!, /Worker refused|without a model response/);
	}
});
