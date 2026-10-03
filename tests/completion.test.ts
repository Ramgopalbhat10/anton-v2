import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchPaths, triggerAt } from '../src/web/lib/completion.ts';

test('a slash at the start offers commands, an @ anywhere offers files', () => {
	assert.deepEqual(triggerAt('/rev', 4), { kind: '/', query: 'rev', start: 0, end: 4 });
	assert.equal(triggerAt('fix /rev', 8), null, 'a slash mid-message is just text');
	assert.deepEqual(triggerAt('look at @src/ap please', 15), { kind: '@', query: 'src/ap', start: 8, end: 15 });
	assert.equal(triggerAt('mail me at me@example.com', 25), null, 'an email address is not a mention');
	assert.equal(triggerAt('@src/app.ts done', 16), null, 'a finished mention closes');
});

test('files whose name starts with the query come first', () => {
	const paths = ['src/app.ts', 'src/web/main.tsx', 'tests/app.test.ts', 'src/core/mapper.ts', 'README.md'];
	assert.deepEqual(matchPaths(paths, 'app'), ['src/app.ts', 'tests/app.test.ts', 'src/core/mapper.ts']);
	assert.deepEqual(matchPaths(paths, 'WEB/'), ['src/web/main.tsx']);
});

test('a file gets its language from the extension or a well-known name', async () => {
	const { languageFor } = await import('../src/web/lib/highlight.ts');
	const known = { ts: 1, dockerfile: 1, makefile: 1, json: 1 };
	assert.equal(languageFor('src/app.ts', known), 'ts');
	assert.equal(languageFor('Makefile', known), 'makefile');
	assert.equal(languageFor('docker/Dockerfile.dev', known), 'dockerfile');
	assert.equal(languageFor('notes.unknownext', known), null);
});
