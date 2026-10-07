import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-usage-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession, getSessionRecord, addSessionUsage, spentSince, spendBy } = await import('../src/db/sessions.ts');
const { appDb } = await import('../src/db/client.ts');
const { recordTurnUsage } = await import('../src/services/usage.ts');

async function session(id: string) {
	const project = await upsertProject('acme/demo', 'main');
	await insertSession({
		id,
		projectId: project.id,
		title: id,
		model: 'openrouter/model',
		reasoning: null,
		branch: 'main',
		baseBranch: 'main',
		baseSha: 'abc',
		planMode: false,
	});
}
const event = (id: string, turnId: string) => ({
	type: 'turn',
	instanceId: id,
	turnId,
	request: { providerId: 'openrouter', requestedModel: 'helper' },
	response: { usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, cost: { total: 0.01 } } },
});

test('thirteen concurrent deliveries of one model call count only once in task totals and spending caps', async () => {
	await session('duplicates');
	const results = await Promise.all(Array.from({ length: 13 }, () => recordTurnUsage(event('duplicates', 'turn-one'))));
	assert.equal(results.filter(Boolean).length, 1);
	assert.deepEqual((await getSessionRecord('duplicates'))?.usage, { inputTokens: 160, outputTokens: 20, cost: 0.01 });
	const db = await appDb();
	assert.equal((await db.execute("SELECT COUNT(*) AS n FROM usage_log WHERE session_id='duplicates'")).rows[0].n, 1);
	assert.equal(await spentSince(new Date(0)), 0.01);
	assert.deepEqual(await spendBy('model', new Date(0)), [{ key: 'openrouter/helper', tokens: 180, cost: 0.01 }]);
});

test('distinct calls with identical usage count separately, and repeated calls after module reload do not', async () => {
	await session('distinct');
	await recordTurnUsage(event('distinct', 'turn-a'));
	await recordTurnUsage(event('distinct', 'turn-b'));
	const reloadPath = '../src/services/usage.ts?reloaded';
	const reloaded = await import(reloadPath);
	assert.equal(await reloaded.recordTurnUsage(event('distinct', 'turn-a')), null);
	const url = new URL('../src/services/usage.ts', import.meta.url).href;
	const restarted = spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'--eval',
			`
		const { recordTurnUsage } = await import(${JSON.stringify(url)});
		console.log(await recordTurnUsage(${JSON.stringify(event('distinct', 'turn-a'))}));
	`,
		],
		{ env: process.env, encoding: 'utf8' },
	);
	assert.equal(restarted.status, 0, restarted.stderr);
	assert.equal(restarted.stdout.trim(), 'null');
	assert.deepEqual((await getSessionRecord('distinct'))?.usage, { inputTokens: 320, outputTokens: 40, cost: 0.02 });
});

test('a failed totals update rolls back the log insert so retrying the call records it once', async () => {
	await session('retry');
	const db = await appDb();
	await db.execute(
		"CREATE TRIGGER fail_usage BEFORE UPDATE OF input_tokens ON sessions WHEN NEW.id = 'retry' BEGIN SELECT RAISE(ABORT, 'test update failure'); END",
	);
	await assert.rejects(
		addSessionUsage('retry', { inputTokens: 160, outputTokens: 20, cost: 0.01 }, new Date(), 'openrouter/helper', 'turn-retry'),
		/test update failure/,
	);
	assert.equal((await db.execute("SELECT COUNT(*) AS n FROM usage_log WHERE session_id = 'retry'")).rows[0].n, 0);
	await db.execute('DROP TRIGGER fail_usage');
	await recordTurnUsage(event('retry', 'turn-retry'));
	assert.deepEqual((await getSessionRecord('retry'))?.usage, { inputTokens: 160, outputTokens: 20, cost: 0.01 });
});

test('turn identities are scoped to a task and ordinary non-turn usage still records each charge', async () => {
	await session('other');
	await recordTurnUsage(event('other', 'turn-one'));
	await addSessionUsage('other', { inputTokens: 2, outputTokens: 1, cost: 0.001 });
	await addSessionUsage('other', { inputTokens: 2, outputTokens: 1, cost: 0.001 });
	assert.deepEqual((await getSessionRecord('other'))?.usage, { inputTokens: 164, outputTokens: 22, cost: 0.012 });
});
