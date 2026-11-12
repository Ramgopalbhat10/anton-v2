import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHunks, changeLine, PatchError, parsePatch, patchedFiles, planPatch, unwrapPatch } from '../src/core/apply-patch.ts';

const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

/** The patch applied to files kept in memory, as the tool applies it to the sandbox's. */
async function apply(files: Record<string, string>, text: string): Promise<Record<string, string>> {
	const { after } = await planPatch(parsePatch(text), async (path) => {
		if (!(path in files)) throw new Error('missing');
		return files[path];
	});
	const result = { ...files };
	for (const [path, content] of after) {
		if (content === null) delete result[path];
		else result[path] = content;
	}
	return result;
}

test('a patch adds, updates, moves and deletes files, in one call', async () => {
	const files = { 'src/a.ts': 'one\ntwo\nthree\n', 'src/old.ts': 'gone\n', 'src/name.ts': 'export const name = 1;\n' };
	const text = patch(
		'*** Add File: src/new.ts',
		'+first',
		'+second',
		'*** Update File: src/a.ts',
		'@@',
		' one',
		'-two',
		'+TWO',
		' three',
		'*** Update File: src/name.ts',
		'*** Move to: src/renamed.ts',
		'@@',
		'-export const name = 1;',
		'+export const name = 2;',
		'*** Delete File: src/old.ts',
	);
	assert.deepEqual(await apply(files, text), { 'src/a.ts': 'one\nTWO\nthree\n', 'src/new.ts': 'first\nsecond\n', 'src/renamed.ts': 'export const name = 2;\n' });
	assert.deepEqual(parsePatch(text).map(changeLine), ['A src/new.ts', 'M src/a.ts', 'M src/name.ts -> src/renamed.ts', 'D src/old.ts']);
});

test('a move with no hunks renames the file as it is', async () => {
	assert.deepEqual(await apply({ 'a.txt': 'same\n' }, patch('*** Update File: a.txt', '*** Move to: docs/b.txt')), { 'docs/b.txt': 'same\n' });
});

test('several hunks in a file apply in order, each found after the one before', async () => {
	const file = ['function a() {', '\treturn 1;', '}', '', 'function b() {', '\treturn 1;', '}', ''].join('\n');
	const text = patch('*** Update File: f.ts', '@@ function a() {', '-\treturn 1;', '+\treturn 2;', '@@ function b() {', '-\treturn 1;', '+\treturn 3;');
	assert.equal((await apply({ 'f.ts': file }, text))['f.ts'], file.replace('return 1', 'return 2').replace('return 1', 'return 3'));
	// The first hunk starts without an @@ line; the second is found after it, though its lines also fit before.
	const unheaded = patch('*** Update File: f.ts', ' function a() {', '-\treturn 1;', '+\treturn 2;', ' }', '@@', ' function b() {', '-\treturn 1;', '+\treturn 3;');
	assert.equal((await apply({ 'f.ts': file }, unheaded))['f.ts'], file.replace('return 1', 'return 2').replace('return 1', 'return 3'));
});

test('several @@ lines narrow down to one place among repeated code', () => {
	const file = ['class A {', '\trun() {', '\t\tgo();', '\t}', '}', 'class B {', '\trun() {', '\t\tgo();', '\t}', '}', ''].join('\n');
	const hunks = parsePatch(patch('*** Update File: c.ts', '@@ class B {', '@@ \trun() {', '-\t\tgo();', '+\t\tstop();'))[0];
	assert.equal(hunks.kind, 'update');
	if (hunks.kind !== 'update') return;
	assert.deepEqual(hunks.hunks[0].headers, ['class B {', 'run() {']);
	assert.equal(applyHunks('c.ts', file, hunks.hunks), file.replace(/go\(\);(?![\s\S]*go\(\);)/, 'stop();'));
});

test('a hunk anchored to the end of the file changes the last lines, not the first that match', () => {
	const file = 'end\nmiddle\nend\n';
	const [update] = parsePatch(patch('*** Update File: f.txt', '@@', '-end', '+END', '*** End of File'));
	assert.equal(update.kind === 'update' && applyHunks('f.txt', file, update.hunks), 'end\nmiddle\nEND\n');
});

