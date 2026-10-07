import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { GitHost, ModelCatalog, ObjectStore, SandboxProvider } from '../src/core/ports.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-project-files-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const objects = new Map<string, Uint8Array>();
const calls: Array<[string, string]> = [];
const refs: Array<[string, string]> = [];
const { setProviders } = await import('../src/providers/index.ts');
setProviders({
	git: {
		resolveRef: async (repo: string, ref: string) => {
			refs.push([repo, ref]);
			return ref === 'main' ? 'aaa' : 'bbb';
		},
		tree: async (repo: string, sha: string) => {
			calls.push([repo, sha]);
			return repo === 'acme/other' ? ['other.ts'] : sha === 'aaa' ? ['README.md', 'src/app.ts'] : ['feature.ts'];
		},
	} as unknown as GitHost,
	store: {
		get: async (key: string) => objects.get(key) ?? null,
		put: async (key: string, value: string) => {
			objects.set(key, new TextEncoder().encode(value));
		},
	} as unknown as ObjectStore,
	sandbox: new Proxy({} as SandboxProvider, {
		get() {
			throw new Error('Browsing project files must never access the sandbox');
		},
	}),
	models: {} as ModelCatalog,
});
const { upsertProject } = await import('../src/db/projects.ts');
const { listSessionRecords } = await import('../src/db/sessions.ts');
const { projectFiles } = await import('../src/services/files.ts');

test('project file suggestions follow branch refs, reuse commit trees, and never create a task or sandbox', async () => {
	const project = await upsertProject('acme/demo', 'main');
	assert.deepEqual(await projectFiles(project.id), ['README.md', 'src/app.ts']);
	assert.deepEqual(await projectFiles(project.id, 'feature/ui'), ['feature.ts']);
	assert.deepEqual(await projectFiles(project.id, 'main'), ['README.md', 'src/app.ts']);
	assert.deepEqual(refs, [
		['acme/demo', 'main'],
		['acme/demo', 'feature/ui'],
		['acme/demo', 'main'],
	]);
	assert.deepEqual(calls, [
		['acme/demo', 'aaa'],
		['acme/demo', 'bbb'],
	]);
	const other = await upsertProject('acme/other', 'main');
	assert.deepEqual(await projectFiles(other.id), ['other.ts']);
	assert.deepEqual(await listSessionRecords(), []);
	await assert.rejects(projectFiles('missing'), /Project not found/);
});
