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

test('workspace agents can check the actual Preview URL and are instructed to verify it in the sandbox browser', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	const workspace = source.slice(source.indexOf('function useWorkspace'), source.indexOf('const BROWSER_ACTIONS'));
	assert.match(workspace, /name: 'check_preview'/);
	assert.match(workspace, /checkPreview\(id, data\.port\)/);
	const hint = source.slice(source.indexOf('const PREVIEW_HINT'), source.indexOf('const WORKSPACE_PROMPT'));
	assert.match(hint, /exact Preview URL/);
	assert.match(hint, /in: sandbox/);
	assert.match(hint, /or prove iframe embedding/);
	assert.equal((source.match(/\n\tPREVIEW_HINT,/g) ?? []).length, 2);
});

test('the browser requires an explicit fresh open and retains its notice after autopilot', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	const tool = source.slice(source.indexOf('function browserTool'), source.indexOf('function Browser()'));
	assert.match(tool, /fresh: v\.optional/);
	assert.match(tool, /fresh needs open or do with a URL/);
	assert.match(tool, /go\(\{ action: 'open', url: rest\.url, fresh: rest\.fresh \}\)/);
	assert.match(tool, /openingNotice = state\.notice/);
	assert.match(tool, /\[openingNotice, state\.notice\]/);
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

test('Coder reaches connectors through two fixed tools, so turning one on or off never changes its tools, and sending only asks', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	assert.match(source, /if \(connectors\.length\) useConnectorTools\(id, connectors\);/);
	const tools = source.slice(source.indexOf('function useConnectorTools'), source.indexOf('function connectorHint'));
	assert.match(tools, /name: 'connector_tools'/);
	assert.match(tools, /name: 'connector_call'/);
	// The agent never sends: the mailbox's send asks, and the task waits on the user's Send.
	assert.match(tools, /if \(approval\) noteAsk\(id,/);
	assert.doesNotMatch(tools, /sendDraft|decideSend/);
	// Nothing about whether a connector is on reaches the prompt or a tool's definition: only the connectors set up are named.
	assert.doesNotMatch(source, /useMcpConnection\(\{[^}]*connector/);
	const tools2 = readFileSync(new URL('../src/services/connector-tools.ts', import.meta.url), 'utf8');
	assert.match(tools2, /access\.send\s*\?/);
	assert.match(tools2, /requestSend\(task, id, checked\(send, args\)\.draft_id, signal\)/);
	assert.doesNotMatch(tools2, /sendDraft|decideSend/);
});

test('Coder makes images through the image port whatever its model, with the tool only when there is one', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	assert.match(source, /if \(drawing\) useGenerateImage\(id\);/);
	const tool = source.slice(source.indexOf('function useGenerateImage'), source.indexOf('const IMAGE_HINT'));
	assert.match(tool, /name: 'generate_image'/);
	assert.match(tool, /generateImage\(id, data, signal\)/);
});

test('Coordinator keeps its instructions fixed and gives the project state as a signal, only when it has changed', () => {
	const source = readFileSync(new URL('../src/agents/coordinator.ts', import.meta.url), 'utf8');
	const render = source.slice(source.indexOf('export function Coordinator'), source.indexOf('const STATE_NOTE'));
	assert.match(render, /useProjectState\(id\);\n\treturn `\$\{PROMPT\}\$\{brief\.propose \? ` \$\{PROPOSE\}` : ''\} \$\{STATE_NOTE\}`;/);
	assert.doesNotMatch(render, /brief\.state|new Date/, 'nothing that changes between messages is in the instructions');
	const hook = source.slice(source.indexOf('function useProjectState'));
	assert.match(hook, /shown\?\.body === body && shown\.since < STATE_EVERY/);
	assert.match(hook, /append\(\{ kind: 'signal', type: 'project-state', body \}\)/);
});

test('the browser turns away raw GitHub files, which web_fetch reads in a second', async () => {
	const { isRawFile } = await import('../src/services/browser-step.ts');
	assert.ok(isRawFile('https://raw.githubusercontent.com/acme/app/main/src/driver.ts'));
	assert.ok(isRawFile('gist.githubusercontent.com/ada/1/raw/notes.md'));
	assert.ok(!isRawFile('https://github.com/acme/app/pulls'));
	assert.ok(!isRawFile(undefined));
});
