import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-activity-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { isWorking, noteSending, onIdle, recordAgentEvent } = await import('../src/services/activity.ts');
const { onChange } = await import('../src/core/changes.ts');

function listen() {
	const changes: unknown[] = [];
	const stop = onChange((change) => changes.push(change));
	return { changes, stop };
}

test('a task counts as working from the moment a message for it arrives, before the runtime picks it up', () => {
	const { changes, stop } = listen();
	noteSending('a');
	assert.equal(isWorking('a'), true);
	assert.deepEqual(changes, [{ kind: 'task', id: 'a', what: 'state' }], 'open pages hear at once');
	recordAgentEvent({ type: 'submission_running', instanceId: 'a', submissionId: 's1' });
	assert.equal(isWorking('a'), true);
	recordAgentEvent({ type: 'submission_settled', instanceId: 'a', submissionId: 's1' });
	assert.equal(isWorking('a'), false, 'the reply finishing ends it');
	stop();
});

test('a message turned away stops the task counting as working', () => {
	const { changes, stop } = listen();
	const turnedAway = noteSending('b');
	turnedAway();
	assert.equal(isWorking('b'), false);
	assert.deepEqual(changes, [
		{ kind: 'task', id: 'b', what: 'state' },
		{ kind: 'task', id: 'b', what: 'state' },
	]);
	stop();
});

test('a message to an agent already working changes nothing, and turning it away keeps the work going', () => {
	recordAgentEvent({ type: 'submission_running', instanceId: 'c', submissionId: 's2' });
	const { changes, stop } = listen();
	const turnedAway = noteSending('c');
	turnedAway();
	assert.equal(isWorking('c'), true);
	assert.deepEqual(changes, []);
	recordAgentEvent({ type: 'submission_settled', instanceId: 'c', submissionId: 's2' });
	assert.equal(isWorking('c'), false);
	stop();
});

test('turning away a message after the runtime picked it up leaves the work going', () => {
	const turnedAway = noteSending('d');
	recordAgentEvent({ type: 'submission_running', instanceId: 'd', submissionId: 's3' });
	turnedAway();
	assert.equal(isWorking('d'), true);
	recordAgentEvent({ type: 'submission_settled', instanceId: 'd', submissionId: 's3' });
	assert.equal(isWorking('d'), false);
});

test("idle listeners hear when a task's last response finishes, not before", () => {
	const idle: string[] = [];
	const stop = onIdle((id) => idle.push(id));
	recordAgentEvent({ type: 'submission_running', instanceId: 'b', submissionId: 's1' });
	recordAgentEvent({ type: 'submission_running', instanceId: 'b', submissionId: 's2' });
	recordAgentEvent({ type: 'submission_settled', instanceId: 'b', submissionId: 's1' });
	assert.deepEqual(idle, [], 'another response is still running');
	recordAgentEvent({ type: 'submission_settled', instanceId: 'b', submissionId: 's2' });
	assert.deepEqual(idle, ['b']);
	stop();
	recordAgentEvent({ type: 'submission_running', instanceId: 'b', submissionId: 's3' });
	recordAgentEvent({ type: 'submission_settled', instanceId: 'b', submissionId: 's3' });
	assert.deepEqual(idle, ['b'], 'a listener that stopped hears nothing more');
});
