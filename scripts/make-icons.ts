import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

/**
 * Draws the app's icons (favicon, home screen, splash, notification badge)
 * from Anton's mark, `icons/anton-mark.png`: the glass sandbox cube with the
 * agent's prompt glowing inside, rendered in 3D at 512px on a clear ground.
 * `Logo` (illustrations.tsx) shows the same file. Run after replacing it:
 * `node scripts/make-icons.ts`. Needs Chromium (`ANTON_CHROMIUM` or Playwright's own).
 */

const OUT = new URL('../src/web/public/icons/', import.meta.url);
const mark = `data:image/png;base64,${(await readFile(new URL('anton-mark.png', OUT))).toString('base64')}`;
const GROUND = 'radial-gradient(circle at 50% 38%, #18262e, #0c0e10 72%)';

/** The mark at `scale` of the square, on `ground` (clear when none), clipped to `radius` (a fraction of the side). */
const page = (scale: number, ground = 'transparent', radius = 0, filter = '') => `
	<html><body style="margin:0;background:transparent">
		<div style="width:100vw;height:100vh;display:grid;place-items:center;background:${ground};border-radius:${radius * 100}vw;overflow:hidden;box-shadow:${radius ? 'inset 0 0 0 0.4vw rgba(255,255,255,.08)' : 'none'}">
			<img src="${mark}" style="width:${scale * 100}vw;height:${scale * 100}vw;filter:${filter || 'none'}">
		</div>
	</body></html>`;

const pngs: Array<{ name: string; html: string; size: number }> = [
	// The bare mark, as the sidebar shows it, legible on light and dark tabs alike.
	{ name: 'favicon-64.png', html: page(1), size: 64 },
	// What `Logo` loads: sharp up to about 40px on a 3x screen, a fraction of the source's weight.
	{ name: 'anton-mark-128.png', html: page(1), size: 128 },
	// On a dark rounded tile: the plain app icon.
	{ name: 'icon-192.png', html: page(0.74, GROUND, 0.23), size: 192 },
	{ name: 'icon-512.png', html: page(0.74, GROUND, 0.23), size: 512 },
	// Edge to edge, the mark well inside the middle 80%, for launchers that cut their own shape (maskable) and for iOS, which rounds the corners itself.
	{ name: 'maskable-512.png', html: page(0.6, GROUND), size: 512 },
	{ name: 'apple-touch-icon.png', html: page(0.66, GROUND), size: 180 },
	// One colour on clear, as Android's status bar draws a notification's badge.
	{ name: 'badge-96.png', html: page(0.92, 'transparent', 0, 'brightness(0) invert(1)'), size: 96 },
];

await mkdir(OUT, { recursive: true });
await rm(new URL('icon.svg', OUT), { force: true });
const browser = await chromium.launch({ executablePath: process.env.ANTON_CHROMIUM || undefined });
try {
	for (const { name, html, size } of pngs) {
		const tab = await browser.newPage({ viewport: { width: size, height: size } });
		await tab.setContent(html);
		await tab.waitForLoadState('load');
		await writeFile(new URL(name, OUT), await tab.screenshot({ omitBackground: true }));
		await tab.close();
	}
} finally {
	await browser.close();
}
