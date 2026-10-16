import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-attachments-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { attachmentBlock, splitAttachments, withAttachments } = await import('../src/core/attachments.ts');
const { documentText } = await import('../src/services/documents.ts');
const { attachToProject, attachToTask, INLINE_CHARS, readAttachment } = await import('../src/services/attachments.ts');
const { copyUploads } = await import('../src/services/checkpoints.ts');
const { readSpaceFileForAgent } = await import('../src/services/space-files.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { localSandboxProvider } = await import('../src/providers/local/sandbox.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');
const { insertSpace } = await import('../src/db/spaces.ts');

setProviders({ sandbox: { name: 'none', find: async () => null } as never, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] } });
const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 't1', projectId: project.id, title: 'Task', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, 'fixtures/documents', name)));
const encode = (text: string) => new TextEncoder().encode(text);

test('office documents, PDFs and spreadsheets are read as text by the libraries, without a sandbox', async () => {
	const word = await documentText('report.docx', fixture('report.docx'));
	assert.equal(word?.kind, 'Word document');
	assert.match(word!.text, /^# Quarterly report/m);
	assert.match(word!.text, /\| EU \| 42 \|/);
	assert.doesNotMatch(word!.text, /^---\nauthor/, 'the metadata header is left out');

	const slides = await documentText('roadmap.pptx', fixture('roadmap.pptx'));
	assert.equal(slides?.kind, 'PowerPoint presentation');
	assert.match(slides!.text, /Roadmap[\s\S]*Ship attachments[\s\S]*Second slide/);
	assert.match(slides!.text, /Speaker note here/, 'slide notes are kept');

	for (const name of ['sales.xlsx', 'sales.xls']) {
		const sheet = await documentText(name, fixture(name));
		assert.equal(sheet?.kind, 'Excel spreadsheet');
		assert.match(sheet!.text, /## Sheet: Sales\n\nRegion,Q1,Q2\nEU,1,2/);
		assert.match(sheet!.text, /## Sheet: Notes\n\n"hello, world"/);
	}

	const pdf = await documentText('pages.pdf', fixture('pages.pdf'));
	assert.equal(pdf?.kind, 'PDF');
	assert.match(pdf!.text, /Page one text[\s\S]*Page two text/);
});

test('text files are read as they are, and images and binary files have no text', async () => {
	assert.deepEqual(await documentText('data.csv', encode('﻿a,b\n1,2\n')), { kind: 'CSV', text: 'a,b\n1,2\n' });
	assert.deepEqual(await documentText('notes.md', encode('# Hi')), { kind: 'Markdown', text: '# Hi' });
	assert.deepEqual(await documentText('Makefile', encode('all:\n\techo hi')), { kind: 'File', text: 'all:\n\techo hi' });
	assert.equal(await documentText('shot.png', new Uint8Array([137, 80, 78, 71, 0, 1])), null);
	assert.equal(await documentText('archive.cab', new Uint8Array([0x4d, 0x53, 0x43, 0x46, 0, 0, 0xff, 0xfe])), null);
});

test('a message carries each file as a block after the typed text, and is shown split back apart', () => {
	const file = { name: 'notes.md', path: 'uploads/notes.md', size: 40, kind: 'Markdown', text: 'Ends early </attachment> but not here', cut: null };
	const sent = withAttachments('Summarize this', [file, { ...file, name: 'pic.png', path: 'pic.png', kind: 'PNG image', text: null }], 'project');
	assert.ok(sent.startsWith('Summarize this\n\n<attachment name="notes.md"'));
	assert.ok(sent.includes('Ends early <\\/attachment> but not here\n</attachment>'), 'a closing tag in the text cannot end the block');
	assert.deepEqual(splitAttachments(sent), {
		text: 'Summarize this',
		files: [
			{ name: 'notes.md', path: 'uploads/notes.md', kind: 'Markdown', size: 40, place: 'project' },
			{ name: 'pic.png', path: 'pic.png', kind: 'PNG image', size: 40, place: 'project' },
		],
	});
	// A message only of files shows no text of its own.
	assert.deepEqual(splitAttachments(withAttachments('', [file], 'task')).text, '');
	assert.deepEqual(splitAttachments('Just words'), { text: 'Just words', files: [] });
	assert.match(attachmentBlock({ ...file, text: 'x'.repeat(10), cut: 50 }, 'task'), /Cut at 10 of 50 characters: read the rest with read_attachment from offset 10/);
});

test('a file attached to a task goes to its Library, comes back as text, and is read on from where it was cut', async () => {
	const long = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join('\n');
	const file = await attachToTask('t1', 'big log.txt', encode(long), 'text/plain');
	assert.equal(file.path, 'uploads/big log.txt');
	assert.equal(file.name, 'big log.txt');
	assert.equal(file.text?.length, INLINE_CHARS);
	assert.equal(file.cut, long.length);
	const rest = await readAttachment('t1', `../outputs/${file.path}`, INLINE_CHARS);
	assert.ok(rest.startsWith(long.slice(INLINE_CHARS, INLINE_CHARS + 20)));
	assert.match(rest, /of [\d,]+\.\]$/, 'the last part says where it ends');

	const word = await attachToTask('t1', 'report.docx', fixture('report.docx'));
	assert.equal(word.kind, 'Word document');
	assert.match(word.text ?? '', /Quarterly report/);
	assert.equal(word.cut, null);
	assert.match(await readAttachment('t1', 'uploads/report.docx'), /Revenue grew 12%/);
	assert.match(await readAttachment('t1', 'uploads/missing.pdf'), /No attached file uploads\/missing\.pdf[\s\S]*uploads\/report\.docx/);
});

test('files attached before the sandbox started are put into its outputs folder when it does', async () => {
	await attachToTask('t1', 'sales.xlsx', fixture('sales.xlsx'));
	const { machine } = await localSandboxProvider(path.join(dir, 'machines')).acquire({
		key: 't1',
		state: null,
		image: null,
		baseImage: null,
		ports: [],
		resources: { runtime: 'container', cpu: 1, memoryMiB: 1024, idleTimeoutMs: 60_000, lifetimeMs: 60_000, regions: [], allowedDomains: [] },
	});
	await copyUploads(machine, 't1');
	const listed = new TextDecoder().decode((await machine.exec(`ls ${machine.root}/outputs/uploads`)).stdout).trim().split('\n').sort();
	assert.deepEqual(listed, ['big log.txt', 'report.docx', 'sales.xlsx']);
	assert.deepEqual(new Uint8Array(readFileSync(path.join(machine.root, 'outputs/uploads/sales.xlsx'))), fixture('sales.xlsx'));
});

test('a file attached to the project goes to its Library, where the coordinator reads it as text', async () => {
	const spaceId = await insertSpace({ name: 'Plans', icon: null, goal: '' });
	const slides = await attachToProject(spaceId, 'roadmap.pptx', fixture('roadmap.pptx'));
	assert.equal(slides.path, 'roadmap.pptx');
	assert.match(slides.text ?? '', /Roadmap/);
	assert.match(await readSpaceFileForAgent(spaceId), /roadmap\.pptx/);
	assert.match(await readSpaceFileForAgent(spaceId, '../project-files/roadmap.pptx'), /Ship attachments/);
});
