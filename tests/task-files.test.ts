import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createClient } from '@libsql/client';
import type { GitHost, Machine, ModelCatalog } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-files-'));
process.env.ANTON_DATA_DIR = path.join(dir, 'data');
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A whole one-pixel PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const LONG = Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join('\n');
const MANY = Array.from({ length: 250 }, (_, index) => `needle ${index}`).join('\n');
const SPARSE = Array.from({ length: 250 }, (_, index) => `  hit ${index}\n  gap ${index}\n  gap more ${index}`).join('\n');

/** The repository as GitHub has it, at the commit the task starts from. */
const seed = path.join(dir, 'seed');
mkdirSync(path.join(seed, 'src', 'components'), { recursive: true });
mkdirSync(path.join(seed, '.github'), { recursive: true });
writeFileSync(path.join(seed, 'README.md'), '# demo\n');
writeFileSync(path.join(seed, 'AGENTS.md'), 'Run npm test before you finish.\n');
writeFileSync(path.join(seed, '.gitignore'), 'node_modules\n');
writeFileSync(path.join(seed, '.github', 'ci.yml'), 'name: ci\n');
writeFileSync(path.join(seed, 'src', 'app.ts'), 'import { answer } from "./deep";\nconsole.log(answer);\n// the end\n');
writeFileSync(path.join(seed, 'src', 'components', 'button.tsx'), 'export const Button = () => "answer";\n');
writeFileSync(path.join(seed, 'src', 'long.txt'), LONG);
writeFileSync(path.join(seed, 'src', 'many.txt'), MANY);
writeFileSync(path.join(seed, 'src', 'sparse.txt'), SPARSE);
writeFileSync(path.join(seed, 'logo.png'), PNG);
execFileSync('git', ['init', '-q', '-b', 'main', seed]);
git(seed, 'add', '.');
git(seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');

const fakeHost = {
	name: 'fake',
	getRepo: async (fullName: string) => ({ fullName, defaultBranch: 'main', private: false }),
	resolveRef: async (_repo: string, ref: string) => git(seed, 'rev-parse', ref),
	tree: async (_repo: string, sha: string) => git(seed, 'ls-tree', '-r', '--name-only', sha).split('\n'),
	archive: async (_repo: string, sha: string) => new Blob([execFileSync('git', ['archive', '--format=tar.gz', '--prefix=acme-demo/', sha], { cwd: seed })]).stream(),
	file: async (_repo: string, sha: string, file: string) => new TextEncoder().encode(`${git(seed, 'show', `${sha}:${file}`)}\n`),
} as unknown as GitHost;
const fakeCatalog: ModelCatalog = { name: 'fake', list: async () => [] };

const { useDatabase } = await import('../src/db/client.ts');
useDatabase(createClient({ url: `file:${path.join(dir, 'anton.db')}` }));
const { setProviders } = await import('../src/providers/index.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const local = localSandboxProvider(path.join(dir, 'data'));
/** Every machine a test started, by its key; nothing a read does may add to it. */
const started: string[] = [];
setProviders({
	sandbox: { ...local, acquire: async (request) => (started.push(request.key), local.acquire(request)) },
	store: diskStore(path.join(dir, 'data', 'objects')),
	git: fakeHost,
	models: fakeCatalog,
});
const { config } = await import('../src/config.ts');
config.prepareImages = false;
config.prewarmSandbox = false;
const { upsertProject } = await import('../src/db/projects.ts');
const sessions = await import('../src/services/sessions.ts');
const files = await import('../src/services/task-files.ts');
const runner = await import('../src/services/agent-runner.ts');
const { runScript, scriptToolDescription } = await import('../src/services/code-mode.ts');

const project = await upsertProject('acme/demo', 'main');
const session = await sessions.createSession({ projectId: project.id, title: 'Question' });
const id = session.id;

/** A machine for the task as it would be once it ran: the repository checked out, changed, installed and built. */
const resources = { runtime: 'container' as const, cpu: 1, memoryMiB: 1024, idleTimeoutMs: 60_000, lifetimeMs: 60_000, regions: [], allowedDomains: [] };
const { machine } = await local.acquire({ key: 'work', state: null, image: null, baseImage: null, ports: [], resources });
const root = `${machine.root}/repo`;
execFileSync('git', ['clone', '-q', seed, root]);
writeFileSync(path.join(root, 'src', 'app.ts'), 'import { answer } from "./deep";\nconsole.log(answer, "changed in the sandbox");\n');
mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'export const answer = 1;\n');
writeFileSync(path.join(root, 'secret.env'), 'TOKEN=supersecretvalue\n');
writeFileSync(path.join(machine.root, 'outputs', 'report.txt'), 'a report\nin outputs\n');

/** Reads that must never reach a machine: the task has no workspace. */
const noMachine = {
	workspace: () => false,
	machine: async (): Promise<Machine> => {
		throw new Error('a read started a machine');
	},
	secrets: async () => ({}),
	root: async () => root,
};
/** Reads once the task has its workspace, from the machine above. */
let machineCalls = 0;
const inMachine = {
	workspace: () => true,
	machine: async () => (machineCalls++, machine),
	secrets: async () => ({ TOKEN: 'supersecretvalue' }),
	root: async () => root,
};

test('read numbers lines and pages the same from the snapshot and the sandbox', async () => {
	const fromSnapshot = await files.readTaskFile(id, { path: 'src/long.txt', offset: 10, limit: 3 }, noMachine);
	const fromSandbox = await files.readTaskFile(id, { path: 'src/long.txt', offset: 10, limit: 3 }, inMachine);
	assert.equal(fromSnapshot, '10\tline 10\n11\tline 11\n12\tline 12\n(lines 10-12 of 450; read on with offset 13)');
	assert.equal(fromSandbox, fromSnapshot);
	// Without a limit, a page of 400 lines.
	assert.match(await files.readTaskFile(id, { path: 'src/long.txt' }, inMachine), /\n400\tline 400\n\(lines 1-400 of 450; read on with offset 401\)$/);
	// An absolute path in the repository is the same file.
	assert.equal(await files.readTaskFile(id, { path: `${root}/src/long.txt`, offset: 10, limit: 3 }, noMachine), fromSnapshot);
	assert.match(await files.readTaskFile(id, { path: 'src' }, noMachine), /src is a folder/);
	assert.match(await files.readTaskFile(id, { path: 'src' }, inMachine), /src is a folder/);
	assert.match(await files.readTaskFile(id, { path: 'missing.ts' }, inMachine), /missing\.ts does not exist/);
	assert.match(await files.readTaskFile(id, { path: 'src/long.txt', offset: 900 }, noMachine), /offset 900 is past its end/);
});

test('a path outside the repository is read from the machine, and another repository from its snapshot', async () => {
	const before = machineCalls;
	assert.equal(await files.readTaskFile(id, { path: '../outputs/report.txt' }, { ...inMachine, workspace: () => false }), '1\ta report\n2\tin outputs\n3\t');
	assert.equal(machineCalls, before + 1, 'only the machine has it');
	await assert.rejects(() => files.readTaskFile(id, { path: '/tmp/x.txt' }, noMachine), /a read started a machine/);
	// repo names another GitHub repository, read without cloning whatever the task's state.
	assert.match(await files.readTaskFile(id, { path: 'src/app.ts', repo: 'acme/other@main' }, inMachine), /^1\timport \{ answer \}/);
	assert.match(await files.grepTask(id, { pattern: 'Button', repo: 'acme/other@main' }, inMachine), /^src\/components\/button\.tsx:1: /);
	assert.equal(await files.globTask(id, { pattern: '*.tsx', repo: 'acme/other@main' }, inMachine), 'src/components/button.tsx');
	assert.equal(machineCalls, before + 1, 'another repository never needs the machine');
});

test('an image comes back as its bytes from either side', async () => {
	assert.deepEqual(Buffer.from(await files.taskFileBytes(id, 'logo.png', undefined, noMachine)), PNG);
	assert.deepEqual(Buffer.from(await files.taskFileBytes(id, 'logo.png', undefined, inMachine)), PNG);
	const { imageResult } = await import('../src/flue/sandbox-tools.ts');
	const seen = await imageResult('logo.png', await files.taskFileBytes(id, 'logo.png', undefined, noMachine), 'image/png', { sees: async () => true, describe: async () => '' });
	assert.equal(seen.content[1]?.type, 'image');
});

test('grep searches the same on both sides, with context, files only and a cap that says how to narrow it', async () => {
	const snapshot = await files.grepTask(id, { pattern: 'answer', path: 'src' }, noMachine);
	assert.equal(snapshot, 'src/app.ts:1: import { answer } from "./deep";\nsrc/app.ts:2: console.log(answer);\nsrc/components/button.tsx:1: export const Button = () => "answer";');
	const sandbox = await files.grepTask(id, { pattern: 'answer', path: 'src' }, inMachine);
	assert.equal(sandbox, 'src/app.ts:1: import { answer } from "./deep";\nsrc/app.ts:2: console.log(answer, "changed in the sandbox");\nsrc/components/button.tsx:1: export const Button = () => "answer";');
	// Context lines, and groups apart.
	assert.equal(await files.grepTask(id, { pattern: 'console', context: 1 }, noMachine), 'src/app.ts-1- import { answer } from "./deep";\nsrc/app.ts:2: console.log(answer);\nsrc/app.ts-3- // the end');
	assert.equal(await files.grepTask(id, { pattern: 'line 20$', context: 1, path: 'src/long.txt' }, inMachine), 'src/long.txt-19- line 19\nsrc/long.txt:20: line 20\nsrc/long.txt-21- line 21');
	// Files only, and a glob from the folder searched.
	assert.equal(await files.grepTask(id, { pattern: 'answer', filesOnly: true }, noMachine), 'src/app.ts\nsrc/components/button.tsx');
	assert.equal(await files.grepTask(id, { pattern: 'answer', filesOnly: true, path: 'src', glob: 'components/*.tsx' }, inMachine), 'src/components/button.tsx');
	assert.equal(await files.grepTask(id, { pattern: 'answer', filesOnly: true, path: 'src', glob: 'components/*.tsx' }, noMachine), 'src/components/button.tsx');
	// The sandbox skips what .gitignore leaves out, reads dotfiles and never .git; secrets are hidden.
	assert.equal(await files.grepTask(id, { pattern: 'answer', filesOnly: true }, inMachine), 'src/app.ts\nsrc/components/button.tsx');
	assert.equal(await files.grepTask(id, { pattern: 'name: ci' }, inMachine), '.github/ci.yml:1: name: ci');
	assert.equal(await files.grepTask(id, { pattern: 'TOKEN' }, inMachine), 'secret.env:1: TOKEN=[TOKEN hidden]');
	// Past 200 matches it stops and says how to narrow it, on both sides.
	for (const deps of [noMachine, inMachine]) {
		const capped = (await files.grepTask(id, { pattern: 'needle' }, deps)).split('\n');
		assert.equal(capped.length, 201);
		assert.equal(capped.at(-1), '(more matches; narrow the search with path or glob)');
	}
	// The same file gives the same answer from either side, capped, with context, in order.
	for (const input of [{ pattern: 'needle 1\\d$' }, { pattern: 'hit', context: 1, path: 'src/sparse.txt' }, { pattern: 'hit 1\\d$', context: 2, path: 'src' }, { pattern: 'HIT 7', ignoreCase: true, filesOnly: true }]) {
		assert.equal(await files.grepTask(id, input, inMachine), await files.grepTask(id, input, noMachine), JSON.stringify(input));
	}
	assert.match(await files.grepTask(id, { pattern: 'hit', context: 1, path: 'src/sparse.txt' }, inMachine), /src\/sparse\.txt:598: {3}hit 199\nsrc\/sparse\.txt-599- {3}gap 199\n\(more matches/);
	assert.equal(await files.grepTask(id, { pattern: 'nothing like this' }, inMachine), 'No matches.');
	assert.match(await files.grepTask(id, { pattern: '(' }, inMachine), /^The search failed: /);
});

test('without rg the sandbox searches with grep and lists with git, to the same answers', async () => {
	const input = { pattern: 'answer', path: 'src' };
	const found = 'src/app.ts:1: import { answer } from "./deep";\nsrc/app.ts:2: console.log(answer, "changed in the sandbox");\nsrc/components/button.tsx:1: export const Button = () => "answer";';
	assert.equal(await files.searchMachine(machine, root, `${root}/src`, input, {}, 'grep'), found);
	const context = { pattern: 'line 20$', context: 2 };
	const around = 'src/long.txt-18- line 18\nsrc/long.txt-19- line 19\nsrc/long.txt:20: line 20\nsrc/long.txt-21- line 21\nsrc/long.txt-22- line 22';
	assert.equal(await files.searchMachine(machine, root, `${root}/src/long.txt`, context, {}, 'grep'), around);
	const only = { pattern: 'answer', filesOnly: true, glob: 'components/*.tsx' };
	assert.equal(await files.searchMachine(machine, root, `${root}/src`, only, {}, 'grep'), 'src/components/button.tsx');
	// A class such as \d is read as rg reads it, not as the letter d.
	assert.equal(await files.searchMachine(machine, root, `${root}/src/long.txt`, { pattern: 'line 45\\d$', filesOnly: true }, {}, 'grep'), 'src/long.txt');
	assert.equal(await files.globMachine(machine, root, root, '*.js', 'list'), 'No files match.', 'node_modules is left out');
	// Against rg itself, where this machine has it (a test machine may not).
	if ((await machine.exec('command -v rg')).exitCode === 0) {
		assert.equal(await files.searchMachine(machine, root, `${root}/src`, input, {}, 'rg'), found);
		assert.equal(await files.searchMachine(machine, root, `${root}/src/long.txt`, context, {}, 'rg'), around);
		for (const pattern of ['*.ts', '**/*.tsx', 'src/**', '*.yml', '*.js']) {
			assert.equal(await files.globMachine(machine, root, root, pattern, 'list'), await files.globMachine(machine, root, root, pattern, 'rg'), pattern);
		}
	}
	// The command picks rg itself when the machine has it.
	assert.match(files.searchCommand(input, 'src'), /if command -v rg >\/dev\/null 2>&1; then echo @rg; rg .*; else echo @grep; p=E; echo \| grep -qP '' 2>\/dev\/null && p=P; grep -rIHn\$p/);
});

test('glob lists the same paths from the snapshot and the sandbox, and leaves out node_modules and .git', async () => {
	for (const pattern of ['*.ts', '**/*.tsx', '*.yml', 'components/*']) {
		assert.equal(await files.globTask(id, { pattern }, noMachine), await files.globTask(id, { pattern }, inMachine), pattern);
	}
	assert.equal(await files.globTask(id, { pattern: 'components/*', path: 'src' }, noMachine), 'src/components/button.tsx');
	assert.equal(await files.globTask(id, { pattern: '*.js' }, inMachine), 'No files match.');
	assert.doesNotMatch(await files.globTask(id, { pattern: '*' }, inMachine), /node_modules|\.git\//);
});

test('a read sees the sandbox once the first command has run, and never the snapshot after', async () => {
	const task = (await sessions.createSession({ projectId: project.id, title: 'Change' })).id;
	const real = { machine: async () => machine, root: async () => root, secrets: async () => ({}) };
	assert.match(await files.readTaskFile(task, { path: 'src/app.ts' }, real), /2\tconsole\.log\(answer\);/, 'the snapshot before');
	assert.ok(!runner.hasWorkspace(task));
	await files.workMachine(task, real);
	assert.ok(runner.hasWorkspace(task), 'a command gives the task its workspace');
	assert.match(await files.readTaskFile(task, { path: 'src/app.ts' }, real), /changed in the sandbox/);
	assert.match(await files.grepTask(task, { pattern: 'changed' }, real), /^src\/app\.ts:2: /);
	assert.equal(await files.globTask(task, { pattern: 'secret.env' }, real), 'secret.env', 'a file only the sandbox has');
});

test('a task that had a machine in an earlier reply reads it, started again, never the snapshot at its base', async () => {
	const task = (await sessions.createSession({ projectId: project.id, title: 'Earlier' })).id;
	const { updateSession } = await import('../src/db/sessions.ts');
	// Its machine ran and stopped: the record keeps how to resume it, and priming the next message reads that.
	await updateSession(task, { machineState: JSON.stringify({ key: task }) });
	await runner.primeAgent(task, { warm: false });
	assert.ok(runner.hasWorkspace(task));
	let starts = 0;
	const stopped = { machine: async () => (starts++, machine), root: async () => root, secrets: async () => ({}) };
	assert.match(await files.readTaskFile(task, { path: 'src/app.ts' }, stopped), /changed in the sandbox/);
	assert.equal(starts, 1, 'the read waited for the machine rather than read the snapshot');
});

test('code mode reads the task through read, grep and glob, from wherever its tools read', async () => {
	const description = scriptToolDescription(id, { repo: 'task', mcp: false });
	assert.match(description, /glob[\s\S]*read[\s\S]*grep/);
	assert.doesNotMatch(description, /list_files|read_file|search_code/);
	const result = await runScript(id, "const paths = await tools.glob({ pattern: '*.tsx' }); return { paths, text: await tools.read({ path: paths[0] }), hits: await tools.grep({ pattern: 'Button', filesOnly: true }) };", { repo: 'task', mcp: false });
	assert.deepEqual(JSON.parse(result), { paths: ['src/components/button.tsx'], text: 'export const Button = () => "answer";\n', hits: 'src/components/button.tsx' });
	// A chat or plan before its sandbox keeps the snapshot tools by their old names.
	assert.match(scriptToolDescription(id, { repo: true, mcp: false }), /list_files[\s\S]*read_file[\s\S]*search_code/);
	assert.ok(!started.includes(id), 'no machine was started');
});

/** Flue's internal functions the runtime renders an agent and composes its prompt with, found by name in its build. */
async function flueInternals(): Promise<{ render: (agent: unknown, state: unknown) => { config: Record<string, unknown> }; discover: (env: unknown) => Promise<{ recompose: (instructions?: string) => string }>; hookState: (snapshot: Map<string, unknown>) => unknown; jsonSchema: (schema: unknown) => unknown }> {
	const dist = new URL('../node_modules/@flue/runtime/dist/', import.meta.url);
	const find = async (name: string) => {
		for (const file of readdirSync(dist).filter((entry) => entry.endsWith('.mjs'))) {
			const alias = new RegExp(`\\b${name} as ([\\w$]+)`).exec(readFileSync(new URL(file, dist), 'utf8'))?.[1];
			if (alias) return (await import(new URL(file, dist).href))[alias];
		}
		throw new Error(`Flue has no ${name}`);
	};
	return { render: await find('renderAgentFunctionWithStructure'), discover: await find('discoverSessionContext'), hookState: await find('createHookStateBuffer'), jsonSchema: await find('valibotToJsonSchema') };
}

type Rendered = { config: { instructions?: string; tools?: Array<{ name: string; description: string; input?: unknown }>; sandbox?: { createSandbox: (options: { id: string }) => Promise<{ cwd: string }>; tools?: (sandbox: unknown, options: unknown) => Array<{ name: string; description: string; parameters: unknown }> }; subagents?: Array<{ name: string; description: string; agent: unknown }>; skills?: Array<{ name: string; description?: string }> } };

test('a repository task has one system prompt and one tool list before and after its workspace starts', async () => {
	const flue = await flueInternals();
	const { Coder } = await import('../src/agents/coder.ts');
	const task = (await sessions.createSession({ projectId: project.id, title: 'Same prompt' })).id;
	await runner.primeAgent(task, { warm: false });
	const render = (): Rendered => flue.render(Coder, { snapshot: new Map(), store: flue.hookState(new Map()), delivery: { kind: 'user', body: 'hi' }, instanceId: task }) as Rendered;
	/** Everything of a render a model call sends: the system prompt as the runtime composes it (with what it discovers), and each tool's bytes. */
	const sent = async ({ config: rendered }: Rendered) => {
		assert.ok(rendered.sandbox, 'the sandbox is there from the first call');
		const env = await rendered.sandbox.createSandbox({ id: task });
		const prompt = (await flue.discover(env)).recompose(rendered.instructions);
		const adapter = (rendered.sandbox.tools?.(env, { subagents: {} }) ?? []).map((tool) => JSON.stringify([tool.name, tool.description, tool.parameters]));
		const custom = (rendered.tools ?? []).map((tool) => JSON.stringify([tool.name, tool.description, tool.input ? flue.jsonSchema(tool.input) : null]));
		const roster = JSON.stringify([(rendered.subagents ?? []).map(({ name, description }) => [name, description]), (rendered.skills ?? []).map(({ name, description }) => [name, description])]);
		return { prompt, adapter, custom, roster };
	};
	const before = await sent(render());
	assert.deepEqual(before.adapter.map((tool) => JSON.parse(tool)[0]), ['read', 'write', 'edit', 'bash', 'grep', 'glob']);
	const names = before.custom.map((tool) => JSON.parse(tool)[0]);
	for (const tool of ['run_in_background', 'check_job', 'open_pull_request', 'merge_base_branch', 'check_preview', 'screenshot']) assert.ok(names.includes(tool), tool);
	for (const tool of ['start_workspace', 'list_files', 'read_file', 'search_code']) assert.ok(!names.includes(tool), tool);
	// The repository's instructions are in the prompt, from the commit the task started at; the runtime finds no AGENTS.md or listing of its own.
	assert.match(before.prompt, /The repository's own instructions for agents \(AGENTS\.md, CLAUDE\.md\):\nRun npm test before you finish\./);
	assert.equal(before.prompt.match(/Run npm test before you finish/g)?.length, 1);
	assert.doesNotMatch(before.prompt, /Directory structure:|start_workspace/);
	assert.match(before.prompt, new RegExp(`Working directory: ${root.replace(/[/.]/g, '\\$&').replace('work', task)}`));

	// The first command gives the task its workspace mid-reply; the next render, and the next reply's, are the same.
	runner.noteWorkspace(task);
	const after = await sent(render());
	assert.equal(after.prompt, before.prompt);
	assert.deepEqual(after.adapter, before.adapter);
	assert.deepEqual(after.custom, before.custom);
	assert.equal(after.roster, before.roster);
	assert.ok(!started.includes(task), 'neither rendering nor composing the prompt started a machine');
});

test('reading, searching and listing, and the explorer, never start a machine for a task without a workspace', async () => {
	const flue = await flueInternals();
	const { Coder } = await import('../src/agents/coder.ts');
	const task = (await sessions.createSession({ projectId: project.id, title: 'Only reads' })).id;
	await runner.primeAgent(task, { warm: false });
	const rendered = flue.render(Coder, { snapshot: new Map(), store: flue.hookState(new Map()), delivery: { kind: 'user', body: 'hi' }, instanceId: task }) as Rendered;
	const env = await rendered.config.sandbox!.createSandbox({ id: task });
	const tools = rendered.config.sandbox!.tools!(env, { subagents: {} }) as unknown as Array<{ name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }>;
	const call = async (name: string, params: unknown) => (await tools.find((tool) => tool.name === name)!.execute('call', params)).content.map((part) => part.text ?? part.type).join('');
	assert.equal(await call('read', { path: 'src/app.ts', limit: 1 }), '1\timport { answer } from "./deep";\n(lines 1-1 of 4; read on with offset 2)');
	// An image from the snapshot reaches the model whole: this one cannot see, and no vision model is set up to describe it.
	assert.match(await call('read', { path: 'logo.png' }), /^logo\.png is an image, and your model cannot see images/);
	assert.equal(await call('grep', { pattern: 'console' }), 'src/app.ts:2: console.log(answer);');
	assert.equal(await call('glob', { pattern: '*.tsx' }), 'src/components/button.tsx');
	// The explorer reads through the same tools, and with code mode through the same files; its own tools start nothing.
	const explorer = rendered.config.subagents!.find((subagent) => subagent.name === 'explorer')!;
	const own = (flue.render(explorer.agent, { snapshot: new Map(), store: flue.hookState(new Map()) }) as Rendered).config;
	assert.match(own.instructions ?? '', /Investigate with read, grep and glob/);
	assert.match(own.instructions ?? '', /Run npm test before you finish/);
	assert.deepEqual((own.tools ?? []).map((tool) => tool.name), ['run_script']);
	assert.match(await runScript(task, "return await tools.read({ path: 'README.md' });", { repo: 'task', mcp: false }), /# demo/);
	assert.ok(!started.includes(task), 'no machine was started');
	assert.ok(!(await local.running()).has(task));
});

test('chats and plan mode keep their read-only tools and start_workspace, and no sandbox until they have one', async () => {
	const flue = await flueInternals();
	const { Coder } = await import('../src/agents/coder.ts');
	const render = (task: string) => flue.render(Coder, { snapshot: new Map(), store: flue.hookState(new Map()), delivery: { kind: 'user', body: 'hi' }, instanceId: task }) as Rendered;
	const chat = (await sessions.createSession({ title: 'A chat' })).id;
	await runner.primeAgent(chat, { warm: false });
	const chatTools = (render(chat).config.tools ?? []).map((tool) => tool.name);
	assert.equal(render(chat).config.sandbox, undefined);
	for (const tool of ['list_files', 'read_file', 'search_code', 'start_workspace']) assert.ok(chatTools.includes(tool), tool);
	assert.match(render(chat).config.instructions ?? '', /call start_workspace for a scratch sandbox/);

	const plan = (await sessions.createSession({ projectId: project.id, title: 'A plan', planMode: true })).id;
	await runner.primeAgent(plan, { warm: false });
	const planned = render(plan).config;
	const planTools = (planned.tools ?? []).map((tool) => tool.name);
	assert.equal(planned.sandbox, undefined);
	for (const tool of ['list_files', 'read_file', 'search_code', 'propose_plan']) assert.ok(planTools.includes(tool), tool);
	for (const tool of ['start_workspace', 'run_in_background', 'open_pull_request']) assert.ok(!planTools.includes(tool), tool);
	assert.match(planned.instructions ?? '', /You start read-only, with no sandbox[\s\S]*Plan mode is on/);
});
