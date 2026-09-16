import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Coder declares explorer, tester, and open_pull_request without useSandbox in specialists', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	assert.match(source, /name: 'explorer'/);
	assert.match(source, /name: 'tester'/);
	assert.match(source, /name: 'open_pull_request'/);
	const explorerFn = source.slice(source.indexOf('function Explorer'), source.indexOf('function Tester'));
	const testerFn = source.slice(source.indexOf('function Tester'), source.indexOf('const explorer'));
	assert.doesNotMatch(explorerFn, /useSandbox/);
	assert.doesNotMatch(testerFn, /useSandbox/);
});
