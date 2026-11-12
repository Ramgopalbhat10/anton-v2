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
	const hint = source.slice(source.indexOf('const PREVIEW_HINT'), source.indexOf('const workspacePrompt'));
	assert.match(hint, /exact Preview URL/);
	assert.match(hint, /in: sandbox/);
	assert.match(hint, /or prove iframe embedding/);
	assert.equal((source.match(/\n\tPREVIEW_HINT,/g) ?? []).length, 2);
	// The Preview check rides on the UI check's browser run, never a run of its own.
	assert.match(hint, /one run checks the rendered app, its console errors and Preview together/);
	assert.match(hint, /Do not start a browser run only to look at Preview once check_preview passes/);
});

test('workspace agents batch the edits they know and do not run the same tests twice', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	assert.match(source, /const EDIT_HINT =\n\t'Make the changes you already know in one step: all the changes to a file in one edit call, as its edits list/);
	assert.match(source, /const PATCH_HINT =\n\t'Make the changes you already know in one step: one apply_patch call can change several files and several places in each/);
	// Both workspace prompts take the profile's hint in the place EDIT_HINT had.
	assert.equal((source.match(/\n\tedit,\n\tFINISH_HINT,/g) ?? []).length, 1);
	assert.equal((source.match(/\n\tedit,\n\tREAD_HINT,/g) ?? []).length, 1);
	assert.match(source, /const edit = profile === 'patch' \? PATCH_HINT : EDIT_HINT;/);
	assert.match(source, /Never run the same tests both ways/);
});

test('the sandbox browser needs no desktop, and do keeps the opening notice after autopilot', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	const tool = source.slice(source.indexOf('function browserTool'), source.indexOf('function Browser()'));
	assert.doesNotMatch(tool, /fresh/);
	assert.match(source, /sandbox: "a browser inside the sandbox, which the user can watch and take over in the Computer panel/);
	assert.match(tool, /go\(\{ action: 'open', url: rest\.url \}\)/);
	assert.match(tool, /openingNotice = opened\.notice/);
	assert.match(tool, /\[openingNotice, state\.notice\]/);
	// The run starts on the page that was opened, without looking at it again.
	assert.match(tool, /start: opened/);
});

test('Coder gives a workspace the computer subagent, whose tool sees through the vision port and never through the model it runs on', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	assert.match(source, /name: 'computer'/);
	assert.match(source, /if \(sandboxed\) useComputerSubagent\(id\);/);
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

test('a coder turn may run up to 4 hours, past Flue\'s 1-hour default, or as long as ANTON_REPLY_TIMEOUT_HOURS says', async () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	assert.match(source, /Coder\.durability = \{ timeoutMs: config\.replyTimeoutMs \};/);
	const { config } = await import('../src/config.ts');
	assert.equal(config.replyTimeoutMs, 4 * 3_600_000);
	assert.match(readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8'), /replyTimeoutMs: .*read\('ANTON_REPLY_TIMEOUT_HOURS', '4'\)/);
});

test('Coder checks a change against the whole request and a whole test suite before finishing, and sends a stalled reply back to work', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	for (const prompt of ['const workspacePrompt', 'const chatWorkspacePrompt']) {
		const start = source.indexOf(prompt);
		assert.ok(start >= 0, prompt);
		assert.match(source.slice(start, source.indexOf('.join(', start)), /FINISH_HINT/, prompt);
	}
	const finish = source.slice(source.indexOf('const FINISH_HINT'), source.indexOf('/** Links to the outputs folder'));
	assert.match(finish, /whole test suite of the package or module you changed/);
	assert.match(finish, /Do not end on part of the request left undone/);
	assert.match(finish, /A doubt you would report as a caveat or a judgement call/);
	assert.match(source, /signal\.aborted \? null : stallReminder\(id, response\.toolCalls\)/);
	assert.match(source, /startStallCheck\(id\);/);
});

test('Coder lists the request’s requirements as todos, and has a change read against the request before a coding reply ends', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	// In every repository and chat prompt: a coding task writes its list before it starts its workspace.
	assert.equal(source.match(/\$\{TODO_HINT\} \$\{REQUIREMENTS_HINT\} \$\{WHILE_WORKING_HINT\}/g)?.length, 2);
	assert.match(source, /noteRequest\(id, delivery\.body\);/);
	assert.match(source, /\(workspace \|\| hasWorkspace\(id\)\) && !planning && !review && !signal\.aborted \? await finishReview\(id, response\.toolCalls, signal\) : null/);
	assert.match(source, /startFinishReview\(id\);/);
});

test('Coder writes its todo list whole once and updates its statuses by item number, alongside other tool calls', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	const tool = source.slice(source.indexOf('function useTodos'), source.indexOf('/** A question with options to tap'));
	assert.match(tool, /input: TODOS_INPUT,/);
	assert.match(tool, /run: async \(\{ data, toolCallId \}\) => \(\{ output: await updateTodos\(id, data, toolCallId\) \}\)/);
	assert.match(tool, /For status updates send only changes, the items that changed by number\./);
	assert.match(source, /mark it completed and the next one in_progress with update_todos \(only the items that changed, by number\) alongside the next step's tool calls, never as a step of its own;/);
	// Only the main Coder keeps a todo list.
	assert.equal(source.match(/\buseTodos\(id\)/g)?.length, 1);
});

