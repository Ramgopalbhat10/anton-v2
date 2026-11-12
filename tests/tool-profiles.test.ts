import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { asToolProfileSetting, madeByOpenAi, toolProfileFor } from '../src/core/tool-profile.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-profiles-'));
process.env.ANTON_DATA_DIR = path.join(dir, 'data');
after(() => rmSync(dir, { recursive: true, force: true }));

test("a model's family is told by its maker, however it is reached", () => {
	const openai = [
		'openai/gpt-6.1-terra[872k]', // a ChatGPT plan, with its larger context
		'openai/gpt-5.1-codex[fast]',
		'openrouter/openai/gpt-5.1',
		'openrouter/~openai/gpt-latest',
		'openrouter/openai/gpt-oss-120b#via=groq',
		'openrouter/openai/o4-mini#sort=price',
		'vercel/openai/gpt-5-codex',
		'opencode-go/gpt-5.1-codex',
		'cursor/gpt-5.1-codex-high',
		'cursor/o3',
	];
	const others = [
		'claude-code/claude-opus-5-5[1m]',
		'cursor/claude-4.5-sonnet',
		'cursor/composer-1',
		'openrouter/anthropic/claude-haiku-5.5',
		'openrouter/~deepseek/deepseek-flash-latest',
		'openrouter/z-ai/glm-5',
		'openrouter/openchat/openchat-7b',
		'vercel/anthropic/claude-sonnet-4.5',
		'vercel/xai/grok-4',
		'opencode-go/kimi-k2.5',
		'opencode-go/glm-5',
	];
	for (const model of openai) assert.equal(madeByOpenAi(model), true, model);
	for (const model of others) assert.equal(madeByOpenAi(model), false, model);
	for (const model of openai) assert.equal(toolProfileFor(model), 'patch', model);
	for (const model of others) assert.equal(toolProfileFor(model), 'edit', model);
});

test('ANTON_TOOL_PROFILE forces one profile for every model, and anything else picks by the model', () => {
	assert.equal(toolProfileFor('openrouter/anthropic/claude-haiku-5.5', 'patch'), 'patch');
	assert.equal(toolProfileFor('openai/gpt-5.1', 'edit'), 'edit');
	assert.equal(toolProfileFor('openai/gpt-5.1', 'auto'), 'patch');
	assert.equal(asToolProfileSetting('patch'), 'patch');
	assert.equal(asToolProfileSetting('edit'), 'edit');
	assert.equal(asToolProfileSetting(''), 'auto');
	assert.equal(asToolProfileSetting('codex'), 'auto');
	assert.match(readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8'), /toolProfile: asToolProfileSetting\(read\('ANTON_TOOL_PROFILE', 'auto'\)\)/);
});

const frozen = JSON.parse(readFileSync(new URL('./fixtures/edit-profile-prompts.json', import.meta.url), 'utf8')) as Record<'task' | 'workspace' | 'chatWorkspace' | 'read', string>;

/** The read tool's description in a repository task, under the profile. */
async function readDescription(profile: 'edit' | 'patch') {
	const { taskTools } = await import('../src/flue/task-sandbox.ts');
	const tools = taskTools({} as never, { sees: async () => false, describe: async () => '' }, profile)({ cwd: '/repo', resolvePath: (file: string) => file } as never, { subagents: {} });
	return { names: tools.map((tool) => tool.name), read: tools.find((tool) => tool.name === 'read')!.description };
}

test('on the edit profile the prompts and the read tool are byte for byte what they were before profiles', async () => {
	const { workspacePrompts } = await import('../src/agents/coder.ts');
	const prompts = workspacePrompts('edit');
	assert.equal(prompts.task, frozen.task);
	assert.equal(prompts.workspace, frozen.workspace);
	assert.equal(prompts.chatWorkspace, frozen.chatWorkspace);
	const tools = await readDescription('edit');
	assert.equal(tools.read, frozen.read);
	assert.deepEqual(tools.names, ['read', 'write', 'edit', 'bash', 'grep', 'glob']);
});

test('on the patch profile the prompts name apply_patch and no tool it lacks, and keep every check the edit profile asks for', async () => {
	const { workspacePrompts } = await import('../src/agents/coder.ts');
	const prompts = workspacePrompts('patch');
	const tools = await readDescription('patch');
	assert.deepEqual(tools.names, ['read', 'apply_patch', 'bash', 'grep', 'glob']);
	assert.doesNotMatch(tools.read, /\bedit\b|oldText/);
	assert.match(tools.read, /leave the numbers out of a patch/);
	for (const name of ['task', 'workspace', 'chatWorkspace'] as const) {
		const text = prompts[name];
		assert.match(text, /one apply_patch call can change several files and several places in each/, name);
		assert.doesNotMatch(text, /\bedit\b|\bedits\b|oldText|newText|write tool/, name);
		// Only the editing hints differ: every sentence about checking the work is the edit profile's own.
		const sentences = (prompt: string) => new Set(prompt.split(/(?<=\.) /));
		const lost = [...sentences(frozen[name])].filter((sentence) => !sentences(text).has(sentence));
		assert.ok(lost.every((sentence) => /\bedit\b/.test(sentence)), `${name} lost: ${lost.join(' | ')}`);
		assert.ok(lost.length <= 2, name);
	}
	assert.match(prompts.task, /Your first command or patch starts the sandbox/);
});
