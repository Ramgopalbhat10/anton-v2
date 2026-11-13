import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { missesText, providerUsage, runConversations, traceConversations } from '../scripts/cache-misses.ts';
import { CACHE_LIFETIMES, type CacheCall, cacheLifetime, cacheMisses, callsFromTraces, DEFAULT_CACHE_MS, missClass, missSummary } from '../src/core/prompt-cache.ts';
import type { ModelSpan, Trace } from '../src/core/trace.ts';

const SECOND = 1_000;
const MINUTE = 60_000;
const GPT = 'openai/gpt-6.1-terra[872k]';
const SONNET = 'openrouter/anthropic/claude-sonnet-5.5';

/** A call sending `input` tokens in all, `cached` of them read from the cache, ending at `end`. */
function call(number: number, input: number, cached: number, end: number, extra: Partial<CacheCall> = {}): CacheCall {
	return {
		task: 'made-up-task',
		reply: 'r1',
		number,
		model: GPT,
		usage: { input: input - cached, output: 100, cacheRead: cached, cacheWrite: 0, cost: 0 },
		prompt: 'p1',
		toolset: 't1',
		start: end - 2 * SECOND,
		end,
		compacted: false,
		...extra,
	};
}

test('a provider’s cache lasts by its maker: OpenAI’s ten minutes, Anthropic’s and any other’s five', () => {
	assert.equal(cacheLifetime(GPT), 10 * MINUTE);
	assert.equal(cacheLifetime('openrouter/openai/gpt-5.5'), CACHE_LIFETIMES.openai);
	assert.equal(cacheLifetime('opencode-go/gpt-5.5'), CACHE_LIFETIMES.openai);
	assert.equal(cacheLifetime(SONNET), 5 * MINUTE);
	assert.equal(cacheLifetime('vercel/anthropic/claude-haiku-5.5'), CACHE_LIFETIMES.anthropic);
	assert.equal(cacheLifetime('openrouter/~deepseek/deepseek-flash-latest'), DEFAULT_CACHE_MS);
	assert.equal(DEFAULT_CACHE_MS, 5 * MINUTE);
});

test('a call misses when it reads under half of what the call before it sent, and the miss is told by its cause', () => {
	const first = call(1, 10_000, 0, 0);
	const at = (gap: number) => first.end + gap + 2 * SECOND;
	assert.equal(missClass(call(2, 12_000, 9_800, at(SECOND)), first), null, 'a hit');
	assert.equal(missClass(call(2, 12_000, 5_000, at(SECOND)), first), null, 'half of the previous input read');
	assert.equal(missClass(call(2, 3_500, 0, at(SECOND)), call(1, 3_000, 0, 0)), null, 'a previous call too small to count');
	assert.equal(missClass(call(2, 12_000, 0, at(SECOND)), first), 'provider miss');
	assert.equal(missClass(call(2, 12_000, 4_000, at(SECOND)), first), 'older prefix');
	assert.equal(missClass(call(2, 12_000, 0, at(4 * MINUTE)), first), 'provider miss', 'a wait on a subagent, within the lifetime');
	assert.equal(missClass(call(2, 12_000, 0, at(11 * MINUTE)), first), 'expired');
	assert.equal(missClass(call(2, 12_000, 0, at(6 * MINUTE), { model: SONNET }), { ...first, model: SONNET }), 'expired', 'Anthropic’s five minutes');
	assert.equal(missClass(call(2, 12_000, 0, at(6 * MINUTE)), first), 'provider miss', 'OpenAI’s ten');
	assert.equal(missClass(call(2, 12_000, 2_000, at(SECOND), { prompt: 'p2' }), first), 'prompt changed');
	assert.equal(missClass(call(2, 12_000, 0, at(SECOND), { toolset: 't2' }), first), 'tools changed');
	assert.equal(missClass(call(2, 12_000, 0, at(SECOND), { prompt: 'p2', toolset: 't2' }), first), 'prompt changed', 'the prompt first, as cacheVerdict names it first');
	assert.equal(missClass(call(2, 12_000, 0, at(SECOND), { model: SONNET }), first), 'model changed');
	assert.equal(missClass(call(2, 6_000, 0, at(SECOND), { compacted: true }), first), 'compacted');
	assert.equal(missClass(call(2, 6_000, 1_000, at(SECOND)), first), 'pruned', 'the conversation shrank with no compaction');
	assert.equal(missClass(call(2, 6_000, 4_000, at(SECOND)), first), null, 'a smaller conversation read mostly from the cache');
	assert.equal(missClass({ ...call(2, 12_000, 0, at(SECOND)), usage: null }, first), null, 'no usage');
});

