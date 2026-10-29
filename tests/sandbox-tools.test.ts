import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sandbox } from '@flue/runtime';
import { isWholeImage, MAX_IMAGE_BYTES, sandboxTools } from '../src/flue/sandbox-tools.ts';

/** A PNG's signature, some data, and the IEND chunk that ends every PNG. */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const files: Record<string, Uint8Array> = {
	'notes.txt': new TextEncoder().encode('one\ntwo\n'),
	'../project-files/reference.png': png,
	'huge.jpg': new Uint8Array(MAX_IMAGE_BYTES + 1),
	'../outputs/screenshots/cut.png': png.subarray(0, 14),
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

test('read never shows the model a picture cut short, which would fail every later call', async () => {
	const { read } = readTool(true);
	const cut = await read('../outputs/screenshots/cut.png');
	assert.equal(cut.content.length, 1);
	assert.match((cut.content[0] as { text: string }).text, /not a whole PNG \(14 bytes\).*Read it again/);
});

test('an image is whole only when it ends where its format says', () => {
	assert.equal(isWholeImage(png, 'image/png'), true);
	assert.equal(isWholeImage(png.subarray(0, png.length - 1), 'image/png'), false);
	assert.equal(isWholeImage(new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]), 'image/jpeg'), true);
	assert.equal(isWholeImage(new Uint8Array([0xff, 0xd8, 1, 2, 3]), 'image/jpeg'), false);
	assert.equal(isWholeImage(new Uint8Array([0x47, 0x49, 0x46, 1, 0x3b]), 'image/gif'), true);
	const webp = new Uint8Array(20);
	webp.set(new TextEncoder().encode('RIFF'), 0);
	new DataView(webp.buffer).setUint32(4, 12, true);
	webp.set(new TextEncoder().encode('WEBP'), 8);
	assert.equal(isWholeImage(webp, 'image/webp'), true);
	assert.equal(isWholeImage(webp.subarray(0, 16), 'image/webp'), false);
});

function editTool(start: Record<string, string>) {
	const disk = { ...start };
	const writes: string[] = [];
	const box = {
		cwd: '/repo',
		resolvePath: (path: string) => `/repo/${path}`,
		readFile: async (path: string) => {
			if (!(path in disk)) throw new Error(`no such file ${path}`);
			return disk[path];
		},
		writeFile: async (path: string, content: string) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			writes.push(path);
			disk[path] = content;
		},
	} as unknown as Sandbox;
	const tools = sandboxTools({ sees: async () => true, describe: async () => '' })(box, { subagents: {} });
	const edit = tools.find((tool) => tool.name === 'edit')!;
	const write = tools.find((tool) => tool.name === 'write')!;
	return { disk, writes, edit: (params: object) => edit.execute('call', params), write: (params: object) => write.execute('call', params) };
}

test('edit makes one change as before', async () => {
	const { disk, edit } = editTool({ 'a.ts': 'const a = 1;\nconst b = 2;\n' });
	const result = await edit({ path: 'a.ts', oldText: 'const a = 1;', newText: 'const a = 3;' });
	assert.equal(disk['a.ts'], 'const a = 3;\nconst b = 2;\n');
	assert.equal((result.content[0] as { text: string }).text, 'Successfully edited a.ts');
	await assert.rejects(edit({ path: 'a.ts', oldText: 'const', newText: 'let' }), /Found 2 occurrences/);
	await edit({ path: 'a.ts', oldText: 'const', newText: 'let', replaceAll: true });
	assert.equal(disk['a.ts'], 'let a = 3;\nlet b = 2;\n');
});

test('edit makes several changes to a file in one call, each on the text the one before left, and writes once', async () => {
	const { disk, writes, edit } = editTool({ 'a.ts': 'one\ntwo\nthree\n' });
	const result = await edit({
		path: 'a.ts',
		edits: [
			{ oldText: 'one', newText: 'uno' },
			{ oldText: 'uno\ntwo', newText: 'uno\ndos' },
			{ oldText: 'o', newText: '0', replaceAll: true },
		],
	});
	assert.equal(disk['a.ts'], 'un0\nd0s\nthree\n');
	assert.deepEqual(writes, ['a.ts']);
	assert.equal((result.content[0] as { text: string }).text, 'Successfully edited a.ts (3 edits)');
	assert.deepEqual(result.details, { path: 'a.ts', edits: 3, replacements: 4 });
});

test('edit changes nothing when one of its changes does not fit, and says which', async () => {
	const { disk, writes, edit } = editTool({ 'a.ts': 'one\ntwo\n' });
	await assert.rejects(
		edit({ path: 'a.ts', edits: [{ oldText: 'one', newText: '1' }, { oldText: 'three', newText: '3' }] }),
		/^Error: Edit 2 of 2: Could not find the exact text in a\.ts.*No changes made\.$/,
	);
	await assert.rejects(edit({ path: 'a.ts', edits: [{ oldText: '', newText: 'x' }] }), /oldText must be a non-empty string/);
	await assert.rejects(edit({ path: 'a.ts' }), /Give oldText and newText, or a list of edits/);
	assert.equal(disk['a.ts'], 'one\ntwo\n');
	assert.deepEqual(writes, []);
});

test('edits and writes to one file in the same step wait for each other, so none is lost', async () => {
	const { disk, edit, write } = editTool({ 'a.ts': 'a b c' });
	await Promise.all([
		edit({ path: 'a.ts', oldText: 'a', newText: 'A' }),
		edit({ path: 'a.ts', edits: [{ oldText: 'b', newText: 'B' }] }),
		edit({ path: 'a.ts', oldText: 'c', newText: 'C' }),
	]);
	assert.equal(disk['a.ts'], 'A B C');
	await Promise.all([write({ path: 'a.ts', content: 'x y' }), edit({ path: 'a.ts', oldText: 'y', newText: 'Y' })]);
	assert.equal(disk['a.ts'], 'x Y');
});
