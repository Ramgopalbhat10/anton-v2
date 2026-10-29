import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
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

const OPEN = `function openDatabase(path) {
	const db = new DatabaseSync(path);
	if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
}`;

/** A runtime laid out as Flue's is: the providers at the top, the Node adapter under node/. */
function runtime(name: string, providers: string, open = OPEN): URL {
	const dist = path.join(dir, name);
	mkdirSync(path.join(dist, 'node'), { recursive: true });
	writeFileSync(path.join(dist, 'other.mjs'), 'export const unrelated = 1;');
	writeFileSync(path.join(dist, 'builtin-providers-x.mjs'), providers);
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

test('a subagent on its own model compacts for that model, and one on the parent model as the parent does', async () => {
	const dist = runtime('compaction', `${BROKEN}\n${TASK}`);
	assert.equal((await patchFlueEach(dist))["a subagent's compaction"], 'patched');
	const patched = readFileSync(new URL('builtin-providers-x.mjs', dist), 'utf8');
	assert.match(patched, /compaction: taskAgent\?\.model !== void 0 \? void 0 : this\.config\.compaction\n/);
	assert.equal((await patchFlueEach(dist))["a subagent's compaction"], 'already');
});

test('flue.db waits for a busy lock instead of failing at once', async () => {
	const dist = runtime('busy', `${BROKEN}\n${TASK}`);
	assert.equal((await patchFlueEach(dist))['waiting on a busy database'], 'patched');
	const patched = readFileSync(new URL('node/index.mjs', dist), 'utf8');
	assert.match(patched, /PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;/);
	assert.equal((await patchFlueEach(dist))['waiting on a busy database'], 'already');
	assert.equal(readFileSync(new URL('node/index.mjs', dist), 'utf8'), patched, 'patching twice changes nothing');
});

test('the installed runtime is patched', () => {
	const dist = new URL('../node_modules/@flue/runtime/dist/', import.meta.url);
	const sources = readdirSync(dist).filter((name) => name.endsWith('.mjs')).map((name) => readFileSync(new URL(name, dist), 'utf8'));
	const swap = sources.find((source) => source.includes('swapDiscovery:'));
	assert.ok(swap, 'Flue still swaps environments mid-reply');
	assert.doesNotMatch(swap, /discoverSessionContext\((nextEnv|currentEnv), definition\.skills\)/);
	assert.doesNotMatch(swap, /compaction: this\.config\.compaction\n/);
	assert.match(readFileSync(new URL('node/index.mjs', dist), 'utf8'), /busy_timeout=5000/);
});
