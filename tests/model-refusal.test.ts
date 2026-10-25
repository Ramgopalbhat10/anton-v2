import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPlanRefusal } from '../src/core/model-refusal.ts';

test('a plan turning its model away reads as a refusal; the work going wrong does not', () => {
	for (const text of ['Cloud Agent is not available for free users', 'You have reached your usage limit for this plan', '401 Unauthorized', 'Quota exceeded', 'Please sign in again']) {
		assert.ok(isPlanRefusal(text), text);
	}
	for (const text of ['The sandbox stopped', 'Tool call failed: ENOENT', 'This operation was aborted']) assert.ok(!isPlanRefusal(text), text);
});
