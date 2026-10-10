import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { DecisionModel } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-reply-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { checkReply, questionOf, recordReplyText } = await import('../src/services/reply-check.ts');
const { recordLatestInput } = await import('../src/services/latest-input.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession, getSessionRecord } = await import('../src/db/sessions.ts');

const project = await upsertProject('acme/demo', 'main');
for (const id of ['a', 'b', 'c']) {
	await insertSession({ id, projectId: project.id, title: 'T', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });
}
const reply = (id: string, text: string, patch: Record<string, unknown> = {}) =>
	recordReplyText({ type: 'message_end', instanceId: id, agentName: 'Coder', session: 'default', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...patch });
const providers = (decisions: DecisionModel | null) => setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'x', list: async () => [] }, decisions });

test('the question is the reply’s last sentence that asks something, plain', () => {
	assert.equal(questionOf('I found two configs.\n\n- **Should I** merge them into one? Or keep both.'), 'Should I merge them into one?');
	assert.equal(questionOf('Done. Tests pass.'), 'Done. Tests pass.');
});

test('without a decision model, a reply ending in a question waits on you; a message from you ends that', async () => {
	providers(null);
	reply('a', 'The migration is ready. Do you want me to run it against production too?');
	await checkReply('a');
	assert.equal((await getSessionRecord('a'))?.asking, 'Do you want me to run it against production too?');
	await recordLatestInput('a', 'Yes, go ahead');
	assert.equal((await getSessionRecord('a'))?.asking, null);
	reply('a', 'Done: the tests pass and the pull request is open.');
	await checkReply('a');
	assert.equal((await getSessionRecord('a'))?.asking, null);
});

test('with one, the decision model judges; a subagent’s or the reviewer’s words are not the reply', async () => {
	const asked: unknown[] = [];
	providers({
		name: 'jev',
		async decide(state) {
			asked.push(state);
			return { answers: { waits: { yes: String(state.reply).includes('which') ? 0.9 : 0.1 } }, inputTokens: 50, cost: 0.0001 };
		},
	});
	reply('b', 'There are two ways to do this, which would you like: a cache or a queue');
	reply('b', 'Subagent notes?', { taskId: 'sub', session: 'task:default:sub' });
	reply('b', 'Review posted?', { agentName: 'Reviewer' });
	await checkReply('b');
	assert.equal(asked.length, 1);
	assert.match(String((asked[0] as { reply: string }).reply), /which would you like/);
	assert.equal((await getSessionRecord('b'))?.asking, 'There are two ways to do this, which would you like: a cache or a queue');
	// Offering more at the end of finished work is not waiting.
	reply('c', 'All done. Want me to add tests as well?');
	await checkReply('c');
	assert.equal((await getSessionRecord('c'))?.asking, null);
});

test('a reply in several messages comes back whole, while only its last words are checked for a question', async () => {
	providers(null);
	reply('a', 'The routes, grouped by area: ...');
	reply('a', 'Reported above.');
	assert.equal(await checkReply('a'), 'The routes, grouped by area: ...\n\nReported above.');
	assert.equal((await getSessionRecord('a'))?.asking, null);
	assert.equal(await checkReply('a'), null, 'the next reply starts empty');
});