test('each miss agrees with the trace’s verdict of the call', () => {
	const calls = [
		call(1, 10_000, 0, 0),
		call(2, 12_000, 0, 3 * SECOND),
		call(3, 14_000, 4_000, 6 * SECOND),
		call(4, 16_000, 2_000, 9 * SECOND, { prompt: 'p2' }),
		call(5, 18_000, 0, 12 * SECOND, { prompt: 'p2', toolset: 't2' }),
		call(6, 20_000, 0, 15 * MINUTE, { prompt: 'p2', toolset: 't2' }),
		call(7, 22_000, 19_000, 15 * MINUTE + 3 * SECOND, { prompt: 'p2', toolset: 't2' }),
	];
	const misses = cacheMisses(calls);
	assert.deepEqual(
		misses.map((miss) => [miss.call.number, miss.class, miss.verdict.label, miss.next?.number ?? null]),
		[
			[2, 'provider miss', 'Miss', 3],
			[3, 'older prefix', 'Partial · 29%', 4],
			[4, 'prompt changed', 'Partial · 13%', 5],
			[5, 'tools changed', 'Miss', 6],
			[6, 'expired', 'Miss', 7],
		],
	);
	assert.match(misses[2].verdict.why, /system prompt changed/);
	assert.match(misses[3].verdict.why, /tool list changed/);
	assert.match(misses[0].verdict.why, /prefix held/);
	assert.equal(misses[4].gapMs, 15 * MINUTE - 2 * SECOND - 12 * SECOND);
});

test('the summary counts calls, misses by class and what the misses sent uncached, for each model', () => {
	const gpt = [call(1, 10_000, 0, 0), call(2, 12_000, 0, 3 * SECOND), call(3, 14_000, 4_000, 6 * SECOND), call(4, 15_000, 13_500, 9 * SECOND)];
	const sonnet = [call(1, 8_000, 0, 0, { model: SONNET }), call(2, 9_000, 0, 10 * MINUTE, { model: SONNET })];
	const summary = missSummary([gpt, sonnet]);
	assert.deepEqual(
		{ calls: summary.calls, misses: summary.misses, byClass: summary.byClass, uncached: summary.uncached },
		{ calls: 6, misses: 3, byClass: { 'provider miss': 1, 'older prefix': 1, expired: 1 }, uncached: 12_000 + 10_000 + 9_000 },
	);
	assert.deepEqual(
		summary.models.map(({ model, calls, misses, uncached }) => [model, calls, misses, uncached]),
		[
			[GPT, 4, 2, 22_000],
			[SONNET, 2, 1, 9_000],
		],
	);
});

/** A main-lane model span, `start` milliseconds into its reply. */
function span(id: string, start: number, input: number, cached: number, extra: Partial<ModelSpan> = {}): ModelSpan {
	return {
		kind: 'model',
		id,
		lane: 'main',
		start,
		durationMs: 2_000,
		error: null,
		purpose: 'agent',
		model: GPT,
		served: null,
		usage: { input: input - cached, output: 50, cacheRead: cached, cacheWrite: 0, cost: 0 },
		parts: { systemPrompt: 0, skills: 0, tools: 0, mcpTools: 0, messages: 0 },
		messages: 2,
		added: [],
		addedMore: 0,
		prompt: 'p1',
		toolset: 't1',
		output: { text: '', thinking: '', toolCalls: [] },
		finish: 'toolUse',
		...extra,
	};
}
const trace = (id: string, startedAt: string, spans: Trace['spans']): Trace => ({ id, sessionId: 'task-a', startedAt, durationMs: 60_000, model: GPT, spans, prompts: {}, toolsets: {}, dropped: 0 });

