import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-images-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { openRouterImages, toImageModelInfo } = await import('../src/providers/openrouter/images.ts');
const { insertSession, getSessionRecord } = await import('../src/db/sessions.ts');
const { saveOutput, readOutput } = await import('../src/services/checkpoints.ts');
const { primeModel } = await import('../src/services/sessions.ts');
const { generateImage, imageModelFor } = await import('../src/services/images.ts');
const { generalSettings, setGeneralSettings } = await import('../src/services/general.ts');
const { onChange } = await import('../src/core/changes.ts');
const { countReplyCall, finishReply, startReply } = await import('../src/services/response-usage.ts');
const { config } = await import('../src/config.ts');
type ImageModel = import('../src/core/ports.ts').ImageModel;
type ImageModelInfo = import('../src/core/ports.ts').ImageModelInfo;

const listed: ImageModelInfo[] = [
	{ id: 'openrouter/openai/gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', vendor: 'OpenAI', description: '', references: 16, aspectRatios: ['1:1', '16:9'], transparent: true },
	{ id: 'openrouter/google/gemini-3-pro-image', name: 'Gemini 3 Pro Image', vendor: 'Google', description: '', references: 14, aspectRatios: ['1:1'], transparent: false },
	{ id: 'openrouter/recraft/recraft-v3', name: 'Recraft V3', vendor: 'Recraft', description: '', references: 0, aspectRatios: [], transparent: false },
];

// The image model draws a few bytes, and remembers what it was asked.
const asked: Array<Parameters<ImageModel['generate']>[0]> = [];
const images: ImageModel = {
	runs: (model) => model.startsWith('openrouter/'),
	list: async () => listed,
	generate: async (input) => {
		asked.push(input);
		return { image: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', inputTokens: 40, outputTokens: 1200, cost: 0.036 };
	},
};
setProviders({ sandbox: { name: 'none', find: async () => null } as never, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] }, images });
await insertSession({ id: 'img', projectId: null, title: 'Images', model: 'openrouter/anthropic/claude-haiku-5.5', reasoning: null, branch: '', baseBranch: '', baseSha: '', planMode: false });
await primeModel('img');

test('an image is drawn with the default model, kept in the Library under images/, announced and counted on the task', async () => {
	const heard: unknown[] = [];
	const stop = onChange((change) => heard.push(change));
	startReply('img');
	const made = await generateImage('img', { prompt: 'A lighthouse at dusk, watercolour', name: 'Lighthouse!', aspect_ratio: '16:9' });
	stop();
	assert.match(made.path, /^images\/lighthouse-[0-9a-f]{6}\.png$/);
	assert.equal(made.model, 'OpenAI: GPT Image 2.5 Flare');
	assert.match(made.note, /already shown to the user in the thread/);
	assert.deepEqual(await readOutput('img', made.path), new Uint8Array([137, 80, 78, 71]));
	assert.equal(asked.at(-1)!.model, config.imageModel);
	assert.equal(asked.at(-1)!.aspectRatio, '16:9');
	assert.deepEqual(asked.at(-1)!.references, []);
	assert.ok(heard.some((change) => JSON.stringify(change) === JSON.stringify({ kind: 'task', id: 'img', what: 'files' })));
	const record = await getSessionRecord('img');
	assert.equal(record!.usage.cost, 0.036);
	// The reply that made it says what it cost, though the agent's own calls were on a plan.
	countReplyCall({ type: 'turn', instanceId: 'img', response: { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } as never, request: { providerId: 'claude-code' } });
	const reply = finishReply('img')!;
	assert.equal(reply.main.cost, 0.036);
	assert.equal(reply.billing, 'api');
});

