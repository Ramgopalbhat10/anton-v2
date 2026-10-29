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
