import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePatch } from '../src/web/lib/diff.ts';

const patch = `diff --git a/src/retry.ts b/src/retry.ts
index 1111111..2222222 100644
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -18,3 +18,3 @@ export function upload() {
   let attempt = 0;
-  while (true) {
+  while (attempt < MAX_ATTEMPTS) {
     try {
diff --git a/docs/queue.md b/docs/queue.md
new file mode 100644
--- /dev/null
+++ b/docs/queue.md
@@ -0,0 +1,2 @@
+# Queue
+Retries are capped.
`;

test('parsePatch splits files with stats, status and line numbers', () => {
	const [retry, docs] = parsePatch(patch);
	assert.equal(retry.path, 'src/retry.ts');
	assert.equal(retry.status, 'M');
	assert.deepEqual([retry.added, retry.removed], [1, 1]);
	assert.deepEqual(retry.lines[0], { kind: 'hunk', text: '-18,3 +18,3' });
	assert.deepEqual(retry.lines[2], { kind: 'remove', number: 19, text: '  while (true) {' });
	assert.deepEqual(retry.lines[3], { kind: 'add', number: 19, text: '  while (attempt < MAX_ATTEMPTS) {' });
	assert.deepEqual(retry.lines[4], { kind: 'context', number: 20, text: '    try {' });
	assert.equal(docs.status, 'A');
	assert.equal(docs.added, 2);
});

test('parsePatch merges repeated paths from concatenated diffs', () => {
	const files = parsePatch(`${patch}\n${patch}`);
	assert.equal(files.length, 2);
	assert.equal(files[0].added, 2);
});
