import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-pins-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { pinnedModels, setPinnedModels } = await import('../src/services/models.ts');
const { onChange } = await import('../src/core/changes.ts');

test('pins are kept once each, in the order made, and announced so open pickers refetch', async () => {
	assert.deepEqual(await pinnedModels(), []);
	const changes: unknown[] = [];
	const stop = onChange((change) => changes.push(change));
	try {
		assert.deepEqual(await setPinnedModels(['openai/gpt-6.1-sol', 'openrouter/anthropic/haiku', 'openai/gpt-6.1-sol']), ['openai/gpt-6.1-sol', 'openrouter/anthropic/haiku']);
		assert.deepEqual(await pinnedModels(), ['openai/gpt-6.1-sol', 'openrouter/anthropic/haiku']);
		assert.deepEqual(changes, [{ kind: 'models' }]);
		assert.deepEqual(await setPinnedModels([]), []);
		assert.deepEqual(await pinnedModels(), []);
	} finally {
		stop();
	}
});
