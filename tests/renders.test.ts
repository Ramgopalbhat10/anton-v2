import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-renders-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { injectBootstrap, isRenderPath, PAGE_CSP, pageFrame, pageState, pageTitle, renderFrame, renderPage, savePageState, saveRender } = await import('../src/services/renders.ts');
const { listArtifacts } = await import('../src/services/artifacts.ts');
const { removeOutput, uploadOutput } = await import('../src/services/files.ts');
const { saveOutput } = await import('../src/services/checkpoints.ts');
const { onChange } = await import('../src/core/changes.ts');
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

test('any HTML file in the Library is served as a page, never another output or a path out of it', async () => {
	for (const good of ['renders/chart-ab12cd.html', 'report.html', 'site/index.htm']) assert.equal(isRenderPath(good), true, good);
	for (const bad of ['report.md', 'renders/../secrets.html', 'renders/x.svg', '/renders/x.html', 'a//b.html', './x.html']) assert.equal(isRenderPath(bad), false, bad);
	await assert.rejects(renderPage('r1', 'report.md'), /Not a page/);
	assert.throws(() => renderFrame('r1', 'renders/../x.html'), /Not a page/);
});

test('a page without a kept title is named for its file', () => {
	assert.equal(pageTitle('renders/loan-calculator-a1b2c3.html'), 'Loan calculator');
	assert.equal(pageTitle('reports/q3_summary.html'), 'Q3 summary');
});

test('every copy of a page shares its state: saved, announced to the others, and served with the page', async () => {
	const page = await saveRender('r1', { title: 'Habit tracker', html: '<html><body><div id="app"></div></body></html>' });
	assert.deepEqual(await pageState('r1', page.path), { state: null, fields: {}, storage: {}, version: 0 });
	const heard: unknown[] = [];
	const stop = onChange((change) => heard.push(change));
	const first = await savePageState('r1', page.path, { state: { done: ['read'] }, from: 'tab-a' });
	const second = await savePageState('r1', page.path, { fields: { '#name': 'Ada', '#late': true }, from: 'tab-b' });
	const third = await savePageState('r1', page.path, { storage: { meals: '[{"kcal":420}]' }, from: 'tab-a' });
	stop();
	assert.deepEqual([first.version, second.version, third.version], [1, 2, 3]);
	assert.deepEqual(heard, [
		{ kind: 'page', id: 'r1', path: page.path, version: 1, from: 'tab-a' },
		{ kind: 'page', id: 'r1', path: page.path, version: 2, from: 'tab-b' },
		{ kind: 'page', id: 'r1', path: page.path, version: 3, from: 'tab-a' },
	]);
	// The page's own value, its fields and its localStorage are kept apart, so saving one keeps the others.
	assert.deepEqual(await pageState('r1', page.path), { state: { done: ['read'] }, fields: { '#name': 'Ada', '#late': true }, storage: { meals: '[{"kcal":420}]' }, version: 3 });
	const html = await renderPage('r1', page.path);
	assert.match(html, /window\.__antonPage=\{"state":\{"done":\["read"\]\},"fields":\{"#name":"Ada","#late":true\},"storage":\{"meals":"\[\{\\"kcal\\":420\}\]"\},"version":3\}/);
	// The new tab is named for the page.
	assert.match((await pageFrame('r1', page.path)).html, /<title>Habit tracker<\/title>/);
});

test("a page's state can't end its script, grow without bound, or hold anything but field values", async () => {
	const page = await saveRender('r1', { title: 'Notes', html: '<html><body><p>x</p></body></html>' });
	await savePageState('r1', page.path, { state: { note: '</script><script>alert(1)</script>' } });
	assert.doesNotMatch(await renderPage('r1', page.path), /<\/script><script>alert/);
	await assert.rejects(savePageState('r1', page.path, { state: 'x'.repeat(300 * 1024) }), /256 KB/);
	await assert.rejects(savePageState('r1', page.path, { fields: { a: { nested: 1 } } }), /string or a checked state/);
	await assert.rejects(savePageState('r1', page.path, { storage: { a: 1 } }), /stored value is a string/);
	await assert.rejects(savePageState('r1', 'notes.md', { state: 1 }), /Not a page/);
	await assert.rejects(savePageState('nope', page.path, { state: 1 }), /Session not found/);
});

test('the Artifacts page lists what the agent made in every task, with pages by their titles, and not your uploads', async () => {
	await insertSession({ id: 'r2', projectId: project.id, title: 'Reports', model: 'x', reasoning: null, branch: 'main', baseBranch: 'main', baseSha: 'abc', planMode: false });
	const page = await saveRender('r2', { title: 'Revenue explorer', html: '<html><body><svg></svg></body></html>' });
	await saveOutput('r2', 'reports/summary.md', new TextEncoder().encode('# Hi'));
	await uploadOutput('r2', 'mine.csv', new TextEncoder().encode('a,b'));
	const listed = (await listArtifacts()).filter((artifact) => artifact.sessionId === 'r2');
	assert.deepEqual(listed.map((artifact) => [artifact.path, artifact.title, artifact.task.title]).sort(), [
		[page.path, 'Revenue explorer', 'Reports'],
		['reports/summary.md', 'summary.md', 'Reports'],
	]);
	// Kept until the Library changes, then read again.
	await removeOutput('r2', 'reports/summary.md');
	assert.deepEqual((await listArtifacts()).filter((artifact) => artifact.sessionId === 'r2').map((artifact) => artifact.path), [page.path]);
});

test('a page in a folder of its own files is served with them in it: its stylesheet, script and images', async () => {
	await saveOutput('r1', 'nourish/index.html', new TextEncoder().encode('<!doctype html><html><head><link rel="stylesheet" href="styles.css"><script src="https://cdn.example.com/x.js"></script></head><body><img src="./img/logo.png"><script src="app.js" defer></script></body></html>'));
	await saveOutput('r1', 'nourish/styles.css', new TextEncoder().encode('body{background:url(img/logo.png)}'));
	await saveOutput('r1', 'nourish/app.js', new TextEncoder().encode('localStorage.setItem("x","1");'));
	await saveOutput('r1', 'nourish/img/logo.png', new Uint8Array([137, 80, 78, 71]));
	const html = await renderPage('r1', 'nourish/index.html');
	assert.match(html, /<style>body\{background:url\("data:image\/png;base64,iVBORw=="\)\}<\/style>/);
	assert.match(html, /<script>localStorage\.setItem\("x","1"\);<\/script>/);
	assert.match(html, /<img src="data:image\/png;base64,iVBORw==">/);
	// The web stays out: the page has no network.
	assert.match(html, /<script src="https:\/\/cdn\.example\.com\/x\.js"><\/script>/);
	// The page gets a localStorage of its own, since a sandboxed page has none.
	assert.match(html, /install\("localStorage"/);
});

test('the page has no network, and its frame page lets it go nowhere but this origin', () => {
	assert.match(PAGE_CSP, /^sandbox allow-scripts allow-forms;/);
	assert.match(PAGE_CSP, /default-src 'none'/);
	assert.match(PAGE_CSP, /connect-src 'none'/);
	assert.match(PAGE_CSP, /form-action 'none'/);
	assert.doesNotMatch(PAGE_CSP, /allow-same-origin|allow-popups|allow-top-navigation|https?:/);
	const { html, csp } = renderFrame('r1', 'renders/chart-ab12cd.html');
	assert.match(csp, /frame-src 'self'/);
	// The frame page, Anton's own, reaches only this origin, for the page's state.
	assert.match(csp, /connect-src 'self'/);
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
