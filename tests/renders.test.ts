import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-renders-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { injectBootstrap, isRenderPath, PAGE_CSP, renderFrame, renderPage, saveRender } = await import('../src/services/renders.ts');
const { outputsView } = await import('../src/services/files.ts');
const { setProviders } = await import('../src/providers/index.ts');
const { diskStore } = await import('../src/providers/disk/store.ts');
const { upsertProject } = await import('../src/db/projects.ts');
const { insertSession } = await import('../src/db/sessions.ts');

setProviders({ sandbox: { name: 'none', find: async () => null } as never, store: diskStore(path.join(dir, 'objects')), git: {} as never, models: { name: 'x', list: async () => [] } });
const project = await upsertProject('acme/demo', 'main');
await insertSession({ id: 'r1', projectId: project.id, title: 'Pages', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });

test('a page is kept in the Library under renders/ and served with its bootstrap first', async () => {
	const page = await saveRender('r1', { title: 'Loan calculator!', html: '<!doctype html><html><head><style>b{color:red}</style></head><body><b>Hi</b></body></html>', height: 5000 });
	assert.match(page.path, /^renders\/loan-calculator-[0-9a-f]{6}\.html$/);
	assert.equal(page.height, 1600);
	assert.ok((await outputsView('r1')).outputs.some((output) => output.path === page.path));
	const html = await renderPage('r1', page.path);
	// The theme and bootstrap come before the page's own styles, so the page's win.
	assert.ok(html.indexOf('id="anton-theme"') < html.indexOf('b{color:red}'));
	assert.match(html, /ui\/notifications\/size-changed/);
	await assert.rejects(saveRender('r1', { title: 'x', html: 'just text' }), /complete HTML document/);
	await assert.rejects(saveRender('r1', { title: 'x', html: `<div>${'x'.repeat(600 * 1024)}</div>` }), /under 512 KB/);
});

test('only pages under renders/ are served, never another output or a path out of it', async () => {
	assert.equal(isRenderPath('renders/chart-ab12cd.html'), true);
	for (const bad of ['report.md', 'renders/../secrets.html', 'renders/a/b.html', 'renders/x.svg', '/renders/x.html']) assert.equal(isRenderPath(bad), false, bad);
	await assert.rejects(renderPage('r1', 'report.md'), /Not a page/);
	assert.throws(() => renderFrame('r1', 'renders/../x.html'), /Not a page/);
});

test('the page has no network, and its frame page lets it go nowhere but this origin', () => {
	assert.match(PAGE_CSP, /^sandbox allow-scripts allow-forms;/);
	assert.match(PAGE_CSP, /default-src 'none'/);
	assert.match(PAGE_CSP, /connect-src 'none'/);
	assert.match(PAGE_CSP, /form-action 'none'/);
	assert.doesNotMatch(PAGE_CSP, /allow-same-origin|allow-popups|allow-top-navigation|https?:/);
	const { html, csp } = renderFrame('r1', 'renders/chart-ab12cd.html');
	assert.match(csp, /frame-src 'self'/);
	const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
	assert.ok(nonce && html.includes(`nonce="${nonce}"`));
	assert.match(html, /<iframe id="page" title="Page" sandbox="allow-scripts allow-forms" src="\/api\/sessions\/r1\/render\?path=renders%2Fchart-ab12cd\.html">/);
});

test('the page and its frame page are dark like the frames that hold them, so neither paints a white canvas', () => {
	assert.match(renderFrame('r1', 'renders/chart-ab12cd.html').html, /<style>:root\{color-scheme:dark\}/);
	assert.match(injectBootstrap('<html><head><style>:root{color-scheme:light}</style></head></html>'), /:root\{color-scheme:dark!important;/);
});

test('a page without a head still gets the bootstrap at its start', () => {
	assert.match(injectBootstrap('<div>x</div>'), /^<head><meta charset="utf-8">.*<\/head><div>x<\/div>$/);
	assert.match(injectBootstrap('<!DOCTYPE html><body>x</body>'), /^<!DOCTYPE html><head>/);
});
