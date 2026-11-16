import type { Answer, Question } from '../../core/ports.ts';
import type { BrowserInput, BrowserState } from './browser.ts';
import { RISKY_WORDS } from './browser-step.ts';
import { choiceOf, consult, yesOf } from '../models/decisions.ts';

/*
 * Autopilot: the decision model drives the page toward the agent's goal, one cheap call a round, through the same browser step
 * the agent uses. It only ever picks from what is on the page and the values the agent gave; nothing it says becomes a
 * selector or text. A click that could buy, send, post or delete stops the run unless the agent confirms it by name.
 */

export type AutopilotInput = {
	goal: string;
	/** By what it is ("email": "ada@example.com"); the model picks the field for each. */
	values?: Record<string, string>;
	confirm?: string;
	maxActions?: number;
};

export type AutopilotOutcome = 'done' | 'stuck' | 'unsure' | 'needs_confirmation' | 'max_actions' | 'stopped';

export type AutopilotAction = { what: string; p: number | null; failed?: boolean };

export type AutopilotResult = {
	outcome: AutopilotOutcome;
	actions: AutopilotAction[];
	about: string | null;
	decisions: number;
	cost: number;
	state: BrowserState;
};

export type Candidate = { role: string; name: string; label: string; selector: string; kind: 'click' | 'field' };

const CLICKABLE = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'option', 'treeitem']);
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** A page with more is cut; the agent can still do the rest by hand. */
const MAX_CLICKS = 120;
const MAX_FIELDS = 40;
const PAGE_CHARS = 12_000;
const DEFAULT_ACTIONS = 8;
export const MAX_ACTIONS = 15;
const DONE = 'Is the goal already reached? Say yes only if this page itself shows it (its address, title or content prove it), not because a link toward it is on the page.';

const SURE = 0.8;
const UNSURE = 0.5;
const FILL = 0.6;
const RISKY = 0.5;

/** These only move around a page, so a click on one is asked about only for risky words; any other control always is. */
const NAVIGATES = new Set(['link', 'tab', 'treeitem']);

export const mayBeIrreversible = (text: string) => RISKY_WORDS.test(text);

/** `- role "name" [state]: value`, maybe quoted whole as YAML does for some names. */
const LINE = /^\s*- '?([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)'?(?::\s*(.*))?$/;

const FRAME = /^(\s*)- iframe \[frame=(\d+)\]:$/;

/** One in an iframe's tree has `frame=N >> ` before its selector, counted within its frame. */
export function candidatesOf(snapshot: string): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Map<string, number>();
	let frame: { at: number; prefix: string } | null = null;
	for (const line of snapshot.split('\n')) {
		const entered = FRAME.exec(line);
		if (entered) {
			frame = { at: entered[1].length, prefix: `frame=${entered[2]} >> ` };
			continue;
		}
		if (frame && line.length - line.trimStart().length <= frame.at) frame = null;
		const match = LINE.exec(line);
		if (!match) continue;
		const [, role, quoted, marks = '', rest = ''] = match;
		// A ref from an AI snapshot finds exactly this element, in an iframe too; it is not a state to show.
		const ref = /\[ref=([a-z0-9]+)\]/.exec(marks)?.[1];
		const states = marks.replace(/\s*\[ref=[^\]]*\]/g, '');
		const kind = FIELDS.has(role) ? 'field' : CLICKABLE.has(role) ? 'click' : null;
		const scope = frame?.prefix ?? '';
		// Every control of a role counts toward an unnamed one's position, as `role=x` matches them all.
		const roleCount = seen.get(`${scope}${role}`) ?? 0;
		seen.set(`${scope}${role}`, roleCount + 1);
		if (!kind) continue;
		const name = (quoted ?? '').replace(/\\(.)/g, '$1');
		const key = `${scope}${role}\n${name}`;
		const nth = name ? (seen.get(key) ?? 0) : roleCount;
		if (name) seen.set(key, nth + 1);
		const selector = ref ? `aria-ref=${ref}` : scope + (name ? `role=${role}[name=${JSON.stringify(name)} s] >> nth=${nth}` : `role=${role} >> nth=${nth}`);
		const value = rest.trim().replace(/^"(.*)"$/, '$1');
		const shown = `${role}${name ? ` "${name.length > 80 ? `${name.slice(0, 80)}…` : name}"` : ''}${states.trim() ? ` ${states.trim()}` : ''}${frame ? ' (in an embedded frame)' : ''}`;
		const label = kind === 'field' ? `${shown}${value ? ` holding "${value.slice(0, 60)}"` : ' (empty)'}` : shown;
		out.push({ role, name, label, selector, kind });
	}
	return out;
}

