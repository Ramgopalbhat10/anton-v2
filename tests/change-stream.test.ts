import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announce } from '../src/core/changes.ts';
import { type ChangeStream, streamChanges } from '../src/services/change-stream.ts';

/** A page's stream that takes a while to write each change, as one behind a proxy does. */
function slowStream(writeMs: number) {
	const written: { at: number; text: string }[] = [];
	const aborts: (() => void)[] = [];
	const start = Date.now();
	const stream: ChangeStream & { abort(): void } = {
		aborted: false,
		onAbort: (listener) => void aborts.push(listener),
		writeSSE: async ({ data }) => {
			await new Promise((resolve) => setTimeout(resolve, writeMs));
			written.push({ at: Date.now() - start, text: data });
		},
		write: async (text) => void written.push({ at: Date.now() - start, text }),
		abort() {
			(this as { aborted: boolean }).aborted = true;
			for (const listener of aborts) listener();
		},
	};
	return { stream, written };
}

test('a change that lands while another is being written goes out right after it, not at the next heartbeat', async () => {
	const { stream, written } = slowStream(30);
	const done = streamChanges(stream, 5_000);
	announce({ kind: 'now', id: 'a', now: null });
	// The reply settles while the first change is still being written.
	await new Promise((resolve) => setTimeout(resolve, 10));
	announce({ kind: 'task', id: 'a', what: 'state' });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.deepEqual(
		written.map((entry) => JSON.parse(entry.text)),
		[
			{ kind: 'now', id: 'a', now: null },
			{ kind: 'task', id: 'a', what: 'state' },
		],
	);
	assert.ok(written[1].at < 150, `the second went out at ${written[1].at} ms`);
	stream.abort();
	await done;
});

test('a quiet stream gets a comment line, and stops when the page goes', async () => {
	const { stream, written } = slowStream(0);
	const done = streamChanges(stream, 20);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.ok(written.some((entry) => entry.text === ': ping\n\n'));
	stream.abort();
	await done;
	const count = written.length;
	announce({ kind: 'sessions' });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(written.length, count, 'nothing is written once the page has gone');
});