test('added lines alone go after the @@ line, or at the end without one', () => {
	const file = 'class A:\n    pass\n';
	const [under] = parsePatch(patch('*** Update File: a.py', '@@ class A:', '+    x = 1'));
	assert.equal(under.kind === 'update' && applyHunks('a.py', file, under.hunks), 'class A:\n    x = 1\n    pass\n');
	const [appended] = parsePatch(patch('*** Update File: a.py', '@@', '+print(1)'));
	assert.equal(appended.kind === 'update' && applyHunks('a.py', file, appended.hunks), 'class A:\n    pass\nprint(1)\n');
});

test('lines are found ignoring trailing, then leading and trailing space, then typographic punctuation', () => {
	const update = (old: string, made: string) => {
		const [file] = parsePatch(patch('*** Update File: f', '@@', `-${old}`, `+${made}`));
		return file.kind === 'update' ? file.hunks : [];
	};
	assert.equal(applyHunks('f', 'let a = 1;   \n', update('let a = 1;', 'let a = 2;')), 'let a = 2;\n');
	assert.equal(applyHunks('f', '    let a = 1;\n', update('let a = 1;', '    let a = 2;')), '    let a = 2;\n');
	assert.equal(applyHunks('f', 'say(\u201chello\u201d) \u2014 now\u00a0ok\n', update('say("hello") - now ok', 'say("bye")')), 'say("bye")\n');
	assert.equal(applyHunks('f', "it's here\n", update('it\u2019s here', 'it is here')), 'it is here\n');
});

test('a hunk that fits nowhere names the file and the hunk, shows the lines it looked for, and nothing is changed', async () => {
	const files = { 'a.ts': 'one\n', 'b.ts': 'two\n' };
	const text = patch('*** Update File: a.ts', '@@', '-one', '+ONE', '*** Update File: b.ts', '@@', ' context', '-three', '+THREE');
	await assert.rejects(apply(files, text), (error: Error) => {
		assert.ok(error instanceof PatchError);
		assert.match(error.message, /^Hunk 1 of 1 for b\.ts does not fit: these lines are not in the file:\n {2}context\n {2}three$/);
		return true;
	});
	assert.deepEqual(files, { 'a.ts': 'one\n', 'b.ts': 'two\n' });
});

test('a hunk whose lines fit several places fails unless an @@ line says which', () => {
	const file = 'if (x) {\n\treturn;\n}\nif (y) {\n\treturn;\n}\n';
	const [loose] = parsePatch(patch('*** Update File: f.ts', '-\treturn;', '+\treturn 1;'));
	assert.throws(() => loose.kind === 'update' && applyHunks('f.ts', file, loose.hunks), /Hunk 1 of 1 for f\.ts fits 2 places \(lines 2, 5\).*Add an @@ line/s);
	const [narrowed] = parsePatch(patch('*** Update File: f.ts', '@@ if (y) {', '-\treturn;', '+\treturn 1;'));
	assert.equal(narrowed.kind === 'update' && applyHunks('f.ts', file, narrowed.hunks), 'if (x) {\n\treturn;\n}\nif (y) {\n\treturn 1;\n}\n');
});

test('nothing is planned for any file when one file does not fit, nor for a file that is not there', async () => {
	const files = { 'a.ts': 'a\n' };
	await assert.rejects(apply(files, patch('*** Add File: new.ts', '+x', '*** Delete File: gone.ts')), /Cannot delete gone\.ts: there is no such file/);
	await assert.rejects(apply(files, patch('*** Update File: nope.ts', '@@', '-a', '+b')), /Cannot update nope\.ts/);
});

test('CRLF stays CRLF and a file without a final newline keeps none', () => {
	const hunks = (old: string, made: string) => {
		const [file] = parsePatch(patch('*** Update File: f', ' a', `-${old}`, `+${made}`, '+added'));
		return file.kind === 'update' ? file.hunks : [];
	};
	assert.equal(applyHunks('f', 'a\r\nb\r\nc\r\n', hunks('b', 'B')), 'a\r\nB\r\nadded\r\nc\r\n');
	assert.equal(applyHunks('f', 'a\nb', hunks('b', 'B')), 'a\nB\nadded');
	assert.equal(applyHunks('f', 'a\r\nb', hunks('b', 'B')), 'a\r\nB\r\nadded');
});

