import assert from 'node:assert/strict';
import { test } from 'node:test';

const { inlineAssets, resolveAsset } = await import('../src/services/page-assets.ts');

const files = (entries: Record<string, string>) => async (path: string) => (path in entries ? new TextEncoder().encode(entries[path]) : null);

test('a reference names a file in the Library beside the page, never the web or outside it', () => {
	assert.equal(resolveAsset('site/index.html', 'app.js'), 'site/app.js');
	assert.equal(resolveAsset('site/index.html', './css/a.css?v=2#x'), 'site/css/a.css');
	assert.equal(resolveAsset('site/css/a.css', '../img/b%20c.png'), 'site/img/b c.png');
	// A built app names its files from the site's root, which is the page's folder.
	assert.equal(resolveAsset('dist/index.html', '/assets/index-abc.js'), 'dist/assets/index-abc.js');
	assert.equal(resolveAsset('dist/assets/a.css', '/assets/font.woff2', 'dist/index.html'), 'dist/assets/font.woff2');
	for (const ref of ['https://x.com/a.js', '//cdn.com/a.js', 'data:image/png;base64,AA', '#top', '', 'mailto:a@b.c']) assert.equal(resolveAsset('site/index.html', ref), null, ref);
	assert.equal(resolveAsset('index.html', '../secrets.txt'), null);
});

test('scripts keep their place, order and type; anything missing is left as it was', async () => {
	const html = await inlineAssets(
		'<script type="module" src="main.js"></script><script src=a.js async></script><script src="gone.js"></script><script>inline()</script>',
		'app/index.html',
		files({ 'app/main.js': 'const s = "</script>"; // <!-- x', 'app/a.js': 'a()' }),
	);
	assert.equal(html, '<script type="module">const s = "<\\/script>"; // <\\!-- x</script><script>a()</script><script src="gone.js"></script><script>inline()</script>');
});

test('stylesheets keep their media, and their fonts and images come with them', async () => {
	const html = await inlineAssets(
		`<link rel="stylesheet" media="print" href="css/p.css"><link rel="icon" href="fav.svg"><link rel="preconnect" href="https://fonts.gstatic.com"><style>.a{background:url('bg.webp')}</style>`,
		'index.html',
		files({ 'css/p.css': '@font-face{src:url(../f.woff2)}', 'f.woff2': 'F', 'fav.svg': '<svg/>', 'bg.webp': 'W' }),
	);
	assert.match(html, /^<style media="print">@font-face\{src:url\("data:font\/woff2;base64,Rg=="\)\}<\/style>/);
	assert.match(html, /<link rel="icon" href="data:image\/svg\+xml;base64,/);
	assert.match(html, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com">/);
	assert.match(html, /\.a\{background:url\("data:image\/webp;base64,Vw=="\)\}/);
});

test('a page takes in only so much of its folder', async () => {
	const big = 'x'.repeat(4 * 1024 * 1024);
	const html = await inlineAssets('<script src="big.js"></script><script src="small.js"></script>', 'index.html', files({ 'big.js': big, 'small.js': 'ok()' }));
	assert.equal(html, '<script src="big.js"></script><script>ok()</script>');
});