test('Coder tells a reply how long it may run, the same on every render, and sends a reply that ends with work undone back to do it', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	const budget = source.slice(source.indexOf('const BUDGET_HINT'), source.indexOf('/** Links to the outputs folder'));
	// From config alone, never the clock: it sits in the cached system prompt.
	assert.match(budget, /`A reply may run for up to \$\{hoursText\(config\.replyTimeoutMs\)\}, so do a large job in full rather than scope it down or hand it back part-done\.`/);
	assert.doesNotMatch(budget, /Date|now\(/);
	for (const prompt of ['const workspacePrompt', 'const chatWorkspacePrompt']) {
		const start = source.indexOf(prompt);
		assert.match(source.slice(start, source.indexOf('.join(', start)), /\tFINISH_HINT,\n\tBUDGET_HINT,/, prompt);
	}
	// After the todo reminder, the stall check and the finish review, and never in plan mode or on a review task.
	const finish = source.slice(source.indexOf('useAgentFinish(async'), source.indexOf('queueCheckpoint(id);\n\t\t\t// What the reply leaves'));
	assert.ok(finish.indexOf('finishReview(') < finish.indexOf('completionGate('));
	assert.match(finish, /!planning && !review && !signal\.aborted \? await completionGate\(id, response\.toolCalls, \{ chat, workspace: workspace \|\| hasWorkspace\(id\), signal \}\) : null/);
	assert.match(source, /startCompletionGate\(id\);/);
});

test('Coder tells a long reply how long it has run, with a command’s result', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	assert.match(source, /machineSandbox\(machine, repoDir\(machine\), \(\) => !isPlanning\(id\), secrets, undefined, \(\) => elapsedNote\(id\) \+ jobNotice\(id\)\)/);
	assert.match(source, /startReplyClock\(id\);/);
});

test('Coder runs suites as background jobs wherever its prompt names them, and sends a reply back for a job left running or unread', () => {
	const source = readFileSync(new URL('../src/agents/coder.ts', import.meta.url), 'utf8');
	// The tools are on wherever the workspace is, and the workspace prompts are the only ones that name them.
	const workspace = source.slice(source.indexOf('function useWorkspace'), source.indexOf('function useBackgroundJobs'));
	assert.match(workspace, /\n\tuseBackgroundJobs\(id\);\n/);
	const jobs = source.slice(source.indexOf('function useBackgroundJobs'), source.indexOf('const BROWSER_ACTIONS'));
	assert.match(jobs, /name: 'run_in_background'/);
	assert.match(jobs, /name: 'check_job'/);
	assert.match(jobs, /A server that should keep running is started with nohup instead/);
	const finish = source.slice(source.indexOf('const FINISH_HINT'), source.indexOf('/**', source.indexOf('const FINISH_HINT')));
	assert.match(finish, /Start it with run_in_background \(independent suites side by side\) and go on with what is left while it runs; you are told when it ends, and check_job gives its exit code and failures\./);
	assert.doesNotMatch(finish, /log under \/tmp/);
	const named = [...source.matchAll(/^const ([A-Z_]+) =[\s\S]*?(?=\n(?:const|function|\/\*\*) )/gm)].filter((match) => /run_in_background|check_job/.test(match[0])).map((match) => match[1]);
	assert.deepEqual(named, ['FINISH_HINT']);
	const builder = source.slice(source.indexOf('const workspacePrompt'), source.indexOf(".join(' ')", source.indexOf('const workspacePrompt')));
	assert.match(builder, /run_in_background/);
	for (const prompt of ['workspacePrompt', 'chatWorkspacePrompt']) {
		const start = source.indexOf(`const ${prompt}`);
		assert.match(source.slice(start, source.indexOf('.join(', start)), /\tFINISH_HINT,/, prompt);
	}
	// FINISH_HINT is only in the workspace prompts, which render only with the workspace and so with the tools.
	assert.equal(source.match(/\bFINISH_HINT\b/g)?.length, 3);
	assert.match(source, /const prompt = workspace \? prompts\.chatWorkspace : CHAT_PROMPT;/);
	assert.match(source, /const prompt = repoTask \? prompts\.task : workspace \? prompts\.workspace : READ_ONLY_PROMPT;/);
	// A repository task has the tools from its first model call, as it has the prompt; the rest once they have a sandbox.
	assert.match(source, /if \(repoTask\) useTaskWorkspace\(id, profile\);\n\telse if \(workspace\) useWorkspace\(id, chat, review, profile\);/);
	const task = source.slice(source.indexOf('function useTaskWorkspace'), source.indexOf('function useSandboxChecks'));
	assert.match(task, /\n\tuseBackgroundJobs\(id, \(task\) => workMachine\(task\)\);\n/);
	// The tester stays, for a failure set too large to triage in the agent's own context.
	assert.match(source, /Give a suite to the tester subagent only when triaging its failures would flood your own context/);
	// After the todo reminder and the stall check, before the finish review; reset with each reply; a stopped reply stops its jobs.
	const gates = source.slice(source.indexOf('useAgentFinish(async'), source.indexOf('queueCheckpoint(id);\n\t\t\t// What the reply leaves'));
	assert.ok(gates.indexOf('stallReminder(') < gates.indexOf('jobsGate('));
	assert.ok(gates.indexOf('jobsGate(') < gates.indexOf('finishReview('));
	assert.match(gates, /signal\.aborted \? null : await jobsGate\(id, response\.toolCalls, \{ signal \}\)/);
	assert.match(gates, /if \(signal\.aborted\) void stopReplyJobs\(id\);/);
	assert.match(source, /startJobsGate\(id\);/);
});
