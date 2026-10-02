import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentModel, toModelInfo } from '../src/providers/openrouter/catalog.ts';

const flash = {
	id: '~deepseek/deepseek-flash-latest',
	name: 'DeepSeek: DeepSeek Flash Latest',
	created: 1789399150,
	context_length: 1048576,
	architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
	pricing: { prompt: '0.00000002', completion: '0.00000042' },
	top_provider: { max_completion_tokens: 384000 },
	supported_parameters: ['reasoning', 'tools'],
	reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['max', 'high', 'low'], default_effort: 'high' },
};

test('an OpenRouter model maps to the catalog shape', () => {
	const info = toModelInfo(flash);
	assert.equal(info.id, 'openrouter/~deepseek/deepseek-flash-latest');
	assert.deepEqual([info.vendor, info.name], ['DeepSeek', 'DeepSeek Flash Latest']);
	assert.deepEqual(info.price, { input: 0.02, output: 0.42 });
	assert.deepEqual(info.reasoning, ['low', 'high', 'max']);
	assert.equal(info.defaultReasoning, 'high');
	assert.equal(info.vision, true);
	assert.equal(info.createdAt, 1789399150000);
});

test('reasoning levels follow what the model declares', () => {
	const levels = (reasoning: object | null, params = ['reasoning', 'tools']) =>
		toModelInfo({ ...flash, supported_parameters: params, reasoning } as typeof flash).reasoning;
	assert.deepEqual(levels(null), ['off', 'low', 'medium', 'high']);
	assert.deepEqual(levels({ mandatory: true }), ['low', 'medium', 'high']);
	assert.deepEqual(levels({ supported_efforts: ['none', 'medium'] }), ['off', 'medium']);
	assert.deepEqual(levels(null, ['tools']), []);
	assert.equal(toModelInfo({ ...flash, reasoning: { mandatory: false } as never }).defaultReasoning, 'off');
});

test('only tool-calling text models are offered to the agent', () => {
	assert.equal(isAgentModel(flash), true);
	assert.equal(isAgentModel({ ...flash, supported_parameters: ['reasoning'] }), false);
	assert.equal(isAgentModel({ ...flash, architecture: { output_modalities: ['image'] } }), false);
	assert.equal(isAgentModel({ ...flash, id: 'deepseek/deepseek-v4.1-flash:batch' }), false);
});
