const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { viewerPdfPath } = require('./artifact-fixture.ts');

async function check() {
	const url = process.argv[2];
	assert(url, 'Pass the running UI fixture URL');
	// Headless shell lacks the native PDF viewer and does not reproduce the width regression.
	const browser = await chromium.launch({ channel: 'chromium', executablePath: process.env.PERF_CHROMIUM, ignoreDefaultArgs: ['--hide-scrollbars'] });
	try {
		const page = await browser.newPage({ viewport: { width: 320, height: 740 }, reducedMotion: 'reduce' });
		await page.goto(new URL('/agents/perf-task?turns=0', url).href);
		await page.waitForFunction(() => Boolean(window.__chat));
		await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
		await page.getByRole('navigation', { name: 'Open a panel' }).getByRole('button', { name: 'Library', exact: true }).click();

		const panel = page.locator('.sg-workspace-body');
		const [folder, name] = viewerPdfPath.split('/');
		await panel.getByText(folder, { exact: true }).click();
		const [pdf] = await Promise.all([
			page.waitForResponse((response) => new URL(response.url()).searchParams.get('path') === viewerPdfPath),
			panel.getByRole('button', { name, exact: true }).click(),
		]);
		assert(pdf.ok() && pdf.headers()['content-type']?.startsWith('application/pdf'), 'The fixture serves the selected PDF');

		const frame = panel.locator(`iframe[title="${viewerPdfPath}"]`);
		await frame.waitFor({ state: 'visible' });
		const { height, left, right, top, bottom } = await frame.evaluate((node) => {
			const rect = node.getBoundingClientRect();
			const well = node.parentElement;
			const panelRect = node.closest('.sg-workspace-body').getBoundingClientRect();
			const padding = getComputedStyle(well.parentElement.parentElement);
			const headerRect = node.previousElementSibling.getBoundingClientRect();
			return {
				height: rect.height,
				left: rect.left - panelRect.left - parseFloat(padding.paddingLeft),
				right: panelRect.right - parseFloat(padding.paddingRight) - rect.right,
				top: rect.top - headerRect.bottom,
				bottom: panelRect.bottom - parseFloat(padding.paddingBottom) - rect.bottom,
			};
		});
		assert(Math.abs(left) <= 1 && Math.abs(right) <= 1, `PDF fits the Library preview width (left gap: ${left}px, right gap: ${right}px)`);
		assert(height > 0 && Math.abs(top) <= 1 && Math.abs(bottom) <= 1, `PDF fills the space below the file header (height: ${height}px, top gap: ${top}px, bottom gap: ${bottom}px)`);
		console.log(`Library PDF layout passed at 320px: no clipping and ${height}px of available height filled.`);
	} finally {
		await browser.close();
	}
}

check().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
