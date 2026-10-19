import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { patchFlue } from '../scripts/patch-flue.ts';

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

test('a sandbox started mid-reply finds its skills without the first render\'s, once and only once', async () => {
	writeFileSync(path.join(dir, 'other.mjs'), 'export const unrelated = 1;');
	writeFileSync(path.join(dir, 'builtin-providers-x.mjs'), BROKEN);
	const dist = pathToFileURL(`${dir}/`);
	assert.equal(await patchFlue(dist), 'patched');
	const patched = readFileSync(path.join(dir, 'builtin-providers-x.mjs'), 'utf8');
	assert.match(patched, /discoverSessionContext\(nextEnv\);/);
	assert.match(patched, /discoverSessionContext\(currentEnv\);/);
	// The first render's own discovery still checks its skills.
	assert.match(patched, /discoverSessionContext\(env, definition\.skills\)/);
	assert.equal(await patchFlue(dist), 'already');
	writeFileSync(path.join(dir, 'builtin-providers-x.mjs'), 'swapDiscovery: async () => {}');
	assert.equal(await patchFlue(dist), 'not-found', 'a Flue that changed shape is reported');
});

test('the installed runtime is patched', () => {
	const dist = new URL('../node_modules/@flue/runtime/dist/', import.meta.url);
	const sources = readdirSync(dist).filter((name) => name.endsWith('.mjs')).map((name) => readFileSync(new URL(name, dist), 'utf8'));
	const swap = sources.find((source) => source.includes('swapDiscovery:'));
	assert.ok(swap, 'Flue still swaps environments mid-reply');
	assert.doesNotMatch(swap, /discoverSessionContext\((nextEnv|currentEnv), definition\.skills\)/);
});
