import { config } from '../config.ts';
import { writeMachineFile } from '../core/machine-fs.ts';
import type { Machine } from '../core/ports.ts';
import { quote, run } from '../core/shell.ts';

/**
 * Runs inside the machine: opens the page in headless Chromium, saves a
 * PNG, and prints what the page said about itself.
 */
const SCRIPT = `
const { chromium } = require('playwright');
const { url, out, width, height, fullPage } = JSON.parse(process.argv[2]);
(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width, height } });
	const errors = [];
	page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
	page.on('pageerror', (error) => errors.push(String(error)));
	let status = null;
	try {
		status = (await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }))?.status() ?? null;
	} catch (error) {
		errors.push('Navigation: ' + error.message);
	}
	await page.screenshot({ path: out, fullPage });
	console.log(JSON.stringify({ title: await page.title(), status, errors: errors.slice(0, 20) }));
	await browser.close();
})().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
`;

/** Installs the browser on first use; sandbox images built since the browser was added already have it. */
const ENSURE_BROWSER = `
command -v node >/dev/null || { echo "The screenshot tool needs Node.js in the sandbox." >&2; exit 3; }
export NODE_PATH="$(npm root -g)"
node -e "require('fs').accessSync(require('playwright').chromium.executablePath())" >/dev/null 2>&1 && exit 0
npm install -g --no-audit --no-fund ${config.browserPackage} >/dev/null
if [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null; then playwright install --with-deps chromium; else playwright install chromium; fi
`;

export type ScreenshotInput = { url: string; name?: string; fullPage?: boolean; width?: number; height?: number };
export type Screenshot = { path: string; title: string; status: number | null; errors: string[] };

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Screenshots a page from inside the machine into its outputs, so it shows in the Library. */
export async function takeScreenshot(machine: Machine, input: ScreenshotInput): Promise<Screenshot> {
	await run(machine, ENSURE_BROWSER, { timeoutMs: 10 * 60_000 });
	const file = `screenshots/${slug(input.name ?? '') || `shot-${Date.now()}`}.png`;
	const out = `${machine.root}/outputs/${file}`;
	const script = `/tmp/anton-screenshot.cjs`;
	await writeMachineFile(machine, script, new TextEncoder().encode(SCRIPT));
	const args = JSON.stringify({ url: input.url, out, width: input.width ?? 1280, height: input.height ?? 800, fullPage: input.fullPage ?? false });
	const stdout = await run(machine, `mkdir -p ${quote(`${machine.root}/outputs/screenshots`)} && NODE_PATH="$(npm root -g)" node ${script} ${quote(args)}`, {
		timeoutMs: 90_000,
	});
	const report = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Omit<Screenshot, 'path'>;
	return { path: `../outputs/${file}`, ...report };
}
