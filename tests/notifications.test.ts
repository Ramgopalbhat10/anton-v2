import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-notifications-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { upsertProject } = await import('../src/db/projects.ts');
const { getSessionRecord, insertSession, updateSession } = await import('../src/db/sessions.ts');
const { appDb } = await import('../src/db/client.ts');
const { insertToolApproval } = await import('../src/db/tool-approvals.ts');
const { onChange } = await import('../src/core/changes.ts');
const notifications = await import('../src/services/notifications.ts');

const project = await upsertProject('acme/demo', 'main');
const base = { projectId: project.id, model: 'x', reasoning: null, branch: 'b', baseBranch: 'main', baseSha: 'abc', planMode: false };
await insertSession({ ...base, id: 'task-1', title: 'Fix the login page' });
await insertSession({ ...base, id: 'task-2', title: 'Add dark mode' });

/** Lets the fire-and-forget notices land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const record = async (id: string) => (await getSessionRecord(id))!;

beforeEach(async () => {
	await (await appDb()).execute('DELETE FROM notifications');
	await updateSession('task-1', { asking: null, plan: null, planMode: false, resolvedAt: null, failed: false, errorMessage: null });
});

test("a reply's row says how it ended: what waits on you before what it said", async () => {
	await updateSession('task-1', { asking: 'Postgres or SQLite?' });
	await notifications.replyNotification('task-1', 'Which database should I use?');
	let { notifications: rows, unread } = await notifications.notificationsView();
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.kind, 'question');
	assert.equal(rows[0]!.category, 'needs-you');
	assert.equal(rows[0]!.body, 'Postgres or SQLite?');
	assert.equal(rows[0]!.title, 'Fix the login page');
	assert.equal(rows[0]!.url, '/agents/task-1');
	assert.equal(unread['needs-you'], 1);

	// The next reply replaces it: a busy task keeps one row for its last reply.
	await updateSession('task-1', { asking: null, resolvedAt: new Date().toISOString() });
	await notifications.replyNotification('task-1', 'Shipped it on SQLite.');
	({ notifications: rows, unread } = await notifications.notificationsView());
	assert.deepEqual(
		rows.map((row) => [row.kind, row.body]),
		[['done', 'Done: Shipped it on SQLite.']],
	);
	assert.equal(unread['needs-you'], 0);
	assert.equal(unread.done, 1);
});

test('a call waiting on Run is asked of you; a plain answer is a reply', async () => {
	await insertToolApproval({
		id: 'tool_1',
		sessionId: 'task-2',
		connector: 'composio:slack',
		tool: 'slack_send_message',
		args: {},
		payload: { toolkit: 'slack', slug: 'SLACK_SEND', args: {} },
		createdAt: new Date().toISOString(),
	});
	assert.deepEqual(await notifications.replyOutcome(await record('task-2'), 'Ready to post.'), {
		kind: 'approval',
		body: 'Wants to run slack_send_message on slack. Run it or turn it down.',
	});
	assert.deepEqual(await notifications.replyOutcome(await record('task-1'), 'It is in auth.ts.'), { kind: 'replied', body: 'It is in auth.ts.' });
	assert.equal(await notifications.replyOutcome(await record('task-1'), null), null);
	await updateSession('task-1', { planMode: true, plan: '1. Do it' });
	assert.equal((await notifications.replyOutcome(await record('task-1'), 'Here is the plan.'))?.kind, 'plan');
});

test("a task's sandbox, reply and pull request each keep a row of their own", async () => {
	const task = await record('task-1');
	notifications.notifySandboxReady(task, 4200);
	await settle();
	notifications.notifySandboxStopped('task-1', 5);
	await notifications.replyNotification('task-1', 'Fixed the redirect.');
	notifications.notifyPullRequest({ ...task, prUrl: 'https://github.com/acme/demo/pull/7' }, { state: 'open', checks: 'pending', runs: [] }, {
		state: 'open',
		checks: 'failed',
		runs: [{ name: 'test', status: 'failed', url: 'https://ci.test' }],
	});
	await settle();
	const { notifications: rows, unread } = await notifications.notificationsView();
	assert.deepEqual(rows.map((row) => row.kind).sort(), ['checks-failed', 'replied', 'sandbox-stopped']);
	assert.equal(rows.find((row) => row.kind === 'checks-failed')!.body, 'Checks failed on pull request #7: test');
	assert.equal(rows.find((row) => row.kind === 'sandbox-stopped')!.body, 'Sandbox stopped after 5 idle minutes. Files are saved; it starts again when needed.');
	assert.equal(unread.sandboxes, 1);
	assert.equal(unread.failures, 1);
});

test('checks that stay red, or a pull request read for the first time, are not news again', async () => {
	const task = { ...(await record('task-1')), prUrl: 'https://github.com/acme/demo/pull/7' };
	const red = { state: 'open' as const, checks: 'failed' as const, runs: [] };
	notifications.notifyPullRequest(task, red, red);
	await settle();
	assert.equal((await notifications.notificationsView()).notifications.length, 0);
	notifications.notifyPullRequest(task, red, { state: 'merged', checks: null, runs: [] });
	await settle();
	assert.deepEqual(
		(await notifications.notificationsView()).notifications.map((row) => [row.kind, row.body]),
		[['merged', 'Pull request #7 merged. The task is done.']],
	);
});

test('a task on this server has no sandbox to tell of', async () => {
	notifications.notifySandboxReady({ ...(await record('task-1')), runOn: 'host' }, 1000);
	await settle();
	assert.equal((await notifications.notificationsView()).notifications.length, 0);
});

test('rows are read by id, by task or all at once, and each change is announced', async () => {
	const changes: string[] = [];
	const stop = onChange((change) => changes.push(change.kind));
	await notifications.replyNotification('task-1', 'One.');
	await notifications.replyNotification('task-2', 'Two.');
	await notifications.markNotifications({ sessionId: 'task-1' }, true);
	let view = await notifications.notificationsView();
	assert.deepEqual(view.notifications.map((row) => [row.sessionId, row.read]).sort(), [['task-1', true], ['task-2', false]]);
	await notifications.markNotifications({ ids: [view.notifications.find((row) => row.sessionId === 'task-1')!.id] }, false);
	await notifications.markNotifications({ all: true }, true);
	view = await notifications.notificationsView();
	assert.ok(view.notifications.every((row) => row.read));
	// Reading what is already read changes nothing, and says nothing.
	const before = changes.length;
	await notifications.markNotifications({ all: true }, true);
	assert.equal(changes.length, before);
	assert.ok(changes.filter((kind) => kind === 'notifications').length >= 5);
	stop();
});

test("a deleted task's rows go with it", async () => {
	await notifications.replyNotification('task-2', 'Done here.');
	await notifications.forgetNotificationsOf('task-2');
	assert.equal((await notifications.notificationsView()).notifications.length, 0);
});

test('a failed reply from the runtime is a failure row; other agents and outcomes are not', async () => {
	notifications.notifyFailedReply({ type: 'submission_settled', instanceId: 'task-1', agentName: 'coder', outcome: 'failed', error: { message: 'Model overloaded' } });
	notifications.notifyFailedReply({ type: 'submission_settled', instanceId: 'task-2', agentName: 'coordinator', outcome: 'failed' });
	notifications.notifyFailedReply({ type: 'submission_settled', instanceId: 'task-2', agentName: 'coder', outcome: 'completed' });
	await settle();
	assert.deepEqual(
		(await notifications.notificationsView()).notifications.map((row) => [row.sessionId, row.kind, row.body]),
		[['task-1', 'failed', 'Failed: Model overloaded']],
	);
});
