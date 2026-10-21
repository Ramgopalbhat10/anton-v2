import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

/**
 * Draws the app's icons (favicon, home screen, splash, notification badge)
 * from Anton's mark, the faceted bot head in `Logo` (illustrations.tsx).
 * Run after changing the mark: `node scripts/make-icons.ts`. Needs Chromium
 * (`ANTON_CHROMIUM` or Playwright's own).
 */

const OUT = new URL('../src/web/public/icons/', import.meta.url);
const TILE = '#101517';
const VIEW = 'viewBox="3.5 5.7 17 17"';
/** The mark in its cyan facets, or all in `one` colour with the eyes cut out (the badge). */
const mark = (one?: string) => {
	const [top, left, right] = one ? [one, one, one] : ['#9EE1F3', '#3FB6D8', '#17627A'];
	const eyes = '<path d="M7.03 14.28v2.13M9.87 15.92v2.13" stroke="#06181F" stroke-width="1.75" stroke-linecap="round"/>';
	return (
		(one ? '<mask id="m"><rect width="24" height="24" fill="#fff"/><path d="M7.03 14.28v2.13M9.87 15.92v2.13" stroke="#000" stroke-width="1.75" stroke-linecap="round"/></mask><g mask="url(#m)">' : '<g>') +
		`<polygon points="12,6 19.1,10.1 12,14.2 4.9,10.1" fill="${top}"/><polygon points="4.9,10.1 12,14.2 12,22.4 4.9,18.3" fill="${left}"/><polygon points="12,14.2 19.1,10.1 19.1,18.3 12,22.4" fill="${right}"/>` +
		`</g>${one ? '' : eyes}`
	);
};
/** The mark centred at `scale` of a 24-unit square. */
const centred = (scale: number) => `<g transform="translate(12 12) scale(${scale}) translate(-12 -14.2)">${mark()}</g>`;

/** The bare mark, as the sidebar shows it: the favicon, legible on light and dark tabs alike. */
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" ${VIEW}>${mark()}</svg>`;
/** On a dark rounded tile with a hairline edge: the plain app icon. */
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="${TILE}"/><rect x=".25" y=".25" width="23.5" height="23.5" rx="5.25" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width=".5"/>${centred(0.88)}</svg>`;
/** Edge to edge, the mark well inside the middle 80%, for launchers that cut their own shape (maskable) and for iOS, which rounds the corners itself. */
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${TILE}"/>${centred(0.8)}</svg>`;
/** One colour on clear, as Android's status bar draws a notification's badge. */
const badge = `<svg xmlns="http://www.w3.org/2000/svg" ${VIEW}>${mark('#fff')}</svg>`;

const pngs: Array<{ name: string; svg: string; size: number }> = [
	{ name: 'icon-192.png', svg: tile, size: 192 },
	{ name: 'icon-512.png', svg: tile, size: 512 },
	{ name: 'maskable-512.png', svg: fullBleed, size: 512 },
	{ name: 'apple-touch-icon.png', svg: fullBleed, size: 180 },
	{ name: 'badge-96.png', svg: badge, size: 96 },
];

await mkdir(OUT, { recursive: true });
await writeFile(new URL('icon.svg', OUT), `${favicon}\n`);
const browser = await chromium.launch({ executablePath: process.env.ANTON_CHROMIUM || undefined });
try {
	for (const { name, svg, size } of pngs) {
		const page = await browser.newPage({ viewport: { width: size, height: size } });
		await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
		await writeFile(new URL(name, OUT), await page.screenshot({ omitBackground: true }));
		await page.close();
	}
} finally {
	await browser.close();
}
