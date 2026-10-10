import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { DecisionModel, Question } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-judge-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { needsTheUser, partsOf, trimToJob } = await import('../src/services/page-judge.ts');
const { setProviders } = await import('../src/providers/index.ts');

let asked: Array<{ state: Record<string, unknown>; questions: Record<string, Question> }> = [];
/** Answers yes for parts that mention "Stories", and for a page with a password field. */
const decisions: DecisionModel = {
	name: 'openrouter/~typesafe/jev-latest',
	async decide(state, questions) {
		asked.push({ state, questions });
		const answers = Object.fromEntries(
			Object.keys(questions).map((key) => [key, { yes: key === 'gated' ? (String(state.page).includes('Password') ? 0.95 : 0.05) : String(state[key]).includes('Stories') ? 0.9 : 0.05 }]),
		);
		return { answers, inputTokens: 100, cost: 0.0001 };
	},
};
setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'x', list: async () => [] }, decisions });

const big = (label: string, lines: number) => [`- ${label}:`, ...Array.from({ length: lines }, (_, index) => `  - link "${label} link ${index} ${'x'.repeat(40)}"`)];
const page = [...big('banner', 20), ...big('navigation "Menu"', 30), ...big('main "Stories"', 25), ...big('contentinfo', 20)].join('\n');

test('a page splits into its top-level parts, and one part that is most of the page into its children', () => {
	assert.deepEqual(partsOf(page).map((part) => part.lines[0]), ['- banner:', '- navigation "Menu":', '- main "Stories":', '- contentinfo:']);
	const nested = ['- main:', ...big('  - article "A"', 10).map((line) => `  ${line}`), ...big('  - article "B"', 10).map((line) => `  ${line}`), '- contentinfo: x'].join('\n');
	assert.ok(partsOf(nested).length >= 3);
});

test('a long page keeps only the parts its job needs, saying what was left out', async () => {
	asked = [];
	const trimmed = await trimToJob('t1', 'Report the top stories', 'https://news.ycombinator.com/', page);
	assert.equal(asked.length, 1, 'one call for all the parts');
	assert.equal(asked[0].state.job, 'Report the top stories');
	assert.match(trimmed, /^\(Parts of this page that do not bear on your job are left out/);
	assert.ok(trimmed.includes('main "Stories" link 3'));
	assert.match(trimmed, /^- navigation "Menu": \(30 lines left out as not needed for the job\)$/m);
	assert.ok(trimmed.length < page.length / 2);
});

test('a short page, or one with no job to judge against, is left whole', async () => {
	asked = [];
	assert.equal(await trimToJob('t1', null, 'u', page), page);
	const short = big('main', 5).join('\n');
	assert.equal(await trimToJob('t1', 'job', 'u', short), short);
	assert.equal(asked.length, 0);
});

test('only a page that looks like a sign-in wall or human check is asked about, and the answer decides', async () => {
	asked = [];
	assert.equal(await needsTheUser('t1', 'https://news.ycombinator.com/', 'Hacker News', page), false);
	assert.equal(await needsTheUser('t1', 'https://news.ycombinator.com/', 'Hacker News', '- link "login"\n- link "Sign in"'), false);
	assert.equal(asked.length, 0, 'an ordinary page, even one linking to a sign-in, costs nothing');
	assert.equal(await needsTheUser('t1', 'https://github.com/login', 'Sign in to GitHub', '- textbox "Password"\n- button "Sign in"'), true);
	assert.equal(await needsTheUser('t1', 'https://example.com/', 'Just a moment...', '- text: Verify you are human'), false);
	assert.equal(asked.length, 2);
});
