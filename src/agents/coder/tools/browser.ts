import { defineSubagent, defineTool, useSubagent, useTool } from '@flue/runtime';
import * as v from 'valibot';
import type { BrowserInput, BrowserState } from '../../../services/browser/browser.ts';
import { decide, hasDecisionModel, newTally, type Tally, yesOf } from '../../../services/models/decisions.ts';
import { autopilot, IRREVERSIBLE, MAX_ACTIONS, mayBeIrreversible, outcomeNote } from '../../../services/browser/browser-autopilot.ts';
import { codeReport, RUN_MS } from '../../../services/browser/browser-run.ts';
import { browserPrompt, browserToolDescription } from '../../../services/browser/browser-tool-text.ts';
import { machineFor } from '../../../services/sandbox/workspace.ts';
import { browseOnComputer } from '../../../services/browser/computer.ts';
import { agentBrowse, askTheUser, dropAgentDriver } from '../../../services/browser/live-browser.ts';
import { STEP_MS, StepGivenUp, withinDeadline } from '../../../services/browser/step-deadline.ts';
import { needsTheUser, trimToJob } from '../../../services/browser/page-judge.ts';
import { currentBrief, noteStep, type StepDetail } from '../../../services/tasks/subagent-runs.ts';
import { isLocalAddress, isRawFile } from '../../../services/browser/browser-step.ts';
import { pageForAgent } from '../../../services/browser/page-memory.ts';
import { withSettingsModel } from '../subagents.ts';

const BROWSER_ACTIONS = ['open', 'click', 'type', 'select', 'press', 'hover', 'scroll', 'back', 'wait', 'look', 'run'] as const;
const AUTOPILOT_ACTIONS = [...BROWSER_ACTIONS, 'do'] as const;

export type BrowserPlace = 'panel' | 'sandbox';

const PLACES: Record<BrowserPlace, string> = {
	panel: "the user's Browser panel, a real browser they watch and can take over (to sign in, say), for any site on the web",
	sandbox: "a browser inside the sandbox, which the user can watch and take over in the Computer panel; the only one that reaches the app's dev server on localhost",
};

const lastPlace = new Map<string, BrowserPlace>();

