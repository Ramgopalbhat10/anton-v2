import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-project-changes-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const projects = await import('../src/db/projects.ts');
const { onChange } = await import('../src/core/changes.ts');

/** Pages keep the project list while the event stream is up, so every write to it must say so. */
test('every write to the project list announces it', async () => {
	const kinds: string[] = [];
	const stop = onChange((change) => kinds.push(change.kind));
	const count = () => kinds.filter((kind) => kind === 'projects').length;
	try {
		const project = await projects.upsertProject('acme/app', 'main');
		assert.equal(count(), 1);
		await projects.setProjectMemory(project.id, 'one');
		assert.equal(count(), 2);
		assert.equal(await projects.appendProjectMemory(project.id, 'two', 1_000), true);
		assert.equal(count(), 3);
		assert.equal(await projects.appendProjectMemory(project.id, 'x'.repeat(2_000), 1_000), false);
		assert.equal(count(), 3, 'a note that did not fit changed nothing');
		await projects.setWarmImage(project.id, 'im-1');
		await projects.clearWarmImage(project.id);
		await projects.retireDefaultWarmImages();
		assert.equal(count(), 6);
		await projects.setProjectSettings(project.id, { ...(await projects.getProject(project.id))!, reviewOthers: false });
		assert.equal(count(), 7);
		await projects.deleteProjectRecord(project.id);
		assert.equal(count(), 8);
	} finally {
		stop();
	}
});
