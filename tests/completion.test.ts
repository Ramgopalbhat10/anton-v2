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

test('a command with $ARGUMENTS takes what follows its name; anything else is sent as typed', async () => {
	const { expandCommand } = await import('../src/web/lib/completion.ts');
	const commands = [
		{ name: 'fix', prompt: 'Fix issue #$ARGUMENTS and add a test that covers $ARGUMENTS.' },
		{ name: 'review', prompt: 'Review this branch.' },
	];
	assert.equal(expandCommand('/fix 142', commands), 'Fix issue #142 and add a test that covers 142.');
	assert.equal(expandCommand('/fix\n142 and 143', commands), 'Fix issue #142 and 143 and add a test that covers 142 and 143.');
	assert.equal(expandCommand('/review now', commands), '/review now', 'a prompt without $ARGUMENTS was filled in when picked');
	assert.equal(expandCommand('/pdf merge these', commands), '/pdf merge these', 'a skill stays as typed for the agent');
	assert.equal(expandCommand('please /fix 1', commands), 'please /fix 1');
});