function browserTool(id: string, places: BrowserPlace[]) {
	const autopiloted = hasDecisionModel();
	return defineTool({
		name: 'browser',
		description:
			`${browserToolDescription(autopiloted)} ` +
			places.map((place, index) => `"in": "${place}" is ${PLACES[place]}${index === 0 ? ' (the default)' : ''}.`).join(' '),
		input: v.object({
			action: v.picklist((autopiloted ? AUTOPILOT_ACTIONS : BROWSER_ACTIONS) as typeof AUTOPILOT_ACTIONS),
			in: v.optional(v.pipe(v.picklist(places), v.description('Which browser; steps after an open stay in the browser it used'))),
			url: v.optional(v.pipe(v.string(), v.description('For open: a site, or the dev server in the sandbox such as http://localhost:3000. For do: a page to open first'))),
			target: v.optional(v.pipe(v.string(), v.description('The element to act on: its ref from the page (e12), or a Playwright selector'))),
			code: v.optional(v.pipe(v.string(), v.description('For run: the body of an async function given page (Playwright). Return what you need'))),
			text: v.optional(v.pipe(v.string(), v.description('For type: what to enter, replacing what is there. For select: the option'))),
			submit: v.optional(v.pipe(v.boolean(), v.description('For type: press Enter afterwards'))),
			key: v.optional(v.pipe(v.string(), v.description('For press: such as Enter, Escape, Tab or Control+a'))),
			amount: v.optional(v.pipe(v.number(), v.description('For scroll: pixels down, negative for up'))),
			ms: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(15_000), v.description('For wait without a target'))),
			goal: v.optional(v.pipe(v.string(), v.description('For do: one outcome the page should reach, specific enough to check'))),
			values: v.optional(v.pipe(v.record(v.string(), v.string()), v.description('For do: text to type, by what it is, such as {"email": "ada@example.com"}'))),
			maxActions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_ACTIONS), v.description('For do: the most actions to take (default 8)'))),
			confirm: v.optional(
				v.pipe(v.string(), v.description('The name of an element you confirm clicking (in a step, do or run) although it may buy, send, post or delete something. Only when your brief explicitly asks for exactly that')),
			),
			screenshot: v.optional(v.pipe(v.string(), v.description('Save a screenshot after the step, under this short name'))),
			fullPage: v.optional(v.boolean()),
			width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(320), v.maxValue(2560))),
			height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(320), v.maxValue(2560))),
		}),
		async run({ data, toolCallId, signal }) {
			const { in: chosen, goal, values, maxActions, confirm, ...rest } = data;
			const full = rest.action === 'look';
			const opens = rest.action === 'open' || (rest.action === 'do' && Boolean(rest.url));
			const local = opens && isLocalAddress(rest.url);
			const place: BrowserPlace = chosen ?? (local && places.includes('sandbox') ? 'sandbox' : opens ? places[0] : (lastPlace.get(id) ?? places[0]));
			if (place === 'panel' && local) {
				return { output: { problem: `The Browser panel cannot reach the sandbox's ${rest.url}. ${places.includes('sandbox') ? 'Use "in": "sandbox" for it.' : 'The sandbox is not running; ask the coding agent to start it and run the dev server.'}` } };
			}
			if (opens && isRawFile(rest.url)) {
				return { output: { problem: `Not opened: ${rest.url} is a plain file with nothing to act on. Read it with web_fetch, or report back that it should be read that way.` } };
			}
			lastPlace.set(id, place);
			// A connection that hung is let go, so the next step connects again.
			const go = async (command: BrowserInput): Promise<BrowserState> => {
				let givenUp = false;
				const controller = new AbortController();
				const stepSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
				try {
					const work = place === 'sandbox' ? browseOnComputer(id, () => machineFor(id), command, () => givenUp || stepSignal.aborted, undefined, stepSignal) : agentBrowse(id, command);
					// The shared screen remains locked until the actual work ends, even if the reply gives up waiting.
					return await withinDeadline(work, command.action === 'run' ? RUN_MS : STEP_MS, signal, () => { givenUp = true; controller.abort(); if (place === 'panel') dropAgentDriver(id); });
				} catch (error) {
					if (!(error instanceof StepGivenUp)) throw error;
					const problem = error.reason === 'stopped' ? error.message : `${error.message} The page may be slow or very large: try a narrower step, or report back, since a page only to be read is quicker with web_fetch.`;
					return { url: command.url ?? '', title: '', status: null, problem, errors: [], screenshot: null, snapshot: '' };
				}
			};
			let state: BrowserState;
			let report: Record<string, unknown> = {};
			let driven: StepDetail | null = null;
			const tally = newTally();
			if (rest.action === 'do') {
				if (!goal?.trim()) return { output: { problem: 'do needs a goal: the outcome the page should reach.' } };
				let openingNotice: string | undefined;
				let opened: BrowserState | undefined;
				if (rest.url) {
					opened = await go({ action: 'open', url: rest.url });
					if (opened.problem) return { output: { ...forAgent(opened), snapshot: pageForAgent(`${id}:${place}`, opened.url, opened.snapshot) } };
					openingNotice = opened.notice;
				}
				const result = await autopilot(
					id,
					go,
					{ goal, values, confirm, maxActions },
					{ signal, start: opened, onAction: (actions, decisions, cost) => void noteStep(id, toolCallId, { outcome: null, actions, decisions, cost }) },
				);
				driven = { outcome: result.outcome, actions: result.actions, decisions: result.decisions, cost: result.cost };
				state = result.state;
				if (openingNotice) state = { ...state, notice: [openingNotice, state.notice].filter(Boolean).join(' ') };
				report = {
					outcome: result.outcome,
					note: outcomeNote(result),
					actions: result.actions.map((action) => `${action.what}${action.p === null ? '' : ` (${action.p.toFixed(2)})`}`),
				};
			} else if (rest.action === 'run') {
				if (!rest.code?.trim()) return { output: { problem: 'run needs code: the body of an async function given page.' } };
				const brief = await currentBrief(id, 'browser');
				const ask = async (name: string): Promise<boolean> => {
					if (confirm?.trim() && name.toLowerCase().includes(confirm.trim().toLowerCase())) return true;
					return !(await mayNotUndo(id, name, brief, tally));
				};
				state = await go({ action: 'run', code: rest.code, ask, screenshot: rest.screenshot, fullPage: rest.fullPage, width: rest.width, height: rest.height });
				report = codeReport(state.result, state.logs);
			} else {
				const step = rest as BrowserInput;
				const pressing = step.action === 'click' || (step.action === 'press' && (step.key ?? 'Enter') === 'Enter');
				if (pressing && step.target && !confirm && mayBeIrreversible(step.target) && (await mayNotUndo(id, step.target, await currentBrief(id, 'browser'), tally))) {
					await noteJudgements(id, toolCallId, null, tally);
					return {
						output: {
							problem: `Not clicked: ${step.target} may buy, send, post or delete something. Only if your brief explicitly asks for exactly this, repeat the step with confirm set to its name; otherwise stop and report.`,
						},
					};
				}
				state = await go(step);
			}
			if (place === 'panel' && (await needsTheUser(id, state.url, state.title, state.snapshot, tally))) {
				askTheUser(id, 'Sign in or pass the check here, then ask the agent to carry on.', state.url);
				state = { ...state, problem: 'This page needs the user to sign in or pass a human check. Stop and report that they can do it in the Browser panel; do not try to get past it.' };
			}
			if (rest.action === 'run') {
				await noteJudgements(id, toolCallId, null, tally);
				const { snapshot: _page, result: _result, logs: _logs, ...ran } = forAgent(state);
				return { output: { ...ran, ...report, note: 'Use look to see the page.' } };
			}
			const seen = pageForAgent(`${id}:${place}`, state.url, state.snapshot, full);
			const snapshot = seen === state.snapshot && !full ? await trimToJob(id, goal ?? (await currentBrief(id, 'browser')), state.url, seen, tally) : seen;
			await noteJudgements(id, toolCallId, driven, tally);
			return { output: { ...report, ...forAgent(state), snapshot } };
		},
	});
}

