import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdirSync } from 'node:fs';
import { patchFlue, patchFlueEach } from '../scripts/patch-flue.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-patch-flue-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const BROKEN = `const envRuntime = {
		swapDiscovery: async (nextEnv) => {
			workspaceContext = await discoverSessionContext(nextEnv, definition.skills);
		},
		rediscover: async (currentEnv) => {
			const fresh = await discoverSessionContext(currentEnv, definition.skills);
		}
	};
	let promptContext = await discoverSessionContext(env, definition.skills);`;

const TASK = `async createTaskSession(options) {
		const taskAgent = options.agent;
		const taskConfig = {
			model: taskModel,
			compaction: this.config.compaction
		};
	}`;

const TRANSACTION = `function createNodeTransactionSync(db) {
	return (closure) => {
		db.exec("BEGIN");
		try {
			const result = closure();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	};
}`;

const OPEN = `${TRANSACTION}
function openDatabase(path) {
	const db = new DatabaseSync(path);
	if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
}`;

const COMPACTION = `async runCompaction(reason) {
			const compactionConfig = this.config.compaction === false ? void 0 : this.config.compaction;
			const summarizationModel = compactionConfig?.model ? this.resolveModelForCall(compactionConfig.model) : sessionModel;
	}`;

const SUMMARY = `async function runSummarizationCall(purpose, promptText, maxTokens, model, signal, observer, errorPrefix) {
	const completionOptions = { maxTokens, signal };
	if (model.reasoning) completionOptions.reasoning = "high";
}
function assertCompaction(definition, label) {
	for (const key of Object.keys(definition)) if (key !== "reserveTokens" && key !== "keepRecentTokens" && key !== "model") throw new Error(\`[flue] \${label} compaction received unknown field "\${key}".\`);
}`;

/** A runtime laid out as Flue's is: the providers at the top, the Node adapter under node/. */
function runtime(name: string, providers: string, open = OPEN): URL {
	const dist = path.join(dir, name);
	mkdirSync(path.join(dist, 'node'), { recursive: true });
	writeFileSync(path.join(dist, 'other.mjs'), 'export const unrelated = 1;');
	writeFileSync(path.join(dist, 'builtin-providers-x.mjs'), providers);
	writeFileSync(path.join(dist, 'conversation-store-x.mjs'), COMPACTION);
	writeFileSync(path.join(dist, 'dispatch-x.mjs'), SUMMARY);
	writeFileSync(path.join(dist, 'node', 'index.mjs'), open);
	return pathToFileURL(`${dist}/`);
}

test('a sandbox started mid-reply finds its skills without the first render\'s, once and only once', async () => {
	const dist = runtime('skills', `${BROKEN}\n${TASK}`);
	assert.equal(await patchFlue(dist), 'patched');
	const patched = readFileSync(new URL('builtin-providers-x.mjs', dist), 'utf8');
	assert.match(patched, /discoverSessionContext\(nextEnv\);/);
	assert.match(patched, /discoverSessionContext\(currentEnv\);/);
	// The first render's own discovery still checks its skills.
	assert.match(patched, /discoverSessionContext\(env, definition\.skills\)/);
	assert.equal(await patchFlue(dist), 'already');
	writeFileSync(new URL('builtin-providers-x.mjs', dist), `swapDiscovery: async () => {}\n${TASK}`);
	assert.equal(await patchFlue(dist), 'not-found', 'a Flue that changed shape is reported');
});

test('a subagent on its own model compacts as its definition says, and one on the parent model as the parent does', async () => {
	const dist = runtime('compaction', `${BROKEN}\n${TASK}`);
	assert.equal((await patchFlueEach(dist))["a subagent's compaction"], 'patched');
	const patched = readFileSync(new URL('builtin-providers-x.mjs', dist), 'utf8');
	assert.match(patched, /compaction: taskAgent\?\.model !== void 0 \? taskAgent\.compaction : this\.config\.compaction\n/);
	assert.equal((await patchFlueEach(dist))["a subagent's compaction"], 'already');

	// A runtime patched before a definition could name its compaction is brought up to date.
	const earlier = runtime('compaction-earlier', `${BROKEN}\n${TASK.replace('compaction: this.config.compaction', 'compaction: taskAgent?.model !== void 0 ? void 0 : this.config.compaction')}`);
	assert.equal((await patchFlueEach(earlier))["a subagent's compaction"], 'patched');
	assert.equal(readFileSync(new URL('builtin-providers-x.mjs', earlier), 'utf8'), patched);
});

/** The summary's model as the patched `runCompaction` picks it, for a compaction config and the conversation's own model. */
function summaryModelOf(source: string, compactionConfig: object | undefined, sessionModel: object): Record<string, unknown> {
	const line = source.match(/const summarizationModel = .*;/)![0];
	const session = { resolveModelForCall: (specifier: string) => ({ id: specifier, reasoning: true }) };
	return new Function('compactionConfig', 'sessionModel', `${line} return summarizationModel;`).call(session, compactionConfig, sessionModel);
}

/** The effort the patched `runSummarizationCall` asks of a model. */
function reasoningOf(source: string, model: object): string | undefined {
	const options: { reasoning?: string } = {};
	new Function('model', 'completionOptions', source.match(/if \(model\.reasoning.*;/)![0])(model, options);
	return options.reasoning;
}

const SUMMARY_EFFORT = "the summary's effort, with a compaction model or without";

test('a compaction model writes its summary at the effort picked with it, and at high without one', async () => {
	const dist = runtime('summary', `${BROKEN}\n${TASK}`);
	const results = await patchFlueEach(dist);
	assert.equal(results[SUMMARY_EFFORT], 'patched');
	assert.equal(results['a summary at the effort chosen'], 'patched');
	const store = readFileSync(new URL('conversation-store-x.mjs', dist), 'utf8');
	assert.match(store, /summaryReasoning: compactionConfig\.reasoning \}/);
	const summary = readFileSync(new URL('dispatch-x.mjs', dist), 'utf8');
	assert.equal(reasoningOf(summary, { reasoning: true }), 'high');
	assert.equal(reasoningOf(summary, { reasoning: true, summaryReasoning: 'low' }), 'low');
	assert.equal(reasoningOf(summary, { reasoning: true, summaryReasoning: 'off' }), undefined);
	assert.equal(reasoningOf(summary, { reasoning: false, summaryReasoning: 'high' }), undefined, 'a model without reasoning is asked for none');
	assert.match(summary, /key !== "model" && key !== "reasoning"\) throw/, 'the compaction config may carry the effort');
	assert.deepEqual(Object.values(await patchFlueEach(dist)).filter((result) => result !== 'already'), []);

	const own = { id: 'opencode-go/deepseek-v4-pro', reasoning: true };
	assert.deepEqual(summaryModelOf(store, { model: 'openrouter/fast', reasoning: 'medium' }, own), { id: 'openrouter/fast', reasoning: true, summaryReasoning: 'medium' });
	assert.deepEqual(summaryModelOf(store, { model: 'openrouter/fast' }, own), { id: 'openrouter/fast', reasoning: true, summaryReasoning: undefined }, 'a model with no effort chosen writes at high');
	assert.deepEqual(summaryModelOf(store, { reasoning: 'low' }, own), { ...own, summaryReasoning: 'low' }, 'no model chosen: the own model, at the effort passed');
	assert.equal(summaryModelOf(store, { keepRecentTokens: 40_000 }, own), own, 'no effort passed: the own model as it is');
	assert.equal(summaryModelOf(store, undefined, own), own);
});

test('a runtime patched before the effort was read without a compaction model is brought up to date', async () => {
	const fresh = runtime('summary-fresh', `${BROKEN}\n${TASK}`);
	await patchFlueEach(fresh);
	const earlier = runtime('summary-earlier', `${BROKEN}\n${TASK}`);
	writeFileSync(
		new URL('conversation-store-x.mjs', earlier),
		COMPACTION.replace(
			'compactionConfig?.model ? this.resolveModelForCall(compactionConfig.model) : sessionModel;',
			'compactionConfig?.model ? { ...this.resolveModelForCall(compactionConfig.model), summaryReasoning: compactionConfig.reasoning } : sessionModel;',
		),
	);
	assert.equal((await patchFlueEach(earlier))[SUMMARY_EFFORT], 'patched');
	assert.equal(readFileSync(new URL('conversation-store-x.mjs', earlier), 'utf8'), readFileSync(new URL('conversation-store-x.mjs', fresh), 'utf8'));
	assert.equal((await patchFlueEach(earlier))[SUMMARY_EFFORT], 'already');
});

test('applied to the installed runtime, the summary with no compaction model is written by the own model at the effort passed', async () => {
	// A copy of the installed runtime's files, whether it was patched before or not: the patch brings either to the same text.
	const installed = new URL('../node_modules/@flue/runtime/dist/', import.meta.url);
	const copy = path.join(dir, 'installed');
	mkdirSync(path.join(copy, 'node'), { recursive: true });
	for (const sub of ['', 'node/']) {
		for (const name of readdirSync(new URL(sub, installed)).filter((file) => file.endsWith('.mjs'))) {
			writeFileSync(path.join(copy, sub, name), readFileSync(new URL(`${sub}${name}`, installed)));
		}
	}
	const dist = pathToFileURL(`${copy}/`);
	const results = await patchFlueEach(dist);
	assert.deepEqual(Object.entries(results).filter(([, result]) => result === 'not-found'), [], 'every patch finds its place in the installed runtime');
	const sources = readdirSync(copy).filter((name) => name.endsWith('.mjs')).map((name) => readFileSync(path.join(copy, name), 'utf8'));
	const store = sources.find((source) => source.includes('async runCompaction('))!;
	const summary = sources.find((source) => source.includes('async function runSummarizationCall('))!;
	const own = { id: 'claude-code/claude-opus-5-5', reasoning: true };
	const model = summaryModelOf(store, { keepRecentTokens: 40_000, reasoning: 'low' }, own);
	assert.equal(model.id, own.id);
	assert.equal(reasoningOf(summary, model), 'low');
	assert.equal(reasoningOf(summary, summaryModelOf(store, { keepRecentTokens: 40_000 }, own)), 'high', 'a compaction that names no effort is the runtime’s as before');
	assert.equal(reasoningOf(summary, summaryModelOf(store, { model: 'openrouter/fast', reasoning: 'medium' }, own)), 'medium');
	assert.equal(reasoningOf(summary, summaryModelOf(store, { model: 'openrouter/fast' }, own)), 'high');
});

test('flue.db waits for a busy lock instead of failing at once', async () => {
	const dist = runtime('busy', `${BROKEN}\n${TASK}`);
	assert.equal((await patchFlueEach(dist))['waiting on a busy database'], 'patched');
	const patched = readFileSync(new URL('node/index.mjs', dist), 'utf8');
	assert.match(patched, /PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;/);
	assert.equal((await patchFlueEach(dist))['waiting on a busy database'], 'already');
	assert.equal(readFileSync(new URL('node/index.mjs', dist), 'utf8'), patched, 'patching twice changes nothing');
});

const LOCK_FIRST = 'writes that take the lock as they begin';

test('flue.db transactions take the write lock as they begin', async () => {
	const dist = runtime('begin', `${BROKEN}\n${TASK}`);
	assert.equal((await patchFlueEach(dist))[LOCK_FIRST], 'patched');
	const patched = readFileSync(new URL('node/index.mjs', dist), 'utf8');
	assert.match(patched, /db\.exec\("BEGIN IMMEDIATE"\);/);
	assert.doesNotMatch(patched, /db\.exec\("BEGIN"\);/);
	assert.match(patched, /busy_timeout=5000/, 'the busy timeout is patched in the same file');
	assert.equal((await patchFlueEach(dist))[LOCK_FIRST], 'already');
	assert.equal(readFileSync(new URL('node/index.mjs', dist), 'utf8'), patched, 'patching twice changes nothing');
});

/** The runtime's transaction wrapper, as `source` has it, over `db`. */
function transactionOf(source: string, db: DatabaseSync): (closure: () => void) => void {
	const wrapper = source.match(/function createNodeTransactionSync\(db\) \{[\s\S]*?\n\}/)![0];
	return new Function(`${wrapper}; return createNodeTransactionSync;`)()(db);
}

test('a write that reads first waits for another connection\'s lock once patched, and fails at once before', async () => {
	const dist = runtime('lock', `${BROKEN}\n${TASK}`);
	await patchFlueEach(dist);
	const patched = readFileSync(new URL('node/index.mjs', dist), 'utf8');
	const file = path.join(dir, 'lock.db');
	const db = new DatabaseSync(file);
	db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE batches (seq INTEGER);');
	// As the runtime saves a batch: the stream's row is read, then the batch written.
	const append = (source: string): Error | null => {
		try {
			transactionOf(source, db)(() => {
				db.prepare('SELECT count(*) FROM batches').get();
				db.prepare('INSERT INTO batches VALUES (1)').run();
			});
			return null;
		} catch (error) {
			return error as Error;
		}
	};
	// Another connection, as Litestream is, holds the write lock for a while: it says when it has it, then lets go.
	const held = new Int32Array(new SharedArrayBuffer(4));
	const holder = new Worker(
		`const { workerData } = require('node:worker_threads');
		const { DatabaseSync } = require('node:sqlite');
		const other = new DatabaseSync(workerData.file);
		other.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; INSERT INTO batches VALUES (0);');
		Atomics.store(workerData.held, 0, 1);
		Atomics.notify(workerData.held, 0);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
		other.exec('COMMIT');
		other.close();`,
		{ eval: true, workerData: { file, held } },
	);
	const ended = new Promise((resolve) => holder.once('exit', resolve));
	assert.equal(Atomics.wait(held, 0, 0, 10_000), 'ok', 'the other connection took the lock');
	const before = Date.now();
	assert.match(String(append(TRANSACTION)?.message), /database is locked/, 'a plain BEGIN that has read is refused the lock');
	assert.ok(Date.now() - before < 300, 'and at once, whatever the busy timeout');
	assert.equal(append(patched), null, 'BEGIN IMMEDIATE waits for the lock and writes');
	await ended;
	assert.equal((db.prepare('SELECT count(*) AS n FROM batches').get() as { n: number }).n, 2);
	db.close();
});

test('the installed runtime is patched', () => {
	const dist = new URL('../node_modules/@flue/runtime/dist/', import.meta.url);
	const sources = readdirSync(dist).filter((name) => name.endsWith('.mjs')).map((name) => readFileSync(new URL(name, dist), 'utf8'));
	const swap = sources.find((source) => source.includes('swapDiscovery:'));
	assert.ok(swap, 'Flue still swaps environments mid-reply');
	assert.doesNotMatch(swap, /discoverSessionContext\((nextEnv|currentEnv), definition\.skills\)/);
	assert.doesNotMatch(swap, /compaction: this\.config\.compaction\n/);
	assert.ok(sources.some((source) => source.includes('compactionConfig?.reasoning ? { ...sessionModel, summaryReasoning: compactionConfig.reasoning }')));
	assert.ok(sources.some((source) => source.includes('completionOptions.reasoning = model.summaryReasoning ?? "high"')));
	const node = readFileSync(new URL('node/index.mjs', dist), 'utf8');
	assert.match(node, /busy_timeout=5000/);
	assert.match(node, /db\.exec\("BEGIN IMMEDIATE"\);/);
	assert.doesNotMatch(node, /db\.exec\("BEGIN"\);/);
});
