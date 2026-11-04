import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-saved-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { saveOutput, savedOutputs, readOutput } = await import('../src/services/checkpoints.ts');
const { MAX_UPLOAD_BYTES, outputsView, readOutputFile, removeOutput, uploadOutput } = await import('../src/services/files.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');

setProviders({ sandbox: { name: 'none', find: async () => null } as never, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] } });
const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 'ro', projectId: project.id, title: 'Read-only', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });

test('a task without a sandbox keeps outputs saved straight to storage, listed in its Library and readable', async () => {
	const png = new Uint8Array([137, 80, 78, 71]);
	// Saved at once, as parallel steps would: neither entry is lost.
	await Promise.all([saveOutput('ro', 'screenshots/home-1.png', png, 'image/png'), saveOutput('ro', 'screenshots/blog-2.png', png, 'image/png')]);
	assert.deepEqual((await savedOutputs('ro')).map((output) => output.path).sort(), ['screenshots/blog-2.png', 'screenshots/home-1.png']);
	const view = await outputsView('ro');
	assert.equal(view.source, 'base');
	assert.deepEqual(view.outputs.map((output) => [output.path, output.size]).sort(), [['screenshots/blog-2.png', 4], ['screenshots/home-1.png', 4]]);
	assert.deepEqual(await readOutputFile('ro', 'screenshots/home-1.png'), png);
	// Saving the same path again replaces it.
	await saveOutput('ro', 'screenshots/home-1.png', new Uint8Array([1, 2]));
	assert.equal((await savedOutputs('ro')).length, 2);
	assert.deepEqual(await readOutput('ro', 'screenshots/home-1.png'), new Uint8Array([1, 2]));
});

test('a file you add goes under uploads with a safe name, and a deleted one leaves the Library', async () => {
	const path = await uploadOutput('ro', '../../notes?.txt', new TextEncoder().encode('hello'), 'text/plain');
	assert.equal(path, 'uploads/notes_.txt');
	assert.ok((await outputsView('ro')).outputs.some((output) => output.path === path));
	await assert.rejects(uploadOutput('ro', 'big.bin', new Uint8Array(MAX_UPLOAD_BYTES + 1)), /20 MB/);

	await removeOutput('ro', path);
	assert.equal(await readOutputFile('ro', path), null);
	assert.ok(!(await outputsView('ro')).outputs.some((output) => output.path === path));
	await assert.rejects(removeOutput('ro', '../escape'));
});

test('a deleted file is listed as deleted, so replies can say so, until the agent saves it again', async () => {
	await saveOutput('ro', 'renders/chart-1.html', new TextEncoder().encode('<p>hi</p>'), 'text/html');
	assert.deepEqual((await outputsView('ro')).deleted.filter((path) => path.startsWith('renders/')), []);
	await removeOutput('ro', 'renders/chart-1.html');
	const view = await outputsView('ro');
	assert.ok(!view.outputs.some((output) => output.path === 'renders/chart-1.html'));
	assert.ok(view.deleted.includes('renders/chart-1.html'));
	// Drawn again under the same path, it is back and no longer deleted.
	await saveOutput('ro', 'renders/chart-1.html', new TextEncoder().encode('<p>again</p>'), 'text/html');
	assert.ok(!(await outputsView('ro')).deleted.includes('renders/chart-1.html'));
});

test('files you add on the Artifacts page are listed there, from no task, and read and deleted like any Library file', async () => {
	const { ADDED_FILES, addFile } = await import('../src/services/added-files.ts');
	const { listArtifacts } = await import('../src/services/artifacts.ts');
	const skill = new TextEncoder().encode('---\nname: broker\n---\n# Broker\n');
	assert.equal(await addFile('SKILL.md', skill, 'text/markdown'), 'SKILL.md');
	assert.equal(await addFile('SKILL.md', skill, 'text/markdown'), 'SKILL-2.md', 'a name already taken gets a number');
	const listed = (await listArtifacts()).filter((artifact) => artifact.added);
	assert.deepEqual(listed.map((artifact) => [artifact.sessionId, artifact.path, artifact.task.title]).sort(), [
		[ADDED_FILES, 'SKILL-2.md', 'Added by you'],
		[ADDED_FILES, 'SKILL.md', 'Added by you'],
	]);
	assert.deepEqual(await readOutputFile(ADDED_FILES, 'SKILL.md'), skill);
	await removeOutput(ADDED_FILES, 'SKILL-2.md');
	assert.deepEqual((await listArtifacts()).filter((artifact) => artifact.added).map((artifact) => artifact.path), ['SKILL.md']);
});