test('a patch is taken out of the wrappers models put around it, and nothing more is guessed', () => {
	const body = patch('*** Add File: x.txt', '+x');
	const files = (text: string) => parsePatch(text).map(changeLine);
	assert.deepEqual(files(`apply_patch <<'EOF'\n${body}\nEOF\n`), ['A x.txt']);
	assert.deepEqual(files(`apply_patch <<"PATCH"\n${body}\nPATCH`), ['A x.txt']);
	assert.deepEqual(files(`apply_patch\n${body}`), ['A x.txt']);
	assert.deepEqual(files(`\`\`\`diff\n${body}\n\`\`\``), ['A x.txt']);
	assert.deepEqual(files(`<<EOF\n${body}\nEOF`), ['A x.txt']);
	assert.deepEqual(files(`${body}\n\n`), ['A x.txt']);
	assert.deepEqual(unwrapPatch(`\`\`\`\napply_patch <<'EOF'\n${body}\nEOF\n\`\`\``), body.split('\n'));
	assert.throws(() => parsePatch('*** Add File: x.txt\n+x\n*** End Patch'), /must start with "\*\*\* Begin Patch"/);
	assert.throws(() => parsePatch('*** Begin Patch\n*** Add File: x.txt\n+x'), /must end with "\*\*\* End Patch"/);
	assert.throws(() => parsePatch(`cd src && apply_patch <<'EOF'\n${body}\nEOF`), /must start with/);
});

test('a malformed patch says which line is wrong', () => {
	assert.throws(() => parsePatch(patch('*** Change File: a.ts')), /Line 2 of the patch, "\*\*\* Change File: a\.ts", is not a file header/);
	assert.throws(() => parsePatch(patch('*** Update File: a.ts', '@@', ' ok', 'oops')), /Line 5 of the patch in the update of a\.ts, "oops", is not a hunk line/);
	assert.throws(() => parsePatch(patch('*** Update File: a.ts', '@@ only a header')), /has no lines/);
	assert.throws(() => parsePatch(patch('*** Update File: a.ts', ' context only')), /changes nothing/);
	assert.throws(() => parsePatch(patch()), /changes no files/);
});

test('a context line may start with @@ or ***, and blank lines between files are skipped', async () => {
	const files = { 'notes.md': '@@ not a header\n*** not a file\nold\n' };
	const text = patch('*** Update File: notes.md', ' @@ not a header', ' *** not a file', '-old', '+new', '', '*** Add File: b.txt', '+b', '');
	assert.deepEqual(await apply(files, text), { 'notes.md': '@@ not a header\n*** not a file\nnew\n', 'b.txt': 'b\n' });
});

test('a blank context line the file lacks at the end of a hunk is let go, as Codex does', () => {
	const [file] = parsePatch(patch('*** Update File: f', '@@', ' a', '-b', '+B', ''));
	assert.equal(file.kind === 'update' && applyHunks('f', 'a\nb', file.hunks), 'a\nB');
});

test('a patch that changes a file twice sees its first change the second time', async () => {
	const text = patch('*** Update File: f', '@@', '-a', '+b', '*** Update File: f', '@@', '-b', '+c');
	assert.deepEqual(await apply({ f: 'a\n' }, text), { f: 'c\n' });
});

test('the thread reads the files a patch names, with the lines it adds and removes', () => {
	const text = patch('*** Add File: n.ts', '+1', '+2', '*** Update File: a.ts', '*** Move to: b.ts', '@@', ' x', '-y', '+z', '+w', '*** Delete File: d.ts');
	assert.deepEqual(patchedFiles(text), [
		{ path: 'n.ts', change: 'add', added: 2, removed: 0 },
		{ path: 'a.ts', change: 'move', to: 'b.ts', added: 2, removed: 1 },
		{ path: 'd.ts', change: 'delete', added: 0, removed: 0 },
	]);
	assert.deepEqual(patchedFiles('not a patch'), []);
});
