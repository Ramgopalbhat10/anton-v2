import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { uniqueUploadNames, uploadName } from '../src/core/upload-name.ts';

test('upload names match Library basename normalization and remain unique after it', () => {
	assert.equal(uploadName('folder\\notes?.pdf'), 'notes_.pdf');
	assert.equal(uploadName(' ../ '), 'file');
	assert.equal(uploadName('..'), 'file');
	assert.equal(uploadName('é.png'), '_.png');
	assert.deepEqual(uniqueUploadNames(['a?.pdf', 'a_.pdf', 'a_.pdf', 'photo.png', 'photo.png', '.env', '.env']), [
		'a_.pdf', 'a_-2.pdf', 'a_-3.pdf', 'photo.png', 'photo-2.png', '.env', '.env-2',
	]);
});
