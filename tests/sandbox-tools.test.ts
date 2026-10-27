import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sandbox } from '@flue/runtime';
import { MAX_IMAGE_BYTES, sandboxTools } from '../src/flue/sandbox-tools.ts';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const files: Record<string, Uint8Array> = {
	'notes.txt': new TextEncoder().encode('one\ntwo\n'),
	'../project-files/reference.png': png,
	'huge.jpg': new Uint8Array(MAX_IMAGE_BYTES + 1),
};
const sandbox = {
	cwd: '/repo',
	readFile: async (path: string) => new TextDecoder().decode(files[path]),
	readFileBuffer: async (path: string) => files[path],
} as unknown as Sandbox;

function readTool(sees: boolean) {
	const described: string[] = [];
	const tools = sandboxTools({ sees: async () => sees, describe: async (_bytes, mimeType) => (described.push(mimeType), 'A diagram of three boxes.') })(sandbox, { subagents: {} });
	const read = tools.find((tool) => tool.name === 'read')!;
	return { tools, described, read: (path: string) => read.execute('call', { path }) };
}

test('read shows an image as a picture to a model that sees, and reads other files as text', async () => {
	const { tools, read } = readTool(true);
	assert.deepEqual(tools.map((tool) => tool.name), ['read', 'write', 'edit', 'bash', 'grep', 'glob']);
	const image = await read('../project-files/reference.png');
	assert.deepEqual(image.content[1], { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' });
	const notes = await read('notes.txt');
	assert.equal(notes.content.length, 1);
	assert.match((notes.content[0] as { text: string }).text, /one\ntwo/);
	const huge = await read('huge.jpg');
	assert.match((huge.content[0] as { text: string }).text, /too large/);
});

test('read describes an image in words for a model that cannot see', async () => {
	const { read, described } = readTool(false);
	const image = await read('../project-files/reference.png');
	assert.equal(image.content.length, 1);
	assert.match((image.content[0] as { text: string }).text, /a vision model described it:\n\nA diagram of three boxes\./);
	assert.deepEqual(described, ['image/png']);
});

test('edit makes several replacements in one call, across files, all or none', async () => {
	const disk: Record<string, string> = { 'a.ts': 'const a = 1;\nconst b = 2;\n', 'b.ts': 'export const c = 3;\n' };
	const box = {
		cwd: '/repo',
		readFile: async (path: string) => {
			if (!(path in disk)) throw new Error(`No such file: ${path}`);
			return disk[path];
		},
		writeFile: async (path: string, content: string) => void (disk[path] = content),
	} as unknown as Sandbox;
	const edit = sandboxTools({ sees: async () => true, describe: async () => '' })(box, { subagents: {} }).find((tool) => tool.name === 'edit')!;
	const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

	const many = await edit.execute('call', {
		path: 'a.ts',
		oldText: 'const a = 1;',
		newText: 'const a = 10;',
		more: [{ oldText: 'const b = 2;', newText: 'const b = 20;' }, { path: 'b.ts', oldText: '3', newText: '30' }],
	});
	assert.equal(textOf(many), 'Made 3 edits in 2 files: a.ts, b.ts.');
	assert.deepEqual(disk, { 'a.ts': 'const a = 10;\nconst b = 20;\n', 'b.ts': 'export const c = 30;\n' });

	// One that cannot be made changes nothing, and says which it was.
	await assert.rejects(
		edit.execute('call', { path: 'a.ts', oldText: 'const a = 10;', newText: 'const a = 0;', more: [{ path: 'b.ts', oldText: 'missing', newText: 'x' }] }),
		/Edit 2 of 2: Could not find the exact text in b\.ts.*No file was changed\./,
	);
	assert.equal(disk['a.ts'], 'const a = 10;\nconst b = 20;\n');
	// Later edits see the earlier ones; replaceAll works as Flue's.
	await edit.execute('call', { path: 'a.ts', oldText: 'const', newText: 'let', replaceAll: true, more: [{ oldText: 'let a = 10', newText: 'let a = 11' }] });
	assert.equal(disk['a.ts'], 'let a = 11;\nlet b = 20;\n');
	// Without `more`, it is Flue's own edit.
	assert.match(textOf(await edit.execute('call', { path: 'b.ts', oldText: '30', newText: '31' })), /Successfully edited b\.ts/);
	assert.equal(disk['b.ts'], 'export const c = 31;\n');
});
