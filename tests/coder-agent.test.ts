import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Coder declares explorer, tester, and open_pull_request without useSandbox in specialists', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	assert.match(source, /name: 'explorer'/);
	assert.match(source, /name: 'tester'/);
	assert.match(source, /name: 'open_pull_request'/);
	for (const tool of ['list_files', 'read_file', 'search_code', 'start_workspace']) assert.match(source, new RegExp(`name: '${tool}'`));
	const explorerFn = source.slice(source.indexOf('function Explorer'), source.indexOf('function Tester'));
	const testerFn = source.slice(source.indexOf('function Tester'), source.indexOf('const explorer'));
	assert.doesNotMatch(explorerFn, /useSandbox/);
	assert.doesNotMatch(testerFn, /useSandbox/);
});

test('Coder gives a workspace the computer subagent, whose tool sees through the vision port and never through the model it runs on', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	assert.match(source, /name: 'computer'/);
	assert.match(source, /if \(workspace\) useComputerSubagent\(id\);/);
	const tool = source.slice(source.indexOf('function computerTool'), source.indexOf('function Computer()'));
	// A model prompted through the harness keeps the subagent's tools and may act instead of answering.
	assert.doesNotMatch(tool, /harness/);
	assert.match(tool, /asAgentStep\(id/);
});