const TRACES = [
	trace('reply-1', '2026-11-01T10:00:00.000Z', [
		span('m1', 0, 10_000, 0),
		span('s1', 3_000, 9_000, 0, { lane: 'sub-1' }),
		span('m2', 6_000, 12_000, 0),
		span('m3', 9_000, 13_000, 0, { error: 'failed', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }),
		{ kind: 'compaction', id: 'c1', lane: 'main', start: 12_000, durationMs: 4_000, error: null, reason: 'threshold', tokensBefore: 13_000, messagesBefore: 20, messagesAfter: 4 },
		span('sum', 12_500, 13_000, 0, { purpose: 'compaction' }),
		span('m4', 17_000, 5_000, 0),
	]),
	trace('reply-2', '2026-11-01T12:00:00.000Z', [span('m5', 0, 6_000, 0, { prompt: 'p2' }), span('m6', 4_000, 7_000, 5_900, { prompt: 'p2' })]),
];

test('the calls of a task’s traces are its main agent’s, oldest reply first, with compactions and failed calls told', () => {
	const calls = callsFromTraces('task-a', TRACES);
	assert.deepEqual(
		calls.map((entry) => [entry.reply, entry.number, entry.compacted, entry.prompt]),
		[
			['reply-1', 1, false, 'p1'],
			['reply-1', 2, false, 'p1'],
			['reply-1', 3, true, 'p1'],
			['reply-2', 1, false, 'p2'],
			['reply-2', 2, false, 'p2'],
		],
	);
	assert.equal(calls[1].start, Date.parse('2026-11-01T10:00:06.000Z'));
	assert.equal(calls[1].end, Date.parse('2026-11-01T10:00:08.000Z'));
	assert.deepEqual(
		cacheMisses(calls).map((miss) => [miss.call.reply, miss.call.number, miss.class]),
		[
			['reply-1', 2, 'provider miss'],
			['reply-1', 3, 'compacted'],
			['reply-2', 1, 'prompt changed'],
		],
	);
});

test('the traces are read from the database: the tasks traced latest, or those named, and none when it holds none', async () => {
	const db = createClient({ url: ':memory:' });
	assert.deepEqual(await traceConversations(db), [], 'a database with no traces table');
	await db.execute('CREATE TABLE response_traces (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL, trace_json TEXT NOT NULL)');
	assert.deepEqual(await traceConversations(db), [], 'and with no traces');
	// Saved out of order, as replies of two tasks interleave.
	for (const saved of [TRACES[1], TRACES[0], { ...trace('other-1', '2026-11-01T11:00:00.000Z', [span('o1', 0, 9_000, 0)]), sessionId: 'task-b' }]) {
		await db.execute({ sql: 'INSERT INTO response_traces VALUES (?, ?, ?, ?)', args: [saved.id, saved.sessionId, saved.startedAt, JSON.stringify(saved)] });
	}
	const latest = await traceConversations(db, { latest: 1 });
	assert.deepEqual(
		latest.map((calls) => calls.map((entry) => `${entry.task}/${entry.reply}#${entry.number}`)),
		[['task-a/reply-1#1', 'task-a/reply-1#2', 'task-a/reply-1#3', 'task-a/reply-2#1', 'task-a/reply-2#2']],
	);
	assert.deepEqual((await traceConversations(db, { tasks: ['task-b'] })).map((calls) => calls.length), [1]);
	assert.deepEqual((await traceConversations(db, { since: new Date('2026-11-01T11:30:00.000Z') })).map((calls) => calls[0].task), ['task-a']);
	db.close();
});