test('a file you added installs as the skill its front matter names, whatever the file is called', async () => {
	const { addFile } = await import('../src/services/added-files.ts');
	const { installAddedSkill, installPlugin, pluginsView } = await import('../src/services/plugins.ts');
	const first = new TextEncoder().encode('---\nname: indstocks\ndescription: Read an INDstocks account.\n---\n# INDstocks\nUse http_request.\n');
	const path = await addFile('IndMoney-API.md', first, 'text/markdown');
	const plugin = await installAddedSkill(path);
	assert.deepEqual([plugin.name, plugin.source, plugin.skills.map((skill) => [skill.name, skill.description, skill.instructions])], [
		'indstocks',
		{ repo: 'added-files', path: 'IndMoney-API.md', ref: null },
		[['indstocks', 'Read an INDstocks account.', '# INDstocks\nUse http_request.']],
	]);
	// Two files can share a name: each installs as its own skill.
	const other = await addFile('IndMoney-API.md', new TextEncoder().encode('---\nname: indstocks-intraday\ndescription: Day trade.\n---\nRules.\n'), 'text/markdown');
	assert.equal(other, 'IndMoney-API-2.md');
	await installAddedSkill(other);
	assert.deepEqual((await pluginsView()).map((item) => item.name).sort(), ['indstocks', 'indstocks-intraday']);
	// Installing it again, from the Skills page too, updates it in place.
	const again = await installPlugin({ plugin: plugin.id });
	assert.equal(again.id, plugin.id);
	assert.equal((await pluginsView()).length, 2);
	// A file with no front matter is not a skill.
	const plain = await addFile('notes.md', new TextEncoder().encode('# Just notes\n'), 'text/markdown');
	await assert.rejects(installAddedSkill(plain), /no name: line in its front matter/);
	await assert.rejects(installAddedSkill('missing.md'), /not among the files you added/);
});

test('a skill folder added as a zip installs with its scripts beside its SKILL.md', async () => {
	const { zipSync } = await import('fflate');
	const { addFile } = await import('../src/services/added-files.ts');
	const { installAddedSkill } = await import('../src/services/plugins.ts');
	const enc = (value: string) => new TextEncoder().encode(value);
	const zip = zipSync({
		'day-trading/SKILL.md': enc('---\nname: day-trading\ndescription: Trade within the day on paper.\n---\nRun `scripts/kit.py levels`.\n'),
		'day-trading/scripts/kit.py': enc('print("levels")\n'),
		'day-trading/universe.json': enc('{"ITC":"NSE_1660"}'),
		'__MACOSX/day-trading/._SKILL.md': enc('junk'),
	});
	const path = await addFile('day-trading.zip', zip, 'application/zip');
	const plugin = await installAddedSkill(path);
	assert.equal(plugin.name, 'day-trading');
	assert.deepEqual(plugin.skills[0].instructions, 'Run `scripts/kit.py levels`.');
	assert.deepEqual(Object.keys(plugin.skills[0].files).sort(), ['scripts/kit.py', 'universe.json']);
	assert.deepEqual(plugin.skills[0].files['scripts/kit.py'], { text: 'print("levels")\n' });
	// Settings › Skills shows it as installed: its SKILL.md and scripts, read back without the zip.
	const { previewPlugin, pluginFile } = await import('../src/services/plugins.ts');
	const preview = await previewPlugin({ plugin: plugin.id });
	assert.equal(preview.added, 'day-trading.zip');
	assert.deepEqual(preview.files, ['SKILL.md', 'scripts/kit.py', 'universe.json']);
	assert.equal(preview.readme, 'SKILL.md');
	const dec = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);
	assert.equal(dec(await pluginFile(preview.source.repo, preview.sha, 'scripts/kit.py')), 'print("levels")\n');
	assert.match(dec(await pluginFile(preview.source.repo, preview.sha, 'SKILL.md')) ?? '', /^---\nname: day-trading\ndescription: "Trade within the day on paper\."\n---\n\nRun `scripts\/kit\.py levels`\./);
	assert.equal(await pluginFile(preview.source.repo, preview.sha, 'missing.txt'), null);
	const empty = await addFile('notes.zip', zipSync({ 'notes.txt': enc('hi') }), 'application/zip');
	await assert.rejects(installAddedSkill(empty), /has no SKILL\.md/);
	const broken = await addFile('broken.zip', enc('not a zip'), 'application/zip');
	await assert.rejects(installAddedSkill(broken), /could not be opened as a zip/);
});
