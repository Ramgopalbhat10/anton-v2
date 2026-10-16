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