/** Where the page is scrolled to is only for telling whether a step did anything. */
function forAgent({ view: _view, ...state }: BrowserState): Omit<BrowserState, 'view'> {
	return state;
}

export async function mayNotUndo(id: string, target: string, brief: string | null, tally: Tally): Promise<boolean> {
	const answers = await decide(id, { element: target, ...(brief ? { job: brief.slice(0, 2000) } : {}) }, { risky: { type: 'yes-no', instructions: IRREVERSIBLE } }, tally);
	const risky = yesOf(answers?.risky);
	if (risky !== null) tally.actions.push({ what: risky >= 0.5 ? `Held back ${target}: it may not be undone` : `Judged ${target} safe to click`, p: risky >= 0.5 ? risky : 1 - risky });
	return (risky ?? 0) >= 0.5;
}

async function noteJudgements(id: string, toolCallId: string, driven: StepDetail | null, tally: Tally): Promise<void> {
	if (!driven && !tally.decisions) return;
	await noteStep(id, toolCallId, {
		outcome: driven?.outcome ?? null,
		actions: [...(driven?.actions ?? []), ...tally.actions],
		decisions: (driven?.decisions ?? 0) + tally.decisions,
		cost: (driven?.cost ?? 0) + tally.cost,
	});
}

function Browser() {
	return browserPrompt(hasDecisionModel());
}

export function useBrowserSubagent(id: string, places: BrowserPlace[]) {
	const subagent = defineSubagent({
		name: 'browser',
		description:
			'Does a job on web pages in a real browser and reports back: click through flows, fill forms, pages that show their content only after scripts run or a click, and checking a web app. ' +
				'Not for reading: web_fetch reads a page in a second or two, and the repository tools read code. ' +
			`It works in ${places.map((place) => PLACES[place]).join(', or in ')}. Give it a complete brief: the URL, what to do, and what to report.`,
		agent: () => {
			useTool(browserTool(id, places));
			return Browser();
		},
	});
	useSubagent(withSettingsModel(id, subagent, 'browser'));
}