/** By page (address without #) and label, so a repeated click asks nothing; the same label on another page is asked about again. */
const judgedSafe = new Map<string, Set<string>>();
const MAX_SAFE = 500;
const MAX_TASKS = 200;
const safeKey = (url: string, label: string) => `${url.split('#')[0]}\n${label}`;
function remember(safe: Set<string>, key: string) {
	safe.add(key);
	if (safe.size > MAX_SAFE) safe.delete(safe.values().next().value!);
}

const pct = (p: number | null) => (p === null ? '' : ` (${p.toFixed(2)})`);

/** Stops when the goal is reached or out of reach, when the model is unsure, before a click to confirm, or after `maxActions`. */
export async function autopilot(
	id: string,
	step: (command: BrowserInput) => Promise<BrowserState>,
	input: AutopilotInput,
	options: {
		signal?: AbortSignal;
		onAction?: (actions: AutopilotAction[], decisions: number, cost: number) => void;
		start?: BrowserState;
	} = {},
): Promise<AutopilotResult> {
	const values = Object.entries(input.values ?? {}).filter(([, value]) => typeof value === 'string');
	const typed = new Set<string>();
	const actions: AutopilotAction[] = [];
	const limit = Math.min(MAX_ACTIONS, Math.max(1, input.maxActions ?? DEFAULT_ACTIONS));
	let decisions = 0;
	let cost = 0;
	let unchanged = 0;
	let state = options.start && !options.start.problem ? options.start : await step({ action: 'look' });
	const safe = judgedSafe.get(id) ?? new Set<string>();
	// The task browsing now goes last, so the one left longest goes first.
	judgedSafe.delete(id);
	judgedSafe.set(id, safe);
	if (judgedSafe.size > MAX_TASKS) judgedSafe.delete(judgedSafe.keys().next().value!);

	const ask = async (askState: Record<string, unknown>, questions: Record<string, Question>): Promise<Record<string, Answer>> => {
		const decision = await consult(id, askState, questions, options.signal);
		decisions += 1;
		cost += decision.cost;
		return decision.answers;
	};
	const did = (action: AutopilotAction) => {
		actions.push(action);
		options.onAction?.([...actions], decisions, cost);
	};
	const end = (outcome: AutopilotOutcome, about: string | null = null): AutopilotResult => ({ outcome, actions, about, decisions, cost, state });

	/** Some sites change the page without loading a new one; says whether it changed, only scrolled, or neither. */
	const act = async (command: BrowserInput): Promise<'changed' | 'scrolled' | null> => {
		const before = state.snapshot;
		const view = state.view;
		const moved = () => state.snapshot !== before || state.view !== view;
		state = await step(command);
		for (let wait = 0; wait < 2 && !state.problem && !moved() && command.action !== 'type' && command.action !== 'select'; wait++) {
			state = await step({ action: 'wait', ms: 700 });
		}
		return state.snapshot !== before ? 'changed' : moved() ? 'scrolled' : null;
	};

	for (let round = 0; ; round++) {
		if (options.signal?.aborted) return end('stopped');
		// At the limit, one last look says whether the goal was reached, so a short run that did what was asked ends as done.
		if (actions.length >= limit) {
			const last = await ask(
				{ goal: input.goal.slice(0, 2000), url: state.url, title: state.title, actions_taken: actions.map((action) => action.what).join('\n'), page: state.snapshot.slice(0, PAGE_CHARS) },
				{ done: { type: 'yes-no', instructions: DONE } },
			);
			return end((yesOf(last.done) ?? 0) >= SURE ? 'done' : 'max_actions');
		}
		const candidates = candidatesOf(state.snapshot);
		const clicks = candidates.filter((candidate) => candidate.kind === 'click').slice(0, MAX_CLICKS);
		const fields = candidates.filter((candidate) => candidate.kind === 'field').slice(0, MAX_FIELDS);
		const left = values.filter(([name]) => !typed.has(name));
		const kinds: Record<string, string> = {
			...(clicks.length ? { click: 'Click a link, button, tab or option' } : {}),
			...(clicks.length ? { hover: 'Hover over an element to show what it reveals, such as a tooltip, preview or menu' } : {}),
			...(fields.length && left.length ? { type: 'Type the given values into their fields' } : {}),
			scroll: 'Scroll down to find something not on the page yet',
			...(actions.length ? { back: 'Go back to the previous page' } : {}),
		};
		const questions: Record<string, Question> = {
			done: { type: 'yes-no', instructions: DONE },
			stuck: { type: 'yes-no', instructions: 'Is the goal out of reach from this page: it needs signing in, the control it needs is missing, or the page shows an error?' },
			action: { type: 'choice', instructions: 'Which kind of action should come next toward the goal?', options: kinds },
		};
		if (clicks.length) questions.click = { type: 'choice', instructions: 'If clicking or hovering, which element moves toward the goal?', options: Object.fromEntries(clicks.map((candidate, index) => [`e${index}`, candidate.label])) };
		if (fields.length) {
			left.forEach(([name, value], index) => {
				questions[`value${index}`] = {
					type: 'choice',
					instructions: `If typing, which field should hold the value for ${name} ("${value.slice(0, 80)}")? None if no field on this page is for it.`,
					options: { none: 'No field on this page is for it', ...Object.fromEntries(fields.map((candidate, at) => [`f${at}`, candidate.label])) },
				};
			});
		}
		const answers = await ask(
			{
				goal: input.goal.slice(0, 2000),
				url: state.url,
				title: state.title,
				actions_taken: actions.length ? actions.map((action) => action.what).join('\n') : 'none yet',
				page: state.snapshot.slice(0, PAGE_CHARS),
			},
			questions,
		);
		if ((yesOf(answers.done) ?? 0) >= SURE) return end('done');
		if ((yesOf(answers.stuck) ?? 0) >= SURE) return end('stuck');
		const kind = choiceOf(answers.action);
		if (!kind || kind.p < UNSURE) return end('unsure', weighed(answers.action, kinds));

		if (kind.choice === 'type') {
			let filled = 0;
			for (const [index, [name, value]] of left.entries()) {
				const pick = choiceOf(answers[`value${index}`]);
				const field = pick && pick.choice !== 'none' && pick.p >= FILL ? fields[Number(pick.choice.slice(1))] : undefined;
				if (!field) continue;
				if (field.role === 'combobox') await act({ action: 'select', target: field.selector, text: value });
				if (field.role !== 'combobox' || state.problem) await act({ action: 'type', target: field.selector, text: value });
				const failed = Boolean(state.problem);
				if (!failed) typed.add(name);
				did({ what: `${failed ? 'Could not type' : 'Typed'} ${name} into ${field.label.replace(/ (holding .*|\(empty\))$/, '')}${failed ? `: ${state.problem}` : ''}`, p: pick!.p, failed });
				if (!failed) filled += 1;
			}
			if (!filled) return end('unsure', 'none of the values left could be typed into a field it was sure of');
			continue;
		}
		if (kind.choice === 'click' || kind.choice === 'hover') {
			const pick = choiceOf(answers.click);
			const element = pick ? clicks[Number(pick.choice.slice(1))] : undefined;
			if (!pick || !element || pick.p < UNSURE) return end('unsure', weighed(answers.click, Object.fromEntries(clicks.map((candidate, index) => [`e${index}`, candidate.label]))));
			// Hovering changes nothing that cannot be undone, so it needs no check.
			if (kind.choice === 'hover') {
				const changed = await act({ action: 'hover', target: element.selector });
				const failed = Boolean(state.problem);
				did({ what: `${failed ? 'Could not hover over' : 'Hovered over'} ${element.label}${failed ? `: ${state.problem}` : changed ? '' : ' (the page did not change)'}`, p: pick.p, failed });
				unchanged = changed ? 0 : unchanged + 1;
				if (unchanged >= 2) return end('stuck');
				continue;
			}
			const confirmed = Boolean(input.confirm?.trim()) && element.label.toLowerCase().includes(input.confirm!.trim().toLowerCase());
			const asks = (!NAVIGATES.has(element.role) || mayBeIrreversible(element.label)) && !safe.has(safeKey(state.url, element.label));
			if (!confirmed && asks) {
				const risky = await ask(
					{ goal: input.goal.slice(0, 2000), url: state.url, title: state.title, element: element.label, page: state.snapshot.slice(0, PAGE_CHARS / 2) },
					{ risky: { type: 'yes-no', instructions: IRREVERSIBLE } },
				);
				if ((yesOf(risky.risky) ?? 1) >= RISKY) return end('needs_confirmation', element.label);
				remember(safe, safeKey(state.url, element.label));
			}
			const changed = await act({ action: 'click', target: element.selector });
			const failed = Boolean(state.problem);
			const note = failed ? `: ${state.problem}` : changed === 'scrolled' ? ' (the page scrolled)' : changed ? '' : ' (the page did not change)';
			did({ what: `${failed ? 'Could not click' : 'Clicked'} ${element.label}${note}`, p: pick.p, failed });
			unchanged = changed ? 0 : unchanged + 1;
		} else if (kind.choice === 'scroll') {
			const changed = await act({ action: 'scroll', amount: 800 });
			did({ what: changed ? 'Scrolled down' : 'Scrolled down (nothing new)', p: kind.p });
			unchanged = changed ? 0 : unchanged + 1;
		} else {
			await act({ action: 'back' });
			did({ what: 'Went back', p: kind.p });
			unchanged = 0;
		}
		// Two actions in a row that changed nothing: going on would only repeat them.
		if (unchanged >= 2) return end('stuck');
	}
}