/** A benchmark's provider usage of one response: the system message first among its items. */
const usageLine = (id: string, input: number, cached: number, system = 1_700, tools = 1_700) =>
	JSON.stringify({
		id,
		usage: {
			input_tokens: input,
			output_tokens: 80,
			input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
			attribution: { request_fields: { tools: { input_tokens: tools, cached_tokens: 0 } }, items: { msg_system: { input_tokens: system, cached_tokens: 0 }, msg_user: { input_tokens: input - system - tools, cached_tokens: 0 } } },
		},
	});
const turn = (response: string, at: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ type: 'turn', purpose: 'agent', durationMs: 2_000, request: { providerId: 'openai', requestedModel: 'gpt-6.1-terra[872k]', api: 'openai-responses' }, response: { responseId: response }, conversationId: 'conv-1', submissionId: 'sub-1', agentName: 'Coder', timestamp: at, ...extra });

test('a benchmark’s events and provider usage give the same calls, its token counts standing for the prompt’s keys', async () => {
	const usage = providerUsage(
		[usageLine('r1', 9_000, 0), usageLine('r2', 11_000, 0), usageLine('r3', 13_000, 4_000), usageLine('sub', 8_000, 0), usageLine('r4', 15_000, 12_900), usageLine('r5', 16_000, 1_000, 1_716)].join('\n'),
	);
	assert.deepEqual(usage.get('r3'), { usage: { input: 9_000, output: 80, cacheRead: 4_000, cacheWrite: 0, cost: 0 }, prompt: 'system 1700 tokens', toolset: 'tools 1700 tokens' });
	const events = [
		turn('r1', '2026-11-01T10:00:02.000Z'),
		JSON.stringify({ type: 'tool_start', toolName: 'bash', timestamp: '2026-11-01T10:00:02.100Z' }),
		turn('r2', '2026-11-01T10:00:05.000Z'),
		turn('sub', '2026-11-01T10:00:06.000Z', { taskId: 'task_1' }),
		turn('r3', '2026-11-01T10:00:08.000Z'),
		turn('failed', '2026-11-01T10:00:09.000Z'),
		turn('r4', '2026-11-01T10:00:12.000Z'),
		turn('r5', '2026-11-01T14:00:00.000Z', { submissionId: 'sub-2' }),
		'',
	];
	const { conversations, uncounted } = await runConversations('made-up-task', events, usage);
	assert.equal(uncounted, 1);
	assert.deepEqual(
		conversations.map((calls) => calls.map((entry) => `${entry.reply}#${entry.number}`)),
		[['sub-1#1', 'sub-1#2', 'sub-1#3', 'sub-1#4', 'sub-2#1']],
	);
	assert.equal(conversations[0][0].model, 'openai/gpt-6.1-terra[872k]');
	assert.equal(conversations[0][1].start, Date.parse('2026-11-01T10:00:03.000Z'));
	assert.deepEqual(
		conversations.flatMap(cacheMisses).map((miss) => [miss.call.number, miss.class]),
		[
			[2, 'provider miss'],
			[3, 'older prefix'],
			[1, 'prompt changed'],
		],
	);
	const text = missesText(conversations);
	assert.match(text, /^task\s+call\s+gap s\s+previous\s+input\s+cached\s+next cached\s+class$/m);
	assert.match(text, /^made-up-task\s+#2\s+1\.0\s+9,000\s+11,000\s+0\s+4,000\s+provider miss$/m);
	assert.match(text, /^made-up-task\s+#1\s+14386\.0\s+15,000\s+16,000\s+1,000\s+-\s+prompt changed$/m);
	assert.match(text, /^5 calls, 3 misses \(60\.0%\)\n\s+1\s+prompt changed\n\s+1\s+older prefix\n\s+1\s+provider miss\n\s+35,000 input tokens the misses sent uncached$/m);
	assert.doesNotMatch(text, /openai\/gpt-6\.1-terra\[872k\]:/, 'one model, so no breakdown by model');
	assert.equal(missesText([]), 'No model calls of the main agent to read.');
});

test('cache:misses is an npm script', () => {
	assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts['cache:misses'], 'node --experimental-strip-types scripts/cache-misses.ts');
});
