import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { machineSandbox } from '../src/flue/machine-sandbox.ts';
import { sandboxTools } from '../src/flue/sandbox-tools.ts';
import { localSandboxProvider } from '../src/providers/local/sandbox.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-patch-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const sight = { sees: async () => false, describe: async () => '' };
const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

/** A machine on this computer with a repository folder, and the patch profile's tools over it, writable while `planning` says no. */
async function setUp(key: string) {
	const { machine } = await localSandboxProvider(dir).acquire({ key, state: null, image: null } as never);
	const repo = path.join(machine.root, 'repo');
	mkdirSync(path.join(repo, 'src'), { recursive: true });
	const state = { planning: false };
	const sandbox = machineSandbox(machine, repo, () => !state.planning);
	const tools = sandboxTools(sight, 'patch')(sandbox, { subagents: {} });
	const tool = tools.find((each) => each.name === 'apply_patch')!;
	const run = async (input: string) => ((await tool.execute('call', { input })).content[0] as { text: string }).text;
	return { root: machine.root, repo, state, tools, run };
}

test('apply_patch writes through the sandbox: paths from the working folder, absolute or outside the repository, folders made for new files', async () => {
	const { root, repo, run } = await setUp('paths');
	writeFileSync(path.join(repo, 'src', 'app.ts'), 'const a = 1;\r\nconst b = 2;\r\n');
	writeFileSync(path.join(repo, 'old.txt'), 'old\n');
	writeFileSync(path.join(repo, 'name.txt'), 'name\n');
	const result = await run(
		patch(
			'*** Update File: src/app.ts',
			'@@',
			'-const a = 1;',
			'+const a = 3;',
			'*** Add File: src/deep/new/file.ts',
			'+export {};',
			`*** Add File: ${path.join(root, 'elsewhere', 'abs.txt')}`,
			'+absolute',
			'*** Add File: ../outputs/report.md',
			'+# Report',
			'*** Delete File: old.txt',
			'*** Update File: name.txt',
			'*** Move to: docs/name.txt',
		),
	);
	assert.equal(result, `Success. Updated the following files:\nM src/app.ts\nA src/deep/new/file.ts\nA ${path.join(root, 'elsewhere', 'abs.txt')}\nA ../outputs/report.md\nD old.txt\nM name.txt -> docs/name.txt`);
	assert.equal(readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8'), 'const a = 3;\r\nconst b = 2;\r\n');
	assert.equal(readFileSync(path.join(repo, 'src', 'deep', 'new', 'file.ts'), 'utf8'), 'export {};\n');
	assert.equal(readFileSync(path.join(root, 'elsewhere', 'abs.txt'), 'utf8'), 'absolute\n');
	assert.equal(readFileSync(path.join(root, 'outputs', 'report.md'), 'utf8'), '# Report\n');
	assert.equal(readFileSync(path.join(repo, 'docs', 'name.txt'), 'utf8'), 'name\n');
	assert.equal(existsSync(path.join(repo, 'old.txt')), false);
	assert.equal(existsSync(path.join(repo, 'name.txt')), false);
});

test('apply_patch changes nothing when one hunk of one file does not fit, and says so', async () => {
	const { repo, run } = await setUp('all-or-nothing');
	writeFileSync(path.join(repo, 'a.txt'), 'a\n');
	writeFileSync(path.join(repo, 'b.txt'), 'b\n');
	await assert.rejects(
		run(patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Add File: c.txt', '+c', '*** Delete File: b.txt', '*** Update File: b.txt', '@@', '-missing', '+x')),
		/Cannot update b\.txt: there is no such file\.\nNo file was changed\./,
	);
	await assert.rejects(run(patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: b.txt', '@@', '-missing', '+x')), /Hunk 1 of 1 for b\.txt does not fit[\s\S]*missing\nNo file was changed\.$/);
	assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'a\n');
	assert.equal(readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'b\n');
	assert.equal(existsSync(path.join(repo, 'c.txt')), false);
	await assert.rejects(run('*** Begin Patch\n*** Add File: x\n+x'), /must end with "\*\*\* End Patch"\.\nNo file was changed\./);
});

test('in plan mode apply_patch refuses to write and to delete, and leaves the files as they were', async () => {
	const { repo, state, run } = await setUp('plan');
	writeFileSync(path.join(repo, 'keep.txt'), 'keep\n');
	state.planning = true;
	await assert.rejects(run(patch('*** Delete File: keep.txt')), /Plan mode is on[\s\S]*No file was changed\./);
	await assert.rejects(run(patch('*** Update File: keep.txt', '@@', '-keep', '+changed', '*** Add File: new.txt', '+new')), /Plan mode is on/);
	assert.equal(readFileSync(path.join(repo, 'keep.txt'), 'utf8'), 'keep\n');
	assert.equal(existsSync(path.join(repo, 'new.txt')), false);
	state.planning = false;
	await run(patch('*** Delete File: keep.txt'));
	assert.equal(existsSync(path.join(repo, 'keep.txt')), false);
});

test('apply_patch waits on edits to the same files and other patches, so none is lost', async () => {
	const { repo, run } = await setUp('locks');
	writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
	writeFileSync(path.join(repo, 'b.txt'), 'three\n');
	await Promise.all([
		run(patch('*** Update File: a.txt', '@@', '-one', '+ONE', '*** Update File: b.txt', '@@', '-three', '+THREE')),
		run(patch('*** Update File: b.txt', '@@', '-THREE', '+3', '*** Update File: a.txt', '@@', '-two', '+TWO')),
	]);
	assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'ONE\nTWO\n');
	assert.equal(readFileSync(path.join(repo, 'b.txt'), 'utf8'), '3\n');
});

test('the patch profile has apply_patch in place of write and edit; the edit profile is as it was', async () => {
	const { tools } = await setUp('lists');
	assert.deepEqual(tools.map((tool) => tool.name), ['read', 'apply_patch', 'bash', 'grep', 'glob']);
	const sandbox = { cwd: '/repo', resolvePath: (file: string) => file } as never;
	assert.deepEqual(sandboxTools(sight)(sandbox, { subagents: {} }).map((tool) => tool.name), ['read', 'write', 'edit', 'bash', 'grep', 'glob']);
	assert.deepEqual(sandboxTools(sight, 'edit')(sandbox, { subagents: {} }).map((tool) => tool.name), ['read', 'write', 'edit', 'bash', 'grep', 'glob']);
	const apply = tools.find((tool) => tool.name === 'apply_patch')!;
	assert.deepEqual(Object.keys((apply.parameters as { properties: object }).properties), ['input']);
	// Sent with every call: kept to a few lines.
	assert.ok(apply.description.length < 600, `${apply.description.length} characters`);
});

test('a write that fails part way puts back the files already written', async () => {
	const disk: Record<string, string> = { '/r/a.txt': 'a\n', '/r/b.txt': 'b\n' };
	const at = (file: string) => (file.startsWith('/') ? file : `/r/${file}`);
	const sandbox = {
		cwd: '/r',
		resolvePath: at,
		readFile: async (file: string) => {
			if (!(at(file) in disk)) throw new Error('missing');
			return disk[at(file)];
		},
		writeFile: async (file: string, content: string) => {
			if (at(file) === '/r/b.txt' && content === 'B\n') throw new Error('disk full');
			disk[at(file)] = content;
		},
		rm: async (file: string) => void delete disk[at(file)],
	} as never;
	const tool = sandboxTools(sight, 'patch')(sandbox, { subagents: {} }).find((each) => each.name === 'apply_patch')!;
	await assert.rejects(tool.execute('call', { input: patch('*** Add File: c.txt', '+c', '*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: b.txt', '@@', '-b', '+B') }), /^Error: disk full\nNo file was changed\.$/);
	assert.deepEqual(disk, { '/r/a.txt': 'a\n', '/r/b.txt': 'b\n' });
});
