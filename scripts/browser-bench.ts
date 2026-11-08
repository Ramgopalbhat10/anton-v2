import { appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type { Page } from 'playwright-core';
import { codeReport, quickjsExecute } from '../src/services/browser-run.ts';
import { addressToUrl, browserFunctions, type BrowserCommand, clipSnapshot } from '../src/services/browser-step.ts';
import { browserPrompt, browserToolDescription } from '../src/services/browser-tool-text.ts';
import { forgetPages, pageForAgent } from '../src/services/page-memory.ts';

/**
 * Runs the browser subagent's tool on public sites with a real model and grades
 * what it answers: for checking a change to the browser tool (its words, its page
 * descriptions, run) against the same tasks before and after it.
 *
 *   OPENROUTER_API_KEY=... npm run browser:bench
 *   npm run browser:bench -- --tasks books,stars --reps 3 --model anthropic/claude-haiku-5.5 --out bench.jsonl
 *
 * The model gets the browser subagent's own instructions and tool description, and each call goes
 * through the same step and run code the agent uses (run in a QuickJS VM, as for the Browser panel),
 * with the page described as the agent sees it: cut, and as what changed on a page seen before.
 * Left out: the decision model (do, trimming a long page to the job, the risky-click check), so the
 * numbers measure the tool alone. It needs Playwright's Chromium (the sandbox image's global Playwright,
 * or set BENCH_CHROMIUM to a Chromium binary) and prints a JSON line per run and a summary at the end.
 */

type Task = { id: string; brief: string; check: (answer: string) => boolean };
type Run = {
	task: string;
	rep: number;
	pass: boolean;
	final: string;
	turns: number;
	calls: number;
	actions: Record<string, number>;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	toolChars: number;
	seconds: number;
	error: string | null;
};

const has =
	(...checks: (RegExp | ((answer: string) => boolean))[]) =>
	(answer: string) =>
		checks.every((check) => (typeof check === 'function' ? check(answer) : check.test(answer)));

/** Reading one page, following links, using site search, forms and sorting, then flows and reads across several pages. */
const TASKS: Task[] = [
	{ id: 'ada', brief: "On English Wikipedia (https://en.wikipedia.org), use the site's search box to find Ada Lovelace, and report her date of birth.", check: has(/10 December 1815|December 10,? 1815|1815-12-10/i) },
	{ id: 'creator', brief: "Open https://en.wikipedia.org/wiki/Python_(programming_language), follow the link to the person who designed the language, and report that person's date of birth.", check: has(/31 January 1956|January 31,? 1956/i) },
	{ id: 'mdn', brief: 'Go to https://developer.mozilla.org, use the site search to find Array.prototype.flat(), and report the default value of its depth parameter.', check: has(/\b1\b/) },
	{ id: 'dynamic', brief: 'At https://the-internet.herokuapp.com/dynamic_loading/2 click Start and report the exact text that appears after loading finishes.', check: has(/Hello World!?/i) },
	{ id: 'books', brief: 'On https://books.toscrape.com open the Travel category. Report how many books it has, and the title and price of the most expensive one.', check: has(/\b11\b/, /Year in Provence/i, /56\.88/) },
	{ id: 'quotes', brief: 'On https://quotes.toscrape.com, open the tag "love", go to the next page of that tag, and report the author of the first quote on that page.', check: has(/C\.\s?S\.\s?Lewis/i) },
	{ id: 'todo', brief: 'At https://todomvc.com/examples/react/dist/ add three todos: "buy milk", "walk dog", "write report". Then mark "walk dog" as completed. Report the exact text of the items-left counter.', check: has(/2 items? left/i) },
	{ id: 'addremove', brief: 'At https://the-internet.herokuapp.com/add_remove_elements/ click Add Element 5 times, then delete 2 of the added elements. Report how many Delete buttons remain on the page.', check: has(/\b3\b|three/i) },
	{ id: 'sharp', brief: 'On https://books.toscrape.com open the Mystery category, find the book "Sharp Objects", open its page, and report its UPC and how many copies are available.', check: has(/e00eb4fd7b871a48/i, /\b20\b/) },
	{ id: 'tables', brief: 'On https://the-internet.herokuapp.com/tables, in Example 2 sort the table by the Due column, and report the last name of the person with the largest amount due.', check: has(/\bDoe\b/) },
	{ id: 'stars', brief: 'On https://books.toscrape.com, look at the first 3 pages of the full catalogue (60 books). How many of those books have a five-star rating?', check: has(/\b14\b/) },
	{ id: 'einstein', brief: 'On https://quotes.toscrape.com, count how many quotes by Albert Einstein appear across all pages of the site (follow Next until there is no next page).', check: has(/\b10\b/) },
	{ id: 'todo5', brief: 'At https://todomvc.com/examples/react/dist/ add five todos: "one", "two", "three", "four", "five". Mark "two" and "four" as completed, then show only the Active todos. Report which todos are listed, in order.', check: has(/one/i, /three/i, /five/i, (answer) => !/\btwo\b|\bfour\b/i.test(answer)) },
	{ id: 'addremove9', brief: 'At https://the-internet.herokuapp.com/add_remove_elements/ click Add Element 9 times, then delete 4 of the added elements. Report how many Delete buttons remain on the page.', check: has(/\b5\b|five/i) },
];

/** Added to each brief, so a run is graded on one line it gives. */
const ANSWER_LINE = ' End your report with one last line: ANSWER: <the answer>, or ANSWER: NOT FOUND if you could not get it.';
const MAX_TURNS = 30;

/** The browser tool's input as the subagent sees it, without in, do and the screenshot options the bench has no use for. */
const TOOL = {
	type: 'function',
	function: {
		name: 'browser',
		description: browserToolDescription(false),
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['open', 'click', 'type', 'select', 'press', 'hover', 'scroll', 'back', 'wait', 'look', 'run'] },
				url: { type: 'string', description: 'For open: a site' },
				target: { type: 'string', description: 'The element to act on: its ref from the page (e12), or a Playwright selector' },
				code: { type: 'string', description: 'For run: the body of an async function given page (Playwright). Return what you need' },
				text: { type: 'string', description: 'For type: what to enter, replacing what is there. For select: the option' },
				submit: { type: 'boolean', description: 'For type: press Enter afterwards' },
				key: { type: 'string', description: 'For press: such as Enter, Escape, Tab or Control+a' },
				amount: { type: 'number', description: 'For scroll: pixels down, negative for up' },
				ms: { type: 'integer', description: 'For wait without a target' },
			},
			required: ['action'],
		},
	},
};

