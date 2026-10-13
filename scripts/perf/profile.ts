/**
 * Profiles a task page while its agent streams and three subagents work,
 * with the Files panel open on a large file and the tree expanded.
 *
 *   npx vite build --config scripts/perf/vite.config.ts
 *   node scripts/perf/profile.ts [label] [--panel=Files|Changes|Agents]
 *
 * Reports React commits and component renders (through the DevTools hook),
 * long tasks and their blocking time, dropped frames, input latency while
 * typing in the composer, DOM size, and the JS heap (peak, and after a GC),
 * under 4x CPU throttling (`--rate=1` for none). Writes the numbers to
 * node_modules/.perf-results/<label>-<panel>-x<rate>.json.
 *
 * `--cpu` adds the hottest functions from a CPU profile, `--trace` the time
 * spent in script, style, layout and paint (and saves the Chrome trace), and
 * `--still` turns animations off (reduced motion), to tell their cost apart.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { PHASES, SESSION_ID } from './scenario.ts';

const label = process.argv.find((arg, index) => index > 1 && !arg.startsWith('--')) ?? 'run';
const panel = process.argv.find((arg) => arg.startsWith('--panel='))?.slice(8) ?? 'Files';
const rate = Number(process.argv.find((arg) => arg.startsWith('--rate='))?.slice(7) ?? 4);
const root = new URL('../..', import.meta.url).pathname;
const port = 43150;

const health = `http://127.0.0.1:${port}/api/health`;
// A server left over from another run would serve another build.
if (await fetch(health).then(() => true, () => false)) throw new Error(`Something already serves port ${port}; stop it first.`);
const server = spawn('npx', ['vite', 'preview', '--config', 'scripts/perf/vite.config.ts'], {
	cwd: root,
	stdio: 'ignore',
	detached: true,
	env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
});
// npx starts Vite as a child: stop the whole group, however this run ends.
const stopServer = () => {
	try {
		process.kill(-server.pid!);
	} catch {
		// Already gone.
	}
};
process.on('exit', stopServer);
process.on('SIGTERM', () => process.exit(1));
process.on('SIGINT', () => process.exit(1));
for (let tries = 0; ; tries++) {
	const up = await fetch(health).then((response) => response.ok, () => false);
	if (up) break;
	if (tries > 100) throw new Error('The preview server did not start.');
	await new Promise((resolve) => setTimeout(resolve, 200));
}
const step = (what: string) => console.error(`[perf] ${what}`);

/** Installed before React loads: counts commits and which components rendered in each. */
function instrument() {
	const counts: Record<string, number> = {};
	const state = { commits: 0, renders: 0, counting: false, frames: 0, slowFrames: 0, worstFrame: 0 };
	const COMPONENT = new Set([0, 1, 11, 14, 15]);
	const nameOf = (fiber: any): string => {
		const type = fiber.type;
		if (!type) return 'Anonymous';
		return type.displayName || type.name || type.type?.displayName || type.type?.name || type.render?.displayName || type.render?.name || 'Anonymous';
	};
	const walk = (fiber: any) => {
		while (fiber) {
			const mounted = !fiber.alternate;
			if (COMPONENT.has(fiber.tag) && (mounted || fiber.flags & 1)) {
				state.renders++;
				const name = nameOf(fiber);
				counts[name] = (counts[name] ?? 0) + 1;
			}
			// A subtree React bailed out of keeps its old children: nothing below rendered.
			if (fiber.child && (mounted || fiber.child !== fiber.alternate?.child)) walk(fiber.child);
			fiber = fiber.sibling;
		}
	};
	(window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
		supportsFiber: true,
		renderers: new Map(),
		inject: () => 1,
		checkDCE: () => undefined,
		onScheduleFiberRoot: () => undefined,
		onCommitFiberUnmount: () => undefined,
		onPostCommitFiberRoot: () => undefined,
		onCommitFiberRoot: (_id: number, root: any) => {
			if (!state.counting) return;
			state.commits++;
			walk(root.current.child);
		},
	};
	const longTasks: number[] = [];
	new PerformanceObserver((list) => {
		if (state.counting) for (const entry of list.getEntries()) longTasks.push(entry.duration);
	}).observe({ type: 'longtask', buffered: false });
	const events: number[] = [];
	new PerformanceObserver((list) => {
		if (state.counting) for (const entry of list.getEntries()) events.push(entry.duration);
	}).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
	let last = 0;
	const frame = (at: number) => {
		if (state.counting && last) {
			const gap = at - last;
			state.frames++;
			if (gap > 50) state.slowFrames++;
			state.worstFrame = Math.max(state.worstFrame, gap);
		}
		last = at;
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
	(window as any).__perf = { counts, state, longTasks, events };
}

const browser = await chromium.launch({ executablePath: process.env.PERF_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const cdp = await page.context().newCDPSession(page);
await page.addInitScript(instrument);
// --still: no animations (prefers-reduced-motion), to tell their cost from the rest.
if (process.argv.includes('--still')) await page.emulateMedia({ reducedMotion: 'reduce' });
page.on('pageerror', (error) => console.error('[page]', error.message));
step('opening the task');
await page.goto(`http://127.0.0.1:${port}/agents/${SESSION_ID}`);

// The workspace as the report describes it: a panel open on the task's files.
await page.getByRole('tab', { name: panel, exact: true }).first().click().catch(async () => {
	await page.getByRole('button', { name: 'Add a panel' }).click();
	await page.getByRole('menuitem', { name: new RegExp(panel) }).click();
});
if (panel === 'Files') {
	const tree = page.getByLabel('File tree', { exact: true });
	for (const folder of ['src', 'web', 'components', 'node_modules', '@tanstack']) await tree.getByRole('button', { name: new RegExp(`^${folder.replace('.', '\\.')}( M)?$`) }).first().click();
	await tree.getByRole('button', { name: /^illustrations\.tsx/ }).click();
	await page.waitForTimeout(1500);
}
await page.waitForTimeout(1000);

await page.locator('[role="textbox"][contenteditable]').last().click();
step('running the scenario');
await cdp.send('Performance.enable');
await cdp.send('HeapProfiler.collectGarbage');
const heapOf = async () => (await cdp.send('Performance.getMetrics')).metrics.find((metric) => metric.name === 'JSHeapUsedSize')!.value;
const heapBefore = await heapOf();
await cdp.send('Emulation.setCPUThrottlingRate', { rate });
// --cpu: a sampled CPU profile of the run, summed by function, for finding what the long tasks spend.
const cpu = process.argv.includes('--cpu');
if (cpu) {
	await cdp.send('Profiler.enable');
	await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
	await cdp.send('Profiler.start');
}
// --trace: a Chrome trace of the run, its main-thread work summed by kind (script, style, layout, paint).
const trace = process.argv.includes('--trace');
if (trace) await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
const began = Date.now();
await page.evaluate(() => {
	(window as any).__perf.state.counting = true;
	(window as any).__perfGo();
});

// Type into the composer through the run, as someone adding to the task would. It is focused once, before the
// run, so the keystrokes cost the page what typing costs, not a search of the page for the field each time.
let peak = heapBefore;
const until = Date.now() + PHASES.end + 1500;
while (Date.now() < until) {
	await page.keyboard.press('a');
	peak = Math.max(peak, await heapOf());
	await page.waitForTimeout(400);
}

await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
const perf = await page.evaluate(() => {
	const { counts, state, longTasks, events } = (window as any).__perf;
	state.counting = false;
	return { counts, state, longTasks, events, nodes: document.getElementsByTagName('*').length };
});
// The page answers only once it has worked through the scenario: how long that took, against the scenario's own length.
const wallMs = Date.now() - began;
let work: Array<[string, number]> = [];
if (trace) {
	const raw = (await browser.stopTracing()).toString();
	mkdirSync(`${root}node_modules/.perf-results`, { recursive: true });
	writeFileSync(`${root}node_modules/.perf-results/${label}-${panel}-x${rate}.trace.json`, raw);
	const events = JSON.parse(raw).traceEvents as Array<{ name: string; ph: string; dur?: number; tid: number; pid: number }>;
	const main = events.find((event) => event.name === 'thread_name' && (event as any).args?.name === 'CrRendererMain' && events.some((other) => other.pid === event.pid && other.name === 'UpdateLayoutTree'));
	const sums = new Map<string, number>();
	for (const event of events) {
		if (event.ph !== 'X' || !event.dur || (main && (event.pid !== main.pid || event.tid !== main.tid))) continue;
		if (!['UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'Layerize', 'Commit', 'FunctionCall', 'EvaluateScript', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'HitTest', 'RunMicrotasks', 'ParseHTML', 'GCEvent', 'MinorGC', 'MajorGC', 'RunTask'].includes(event.name)) continue;
		sums.set(event.name, (sums.get(event.name) ?? 0) + event.dur / 1000);
	}
	work = [...sums].sort((a, b) => b[1] - a[1]).map(([name, ms]) => [name, Math.round(ms)]);
}
let hot: Array<[string, number]> = [];
if (cpu) {
	const { profile } = await cdp.send('Profiler.stop');
	const self = new Map<number, number>();
	const deltas = profile.timeDeltas ?? [];
	(profile.samples ?? []).forEach((id, index) => self.set(id, (self.get(id) ?? 0) + (deltas[index] ?? 0)));
	const byName = new Map<string, number>();
	for (const node of profile.nodes) {
		const { functionName, url, lineNumber } = node.callFrame;
		const key = `${functionName || '(anonymous)'} ${url.split('/').pop()}:${lineNumber + 1}`;
		byName.set(key, (byName.get(key) ?? 0) + (self.get(node.id) ?? 0) / 1000);
	}
	hot = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, ms]) => [name, Math.round(ms)]);
}
await cdp.send('HeapProfiler.collectGarbage');
const heapAfter = await heapOf();

const top = Object.entries(perf.counts as Record<string, number>)
	.sort((a, b) => b[1] - a[1])
	.slice(0, 25);
const sorted = [...perf.events].sort((a: number, b: number) => a - b);
const result = {
	label,
	panel,
	cpuSlowdown: rate,
	wallMs,
	commits: perf.state.commits,
	renders: perf.state.renders,
	longTasks: perf.longTasks.length,
	longTaskMs: Math.round(perf.longTasks.reduce((sum: number, value: number) => sum + value, 0)),
	blockingMs: Math.round(perf.longTasks.reduce((sum: number, value: number) => sum + Math.max(0, value - 50), 0)),
	worstTaskMs: Math.round(Math.max(0, ...perf.longTasks)),
	frames: perf.state.frames,
	slowFrames: perf.state.slowFrames,
	worstFrameMs: Math.round(perf.state.worstFrame),
	slowInputs: sorted.length,
	worstInputMs: Math.round(sorted[sorted.length - 1] ?? 0),
	domNodes: perf.nodes,
	heapBeforeMB: +(heapBefore / 2 ** 20).toFixed(1),
	heapPeakMB: +(peak / 2 ** 20).toFixed(1),
	heapAfterGcMB: +(heapAfter / 2 ** 20).toFixed(1),
	top,
	...(cpu ? { hot } : {}),
	...(trace ? { work } : {}),
};
mkdirSync(`${root}node_modules/.perf-results`, { recursive: true });
writeFileSync(`${root}node_modules/.perf-results/${label}-${panel}-x${rate}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, top: top.slice(0, 15) }));
await browser.close();
stopServer();