export const IRREVERSIBLE = 'Would clicking this element buy or pay for something, send or post a message, publish, delete, or otherwise make a change that cannot be undone?';

function weighed(answer: Answer | undefined, labels: Record<string, string>): string | null {
	if (!answer || !('probabilities' in answer)) return null;
	const top = Object.entries(answer.probabilities)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([key, p]) => `${labels[key] ?? key}${pct(p)}`);
	return `it weighed: ${top.join('; ')}`;
}

export function outcomeNote(result: AutopilotResult): string {
	switch (result.outcome) {
		case 'done':
			return 'The decision model judged the goal reached. Check the page below before you rely on it.';
		case 'stuck':
			return 'The goal looks out of reach from here (or the last actions changed nothing). Read the page below and take single steps, or report what blocks it.';
		case 'unsure':
			return `The decision model was not sure what to do next${result.about ? ` (${result.about})` : ''}. Take the next step yourself with a single action.`;
		case 'needs_confirmation':
			return `Stopped before clicking ${result.about}: it may buy, send, post or delete something. Only if your brief explicitly asks for exactly this, call do again with confirm set to its name; otherwise stop and report.`;
		case 'max_actions':
			return 'Stopped after the most actions one call takes. Read the page below, then call do again or take single steps.';
		case 'stopped':
			return 'Stopped.';
	}
}
