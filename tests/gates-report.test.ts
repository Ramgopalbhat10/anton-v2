import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateRows, gatesText } from '../scripts/gates-report.ts';

test('send-backs add up per check in the order the checks run, with how many led to a change', () => {
	const report = gateRows([
		{ sendBacks: [{ gate: 'review', changed: true, worked: true }, { gate: 'completion', changed: false, worked: false }] },
		{ sendBacks: [{ gate: 'review', changed: false, worked: true }] },
		{},
		{ sendBacks: [{ gate: 'todo', changed: false, worked: false }] },
	]);
	assert.equal(report.replies, 4);
	assert.equal(report.sentBack, 3);
	assert.deepEqual(report.rows, [
		{ gate: 'todo', sent: 1, changed: 0, worked: 0 },
		{ gate: 'review', sent: 2, changed: 1, worked: 2 },
		{ gate: 'completion', sent: 1, changed: 0, worked: 0 },
	]);
	const text = gatesText(report);
	assert.match(text, /^4 replies read, 3 sent back at least once\./);
	assert.match(text, /review\s+2\s+1\s+50%\s+2\s+100%/);
	assert.match(text, /all\s+4\s+1\s+25%\s+2\s+50%/);
	assert.equal(gatesText(gateRows([{}, {}])), '2 replies read; no check sent any back.');
});