function chromium(): typeof import('playwright-core').chromium {
	if (process.env.BENCH_CHROMIUM) {
		const core = createRequire(import.meta.url)('playwright-core') as typeof import('playwright-core');
		const launch = core.chromium.launch.bind(core.chromium);
		return Object.assign(Object.create(core.chromium), { launch: (options: object = {}) => launch({ ...options, executablePath: process.env.BENCH_CHROMIUM }) });
	}
	const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
	return (createRequire(`${root}/`)('playwright') as typeof import('playwright-core')).chromium;
}

const { browserStep, browserRun } = browserFunctions<Page>();

/** One call of the browser tool, answered as the subagent's tool answers it. */
async function browse(page: Page, key: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const errors: string[] = [];
	const onConsole = (message: import('playwright-core').ConsoleMessage) => void (message.type() === 'error' && errors.push(message.text()));
	page.on('console', onConsole);
	const command = { ...args, ...(typeof args.url === 'string' ? { url: addressToUrl(args.url) } : {}) } as BrowserCommand;
	try {
		if (args.action === 'run') {
			if (typeof args.code !== 'string' || !args.code.trim()) return { problem: 'run needs code: the body of an async function given page.' };
			const state = await browserRun(page, command, undefined, quickjsExecute);
			const { snapshot: _snapshot, view: _view, result, logs, ...ran } = state as typeof state & { view?: unknown };
			return { ...ran, errors: errors.slice(0, 20), ...codeReport(result, logs), note: 'Use look to see the page.' };
		}
		const state = await browserStep(page, command);
		const { view: _view, ...rest } = state as typeof state & { view?: unknown };
		return { ...rest, errors: errors.slice(0, 20), snapshot: pageForAgent(key, state.url, clipSnapshot(state.snapshot ?? ''), args.action === 'look') };
	} catch (error) {
		return { url: page.url(), problem: `The browser failed: ${String((error as Error).message).split('\n')[0]}` };
	} finally {
		page.off('console', onConsole);
	}
}

type Message = { role: string; content: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };
type Reply = { choices: { message: Message }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };

async function chat(model: string, messages: Message[]): Promise<Reply> {
	let last = '';
	for (let attempt = 0; attempt < 4; attempt++) {
		const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model, messages, tools: [TOOL], temperature: 0, max_tokens: 4000, usage: { include: true } }),
		});
		const body = (await response.json().catch(() => null)) as Reply | null;
		if (response.ok && body?.choices?.[0]) return body;
		last = `${response.status} ${JSON.stringify(body)?.slice(0, 300)}`;
		await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
	}
	throw new Error(`The model call failed: ${last}`);
}

