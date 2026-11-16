import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-setup-'));
process.env.ANTON_DATA_DIR = dir;
// One value the server's environment gives, and one the saved file lays over it.
process.env.ANTON_GITHUB_TOKEN = 'ghp_fromtheenvironment1234';
process.env.ANTON_WEB_MCP_URL = 'https://env.example/mcp';
delete process.env.MODAL_TOKEN_ID;
delete process.env.MODAL_TOKEN_SECRET;
// This server starts on Docker, so choosing this server's folders waits for a restart.
process.env.ANTON_SANDBOX = 'docker';
writeFileSync(path.join(dir, 'anton.env'), 'ANTON_WEB_MCP_URL="https://saved.example/mcp"\nNOT A LINE\n');

const { config } = await import('../src/config.ts');
const savedEnv = await import('../src/saved-env.ts');
const { setProviders } = await import('../src/providers/index.ts');
const setup = await import('../src/services/settings/setup.ts');

setProviders({
	sandbox: { name: 'local' } as never,
	store: { name: 'disk' } as never,
	git: { name: 'github' } as never,
	models: { name: 'openrouter', list: async () => [] } as never,
});

after(() => {
	savedEnv.resetSavedEnv();
	rmSync(dir, { recursive: true, force: true });
});

test('a saved value is read over the environment, which a line the file cannot parse does not change', () => {
	assert.equal(config.web.mcpUrl, 'https://saved.example/mcp');
	assert.equal(savedEnv.environmentValue('ANTON_WEB_MCP_URL'), 'https://env.example/mcp');
	assert.equal(config.github.token, 'ghp_fromtheenvironment1234');
});

test('the setup never sends a secret back, only where it comes from and its last four characters', async () => {
	const view = await setup.setupView();
	const git = view.slots.find((slot) => slot.id === 'git')!;
	const token = git.options[0].fields.find((field) => field.env === 'ANTON_GITHUB_TOKEN')!;
	assert.deepEqual({ source: token.source, value: token.value, hint: token.hint }, { source: 'environment', value: null, hint: '1234' });
	assert.ok(!JSON.stringify(view).includes('fromtheenvironment'));
	const web = view.slots.find((slot) => slot.id === 'web')!;
	assert.equal(web.provider, 'mcp');
	const url = web.options.find((option) => option.id === 'mcp')!.fields.find((field) => field.env === 'ANTON_WEB_MCP_URL')!;
	assert.deepEqual({ source: url.source, value: url.value }, { source: 'saved', value: 'https://saved.example/mcp' });
	assert.equal(view.canRunTasks, false);
});

test('a test names what is missing, and keeps nothing', async () => {
	await assert.rejects(setup.testSlot('sandbox', 'modal', {}), /Token ID and Token secret are needed/);
	await assert.rejects(setup.testSlot('sandbox', 'nowhere', {}), /no provider "nowhere"/);
	assert.equal(savedEnv.savedValue('MODAL_TOKEN_ID'), undefined);
});

test('a live slot applies at once, and clearing it gives the environment its value back', async () => {
	const saved = await setup.saveSlot('web', 'off', {});
	assert.equal(saved.restart, false);
	assert.equal(config.web.mcpUrl, 'off');
	const file = path.join(dir, 'anton.env');
	assert.match(readFileSync(file, 'utf8'), /^ANTON_WEB_MCP_URL="off"$/m);
	assert.equal(statSync(file).mode & 0o777, 0o600);

	await setup.clearSlot('web', '');
	assert.equal(config.web.mcpUrl, 'https://env.example/mcp');
	assert.equal(savedEnv.savedValue('ANTON_WEB_MCP_URL'), undefined);
});

test('a slot read at start waits for a restart, which the view says until it is put back', async () => {
	const saved = await setup.saveSlot('sandbox', 'local', {});
	assert.equal(saved.restart, true);
	assert.equal(config.sandbox, 'docker');
	assert.equal(process.env.ANTON_SANDBOX, 'docker', 'the running process keeps what it started with');
	let sandbox = (await setup.setupView()).slots.find((slot) => slot.id === 'sandbox')!;
	assert.deepEqual({ provider: sandbox.provider, restart: sandbox.restart }, { provider: 'local', restart: true });

	await setup.clearSlot('sandbox', '');
	sandbox = (await setup.setupView()).slots.find((slot) => slot.id === 'sandbox')!;
	assert.deepEqual({ provider: sandbox.provider, restart: sandbox.restart, saved: sandbox.saved }, { provider: 'docker', restart: false, saved: false });
});

test('saving what already runs, under a value it only defaulted to, does not ask for a restart', async () => {
	const saved = await setup.saveSlot('store', 'disk', {});
	assert.equal(saved.restart, false);
	await setup.clearSlot('store', '');
});