test('an image is changed from images in the Library, which must be there, be images and fit the model', async () => {
	await saveOutput('img', 'uploads/photo.jpg', new Uint8Array([255, 216, 255]), 'image/jpeg');
	const first = await generateImage('img', { prompt: 'A red fox' });
	await generateImage('img', { prompt: 'Put the fox in the photo', from: [`../outputs/${first.path}`, 'uploads/photo.jpg'] });
	assert.deepEqual(
		asked.at(-1)!.references.map((reference) => reference.mimeType),
		['image/png', 'image/jpeg'],
	);
	await assert.rejects(generateImage('img', { prompt: 'x', from: ['uploads/missing.png'] }), /not in the task's Library/);
	await assert.rejects(generateImage('img', { prompt: 'x', from: ['uploads/notes.md'] }), /not a PNG, JPEG, WebP or GIF/);
	await assert.rejects(generateImage('img', { prompt: 'x', from: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'] }), /at most 4/);
	await assert.rejects(generateImage('img', { prompt: '   ' }), /Describe the image/);
});

test('the image model is the task\'s own when it draws, else the one in Settings › General, which must be listed', async () => {
	assert.equal(await imageModelFor('img'), config.imageModel);
	const settings = await generalSettings();
	await assert.rejects(setGeneralSettings({ ...settings, imageModel: 'openrouter/nobody/unknown' }), /Unknown image model/);
	await setGeneralSettings({ ...settings, imageModel: 'openrouter/recraft/recraft-v3' });
	assert.equal(await imageModelFor('img'), 'openrouter/recraft/recraft-v3');
	// A model that draws from words alone is not asked to edit.
	await assert.rejects(generateImage('img', { prompt: 'Recolour it', from: ['uploads/photo.jpg'] }), /from words alone/);

	await insertSession({ id: 'gem', projectId: null, title: 'On an image model', model: 'openrouter/google/gemini-3-pro-image', reasoning: null, branch: '', baseBranch: '', baseSha: '', planMode: false });
	await primeModel('gem');
	assert.equal(await imageModelFor('gem'), 'openrouter/google/gemini-3-pro-image');
	await setGeneralSettings({ ...settings, imageModel: null });
});

test('without an OpenRouter key there is no image model, and the tool says how to get one', async () => {
	setProviders({ sandbox: { name: 'none', find: async () => null } as never, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] } });
	try {
		await assert.rejects(generateImage('img', { prompt: 'A cat' }), /needs an OpenRouter key/);
	} finally {
		setProviders({ sandbox: { name: 'none', find: async () => null } as never, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] }, images });
	}
});

test('OpenRouter\'s image models are listed with what they take, and asked through its Images API', async () => {
	assert.deepEqual(
		toImageModelInfo({
			id: 'openai/gpt-image-2',
			name: 'OpenAI: GPT Image 2',
			description: 'Draws.',
			supported_parameters: {
				aspect_ratio: { type: 'enum', values: ['1:1', '16:9', 'auto'] },
				background: { type: 'enum', values: ['auto', 'transparent'] },
				input_references: { type: 'range', min: 0, max: 16 },
			},
		}),
		{ id: 'openrouter/openai/gpt-image-2', name: 'GPT Image 2', vendor: 'OpenAI', description: 'Draws.', references: 16, aspectRatios: ['1:1', '16:9'], transparent: true },
	);
	const sent: Array<Record<string, unknown>> = [];
	let auth = '';
	const server = createServer((request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/images/models') {
			response.end(
				JSON.stringify({
					data: [{ id: 'openai/gpt-image-2', name: 'OpenAI: GPT Image 2', supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] }, input_references: { type: 'range', min: 0, max: 16 } } }],
				}),
			);
			return;
		}
		let body = '';
		request.on('data', (chunk) => (body += chunk));
		request.on('end', () => {
			sent.push(JSON.parse(body));
			auth = request.headers.authorization ?? '';
			response.end(JSON.stringify({ data: [{ b64_json: Buffer.from([1, 2, 3]).toString('base64'), media_type: 'image/webp' }], usage: { prompt_tokens: 12, completion_tokens: 1056, cost: 0.03 } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	try {
		const model = openRouterImages({ apiUrl: `http://127.0.0.1:${port}`, apiKey: () => 'key', ttlMs: 60_000 });
		assert.equal(model.runs('openrouter/openai/gpt-image-2'), true);
		assert.equal(model.runs('claude-code/sonnet'), false);
		assert.equal((await model.list())[0].name, 'GPT Image 2');
		const made = await model.generate({ model: 'openrouter/openai/gpt-image-2', prompt: 'A logo', references: [{ bytes: new Uint8Array([9]), mimeType: 'image/png' }], aspectRatio: '16:9', transparent: true });
		assert.deepEqual(made, { image: new Uint8Array([1, 2, 3]), mimeType: 'image/webp', inputTokens: 12, outputTokens: 1056, cost: 0.03 });
		assert.equal(auth, 'Bearer key');
		// The model leaves backgrounds as they are, so transparent is not asked for.
		assert.deepEqual(sent[0], {
			model: 'openai/gpt-image-2',
			prompt: 'A logo',
			aspect_ratio: '16:9',
			input_references: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from([9]).toString('base64')}` } }],
		});
		// A shape the model does not draw is left out rather than failing the image.
		await model.generate({ model: 'openrouter/openai/gpt-image-2', prompt: 'Tall', references: [], aspectRatio: '9:16' });
		assert.equal(sent[1].aspect_ratio, undefined);
		const keyless = openRouterImages({ apiUrl: `http://127.0.0.1:${port}`, apiKey: () => null, ttlMs: 60_000 });
		await assert.rejects(keyless.generate({ model: 'openrouter/openai/gpt-image-2', prompt: 'x', references: [] }), /needs an OpenRouter key/);
	} finally {
		server.close();
	}
});
