import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { DecisionModel, Question } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-small-change-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { setProviders } = await import('../src/providers/index.ts');
const { changedLines, cosmeticChange, coversRequest, SMALL_CHANGE_LINES } = await import('../src/services/replies/small-change.ts');

let yes = 0;
let asked: Array<{ state: Record<string, unknown>; questions: Record<string, Question> }> = [];
const decisions: DecisionModel = {
	name: 'test',
	decide: async (state, questions) => {
		asked.push({ state, questions });
		return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { yes }])), inputTokens: 10, cost: 0 };
	},
};
const providers = (withDecisions: boolean) =>
	setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'openrouter', list: async () => [] }, ...(withDecisions ? { decisions } : {}) } as never);

const hunk = (lines: number) =>
	`diff --git a/src/web/thread.tsx b/src/web/thread.tsx\n--- a/src/web/thread.tsx\n+++ b/src/web/thread.tsx\n@@ -1,${lines} +1,${lines} @@\n context\n` +
	Array.from({ length: lines }, (_, i) => `-<div className="pb-${i}">\n+<div className="pb-${i + 1}">`).join('\n');

beforeEach(() => {
	asked = [];
	providers(true);
});

test('changed lines count what the hunks add and remove, not the file headers', () => {
	assert.equal(changedLines(hunk(1)), 2);
	assert.equal(changedLines(`${hunk(1)}\n${hunk(2)}`), 6);
	assert.equal(changedLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n---- a removed SQL comment\n'), 1, 'a removed line that starts with dashes still counts');
});

test('a small diff of styling alone is cosmetic only when the decision model is sure', async () => {
	yes = 0.02;
	assert.equal(await cosmeticChange('t', hunk(1)), true);
	assert.match(String(asked[0].questions.behaviour.instructions), /alter what the program does/);
	yes = 0.3;
	assert.equal(await cosmeticChange('t', hunk(1)), false, 'unsure is not cosmetic');
	asked = [];
	yes = 0;
	assert.equal(await cosmeticChange('t', hunk(SMALL_CHANGE_LINES)), false, 'past the size, the model is not asked');
	assert.equal(asked.length, 0);
	providers(false);
	assert.equal(await cosmeticChange('t', hunk(1)), false, 'without a decision model, nothing is skipped');
});

test('a small diff covers the request only when the decision model is sure it does', async () => {
	yes = 0.97;
	assert.equal(await coversRequest('t', 'Make it pb-1.', hunk(1)), true);
	assert.deepEqual(Object.keys(asked[0].state), ['request', 'diff']);
	yes = 0.8;
	assert.equal(await coversRequest('t', 'Make it pb-1.', hunk(1)), false);
	yes = 1;
	assert.equal(await coversRequest('t', 'Make it pb-1.', hunk(SMALL_CHANGE_LINES)), false);
	providers(false);
	assert.equal(await coversRequest('t', 'Make it pb-1.', hunk(1)), false);
});
