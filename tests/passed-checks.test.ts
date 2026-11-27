import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandOf, noteToolResult, passedChecks, passedNote, startPassedChecks } from '../src/services/replies/passed-checks.ts';
import { STILL_RUNNING } from '../src/providers/acp/workspace-bridge.ts';

const ok = (text = 'ok') => ({ content: [{ type: 'text', text }], details: { exitCode: 0 } });
const failed = { content: [{ type: 'text', text: 'boom\n\nCommand exited with code 1' }], details: { exitCode: 1 } };

test('checks that passed since the last file change are named once each; looks around and failures are not', () => {
	startPassedChecks('t');
	noteToolResult('t', 'bash', { command: 'npx vitest run a.test.ts' }, ok(), 1);
	noteToolResult('t', 'edit', { path: 'a.ts' }, ok(), 2);
	noteToolResult('t', 'bash', { command: 'git status --short' }, ok(), 3);
	noteToolResult('t', 'bash', { command: 'npm run check:types' }, ok(), 4);
	noteToolResult('t', 'bash', { command: 'npm run lint:hooks' }, failed, 5);
	noteToolResult('t', 'bash', { command: 'npm run check:types' }, ok(), 6);
	assert.deepEqual(passedChecks('t'), ['npm run check:types'], 'the vitest run was before the edit');
	// A background job counts when it started after the last change.
	assert.deepEqual(passedChecks('t', [{ command: 'npm test', at: 7 }, { command: 'npm run build', at: 1 }]), ['npm run check:types', 'npm test']);
	startPassedChecks('t');
	assert.deepEqual(passedChecks('t'), [], 'a new reply starts over');
});

test('an ACP terminal step counts by the command its first line names, and only once it has ended', () => {
	startPassedChecks('a');
	const step = `# npx vitest run tests/ui/settings.test.tsx\n__d='/tmp/anton-acp/1'; mkdir -p "$__d"`;
	noteToolResult('a', 'bash', { command: step }, ok(`partial\n${STILL_RUNNING}\n`), 1);
	assert.deepEqual(passedChecks('a'), []);
	noteToolResult('a', 'bash', { command: `# waiting for: npx vitest run tests/ui/settings.test.tsx\n__d='/tmp/anton-acp/1'` }, ok(), 2);
	assert.deepEqual(passedChecks('a'), ['npx vitest run tests/ui/settings.test.tsx']);
	assert.equal(commandOf('export NO_COLOR=1 FORCE_COLOR=0; npm test'), 'npm test');
});

test('the note says what still stands, and asks for no new checks without a gap', () => {
	assert.match(passedNote([]), /^Run a check again only after you change code it covers/);
	assert.match(passedNote(['npm test']), /^These passed since your last file change, and still stand: `npm test`\. Run a check again/);
});
