import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logProblem, logRuntimeEvent, recentProblems } from '../src/services/log.ts';

test('problems are kept newest first, with the runtime warnings and failed replies', () => {
	const quiet = console.warn;
	const quieter = console.error;
	console.warn = () => undefined;
	console.error = () => undefined;
	try {
		logProblem('warn', 'Checkpoint failed', new Error('disk full'), 's1');
		logRuntimeEvent({ type: 'log', level: 'info', message: 'routine' });
		logRuntimeEvent({ type: 'log', level: 'warn', message: '[flue:mcp] server unreachable', instanceId: 's2' });
		logRuntimeEvent({ type: 'submission_settled', outcome: 'completed', instanceId: 's2' });
		logRuntimeEvent({ type: 'submission_settled', outcome: 'failed', instanceId: 's3', error: { message: 'model overloaded' } });
		for (let index = 0; index < 400; index += 1) logProblem('warn', `filler ${index}`);
	} finally {
		console.warn = quiet;
		console.error = quieter;
	}
	const logs = recentProblems();
	assert.equal(logs.length, 300, 'only the newest are kept');
	assert.equal(logs[0].message, 'filler 399');
	const early = [...logs].reverse();
	assert.ok(!early.some((entry) => entry.message === 'routine'));
	logProblem('error', 'An agent reply failed', 'model overloaded', 's3');
	assert.deepEqual(
		{ ...recentProblems()[0], at: '' },
		{ at: '', level: 'error', message: 'An agent reply failed', detail: 'model overloaded', sessionId: 's3' },
	);
});
