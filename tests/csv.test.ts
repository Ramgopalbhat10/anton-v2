import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv } from '../src/web/lib/csv.ts';

test('CSV cells follow quoting rules, and big files are cut', () => {
	assert.deepEqual(parseCsv('name,note\r\nada,"says ""hi"", twice"\nbob,"two\nlines"\n'), [
		['name', 'note'],
		['ada', 'says "hi", twice'],
		['bob', 'two\nlines'],
	]);
	assert.deepEqual(parseCsv('a\tb\n1\t\n', '\t'), [['a', 'b'], ['1', '']]);
	assert.deepEqual(parseCsv('x\n1\n2\n3', ',', 2), [['x'], ['1']]);
	assert.deepEqual(parseCsv(''), []);
});