async function runTask(model: string, task: Task, rep: number, launch: ReturnType<typeof chromium>): Promise<Run> {
	const browser = await launch.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {});
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const key = `bench:${task.id}:${rep}:${Math.random()}`;
	const messages: Message[] = [
		{ role: 'system', content: browserPrompt(false) },
		{ role: 'user', content: task.brief + ANSWER_LINE },
	];
	const run: Run = { task: task.id, rep, pass: false, final: '', turns: 0, calls: 0, actions: {}, inputTokens: 0, outputTokens: 0, cost: 0, toolChars: 0, seconds: 0, error: null };
	const start = Date.now();
	let answer = '';
	try {
		for (let turn = 0; turn < MAX_TURNS && !answer; turn++) {
			const reply = await chat(model, messages);
			run.turns++;
			run.inputTokens += reply.usage?.prompt_tokens ?? 0;
			run.outputTokens += reply.usage?.completion_tokens ?? 0;
			run.cost += reply.usage?.cost ?? 0;
			const message = reply.choices[0].message;
			messages.push({ role: 'assistant', content: message.content ?? '', ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });
			if (!message.tool_calls?.length) {
				answer = message.content || '(no answer)';
				break;
			}
			for (const call of message.tool_calls) {
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(call.function.arguments || '{}');
				} catch {}
				run.calls++;
				run.actions[String(args.action)] = (run.actions[String(args.action)] ?? 0) + 1;
				const output = JSON.stringify(await browse(page, key, args));
				run.toolChars += output.length;
				messages.push({ role: 'tool', tool_call_id: call.id, content: output });
			}
		}
		if (!answer) run.error = `no answer in ${MAX_TURNS} turns`;
	} catch (error) {
		run.error = String((error as Error).message ?? error).slice(0, 300);
	} finally {
		forgetPages(key);
		await browser.close().catch(() => {});
	}
	run.seconds = (Date.now() - start) / 1000;
	run.final = (/ANSWER:(.*)$/is.exec(answer)?.[1] ?? '').trim();
	run.pass = !!run.final && !/NOT FOUND/i.test(run.final) && task.check(run.final);
	return run;
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2 : 0;
};
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

export function summary(runs: Run[]): string {
	const passed = runs.filter((run) => run.pass).length;
	const cost = runs.reduce((sum, run) => sum + run.cost, 0);
	const lines = [
		`${passed}/${runs.length} passed; per run: ${mean(runs.map((run) => run.turns)).toFixed(1)} turns, ${mean(runs.map((run) => run.inputTokens)).toFixed(0)} input tokens, ` +
			`${mean(runs.map((run) => run.toolChars)).toFixed(0)} characters of tool answers, median ${median(runs.map((run) => run.seconds)).toFixed(1)} s; $${cost.toFixed(4)} in all`,
	];
	for (const id of [...new Set(runs.map((run) => run.task))]) {
		const of = runs.filter((run) => run.task === id);
		lines.push(
			`  ${id.padEnd(11)} ${of.filter((run) => run.pass).length}/${of.length}  ${median(of.map((run) => run.inputTokens)).toFixed(0).padStart(7)} tokens  ` +
				`${mean(of.map((run) => run.turns)).toFixed(1).padStart(4)} turns  ${median(of.map((run) => run.seconds)).toFixed(1).padStart(5)} s`,
		);
	}
	return lines.join('\n');
}

async function main() {
	const { values } = parseArgs({
		options: {
			tasks: { type: 'string' },
			reps: { type: 'string', default: '1' },
			lanes: { type: 'string', default: '4' },
			model: { type: 'string', default: process.env.BENCH_MODEL ?? 'anthropic/claude-haiku-5.5' },
			out: { type: 'string' },
		},
	});
	if (!process.env.OPENROUTER_API_KEY) throw new Error('Set OPENROUTER_API_KEY: the bench calls the model through OpenRouter.');
	const only = values.tasks?.split(',').map((id) => id.trim());
	const tasks = TASKS.filter((task) => !only || only.includes(task.id));
	if (!tasks.length) throw new Error(`No such task. The tasks are ${TASKS.map((task) => task.id).join(', ')}.`);
	const launch = chromium();
	const jobs = Array.from({ length: Number(values.reps) }, (_, rep) => tasks.map((task) => [task, rep] as const)).flat();
	const runs: Run[] = [];
	let next = 0;
	const lane = async () => {
		while (next < jobs.length) {
			const [task, rep] = jobs[next++];
			const run = await runTask(values.model!, task, rep, launch);
			runs.push(run);
			if (values.out) appendFileSync(values.out, `${JSON.stringify({ model: values.model, ...run })}\n`);
			console.log(JSON.stringify(run));
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Number(values.lanes)) }, lane));
	console.log(`\n${summary(runs)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
