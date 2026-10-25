import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { TextModel } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-web-digest-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { setProviders } = await import('../src/providers/index.ts');
const { digestPays, digestResult, objectiveOf, recordWebCall } = await import('../src/services/web-digest.ts');
const { readFullResult } = await import('../src/services/tool-results.ts');
const { toolResultCutInterceptor } = await import('../src/flue/tool-result-cut.ts');
const { config } = await import('../src/config.ts');
const { loadedModels } = await import('../src/services/models.ts');

/** The task's model and the digest model, priced per million tokens as OpenRouter lists them. */
const priced = (id: string, input: number, output: number, cacheRead: number, cacheWrite = input) =>
	({ id, name: id, vendor: 'Test', description: '', createdAt: 0, contextLength: 200_000, maxOutput: 32_000, price: { input, output, cacheRead, cacheWrite }, vision: false, reasoning: [], defaultReasoning: 'off' }) as ReturnType<typeof loadedModels>[number];
const sonnet = priced(config.model, 3, 15, 0.3, 3.75);
const flashLite = priced(config.webDigestModel, 0.25, 1.5, 0.025);
const MODELS = [sonnet, flashLite];
const digest = (id: string, toolName: string, value: unknown, models = MODELS) => digestResult('task', id, toolName, value, false, models);

const FETCH = 'mcp__web__web_fetch';
const page = (size: number) => Array.from({ length: Math.ceil(size / 10) }, (_, index) => String(index).padStart(9, '0') + '\n').join('').slice(0, size);
const result = (text: string) => ({ content: [{ type: 'text', text }] });
const textOf = (value: unknown) => (value as { content: Array<{ text: string }> }).content[0].text;

let prompts: string[] = [];
let answer: () => Promise<string> = async () => 'Flue 2.1 adds interceptors (https://example.com/flue).';
const writer: TextModel = {
	runs: () => true,
	write: async ({ prompt }) => {
		prompts.push(prompt);
		return { text: await answer(), inputTokens: 10_000, outputTokens: 40, cost: 0.01 };
	},
};
const useWriter = (text: TextModel | undefined) => setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, text });
const start = (toolCallId: string, args: unknown, toolName = FETCH) => recordWebCall({ type: 'tool_start', toolName, toolCallId, args });

beforeEach(() => {
	prompts = [];
	answer = async () => 'Flue 2.1 adds interceptors (https://example.com/flue).';
	useWriter(writer);
});

test('a web call’s objective and queries make its brief', () => {
	assert.equal(objectiveOf({ objective: ' What changed in Flue 2.1 ', search_queries: ['flue 2.1', ' ', 3] }), 'Objective: What changed in Flue 2.1\nQueries: flue 2.1');
	assert.equal(objectiveOf({ urls: ['https://example.com'] }), null);
	assert.equal(objectiveOf(undefined), null);
});

test('a long fetch is read out against its objective, and the whole is kept to read', async () => {
	const text = page(60_000);
	start('d1', { urls: ['https://example.com/flue'], objective: 'What changed in Flue 2.1' });
	const digested = await digest('d1', FETCH, result(text));
	assert.match(textOf(digested), /^Flue 2\.1 adds interceptors/);
	assert.match(textOf(digested), /\[The result ran to 60,000 characters; .* call read_full_result with id "d1" and offset 0\.\]$/);
	assert.equal(prompts.length, 1);
	assert.match(prompts[0], /Objective: What changed in Flue 2\.1/);
	assert.ok(readFullResult('task', 'd1', 0).startsWith(text.slice(0, 50_000)));
});

test('a short one, one without an objective, and one the model fails on are cut as before', async () => {
	start('d2', { objective: 'x' });
	const short = result(page(10_000));
	assert.equal(await digest('d2', FETCH, short), short);

	const long = page(60_000);
	assert.match(textOf(await digest('d3', FETCH, result(long))), /\[Result cut at 24KB/, 'no objective');

	start('d4', { objective: 'x' });
	answer = async () => {
		throw new Error('timed out');
	};
	assert.match(textOf(await digest('d4', FETCH, result(long))), /\[Result cut at 24KB/, 'the model failed');

	start('d5', { objective: 'x' });
	useWriter(undefined);
	assert.match(textOf(await digest('d5', FETCH, result(long))), /\[Result cut at 24KB/, 'no text model');
	assert.equal(prompts.length, 1, 'only the call the model failed on asked it');
});

test('a subagent takes the digest alone, or the start and end of the result', async () => {
	const long = page(60_000);
	const ctx = { instanceId: 'task', taskId: 'research-1', session: 'task:default:research-1' };
	start('s1', { objective: 'x' });
	const digested = await digestResult('task', 's1', FETCH, result(long), true, MODELS);
	assert.match(textOf(digested), /call the tool again with a narrower objective\.\]$/);
	assert.match(readFullResult('task', 's1', 0), /^No result/, 'nothing is kept for it');

	useWriter(undefined);
	start('s2', { objective: 'x' });
	const cut = textOf(await toolResultCutInterceptor({ type: 'tool', toolCallId: 's2', toolName: FETCH }, ctx, async () => result(long)));
	assert.ok(cut.startsWith(long.slice(0, 16_000)));
	assert.ok(cut.endsWith(long.slice(-8_000)));
	assert.match(cut, /characters of 60,000 left out here/);
});

test('a digest is written only when it costs less than the tokens it saves on the task’s model', async () => {
	const long = result(page(60_000));
	start('p1', { objective: 'x' });
	assert.match(textOf(await digest('p1', FETCH, long, [priced(config.model, 0.02, 1, 0.015), flashLite])), /\[Result cut at 24KB/, 'a model cheaper than the digest model');
	start('p2', { objective: 'x' });
	assert.match(textOf(await digest('p2', FETCH, long, [priced(config.model, 0, 0, 0), flashLite])), /\[Result cut at 24KB/, 'a plan model, with no price');
	assert.equal(prompts.length, 0);
	assert.equal(digestPays(sonnet, flashLite, 60_000, 22_000), true);
	assert.equal(digestPays(sonnet, flashLite, 120_000, 1_000), false, 'too little saved');
});
