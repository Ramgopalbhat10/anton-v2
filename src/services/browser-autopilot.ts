import type { Answer, Question } from '../core/ports.ts';
import type { BrowserInput, BrowserState } from './browser.ts';
import { choiceOf, consult, yesOf } from './decisions.ts';

/*
 * Browsing on autopilot: the agent names an outcome ("open the closed pull
 * requests", "fill the form with these values") and the decision model
 * drives the page to it, a step at a time. Each round is one call that reads
 * the page and answers typed questions: is the goal reached, is it out of
 * reach, which kind of action comes next, which element to click, and which
 * field each given value goes in. Code acts on the answers through the same
 * browser step the agent uses, so it works in the Browser panel and in the
 * sandbox alike. A round costs a fraction of a cent and a few hundred
 * milliseconds, where a model step costs cents and seconds.
 *
 * The decision model only ever picks from what is on the page and from the
 * values the agent gave it; nothing it says becomes a selector or text. Before
 * a click that could buy, send, post or delete something, a second question
 * asks whether it would, and if so the round stops: only the agent, on its
 * brief's say-so, confirms such a click by name.
 */

export type AutopilotInput = {
	goal: string;
	/** Text the agent wants typed, by what it is ("email": "ada@example.com"); the model picks the field for each. */
	values?: Record<string, string>;
	/** The name of an element the agent confirms clicking although it may buy, send, post or delete something. */
	confirm?: string;
	maxActions?: number;
};

export type AutopilotOutcome = 'done' | 'stuck' | 'unsure' | 'needs_confirmation' | 'max_actions' | 'stopped';

/** One thing the autopilot did, and how sure the decision model was of it. */
export type AutopilotAction = { what: string; p: number | null; failed?: boolean };

export type AutopilotResult = {
	outcome: AutopilotOutcome;
	actions: AutopilotAction[];
	/** For needs_confirmation, the element it stopped before; for unsure, the choices it weighed. */
	about: string | null;
	decisions: number;
	cost: number;
	state: BrowserState;
};

/** An element on the page the autopilot can use, with the selector the browser step takes. */
export type Candidate = { role: string; name: string; label: string; selector: string; kind: 'click' | 'field' };

const CLICKABLE = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'option', 'treeitem']);
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** Choices offered in one round: a page with more than this is cut, which the agent can still do by hand. */
const MAX_CLICKS = 120;
const MAX_FIELDS = 40;
/** The page as the decision model reads it each round. */
const PAGE_CHARS = 12_000;
const DEFAULT_ACTIONS = 8;
export const MAX_ACTIONS = 15;

/** A round ends the run as done or out of reach when the model is at least this sure. */
const SURE = 0.8;
/** Below this, the model's choice of action or element is too unsure to act on. */
const UNSURE = 0.5;
/** A value goes in a field only when the model is at least this sure it belongs there. */
const FILL = 0.6;
/** A click judged at least this likely to buy, send, post or delete stops for confirmation. */
const RISKY = 0.5;

/** Words on a link that make it worth asking about before clicking; any other kind of control is always asked about. */
const RISKY_WORDS =
	/\b(buy|pay|purchase|order|checkout|check out|place|submit|send|post|publish|delete|remove|destroy|confirm|subscribe|unsubscribe|book|reserve|transfer|donate|sign up|register|create|save|apply|accept|tweet|reply|comment|invite|share|cancel|archive|merge|deploy|approve|install|withdraw|deposit|logout|log out|sign out)\b/i;

/** Whether a click on this, named by its label or selector, could be one to confirm first. */
export const mayBeIrreversible = (text: string) => RISKY_WORDS.test(text);

/** One line of the accessibility tree: `- role "name" [state]: value`, maybe quoted whole as YAML does for some names. */
const LINE = /^\s*- '?([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)'?(?::\s*(.*))?$/;

/** The controls in a page's accessibility tree, in page order, each with a selector that finds exactly it. */
export function candidatesOf(snapshot: string): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Map<string, number>();
	for (const line of snapshot.split('\n')) {
		const match = LINE.exec(line);
		if (!match) continue;
		const [, role, quoted, states = '', rest = ''] = match;
		const kind = FIELDS.has(role) ? 'field' : CLICKABLE.has(role) ? 'click' : null;
		// Every control of a role counts toward an unnamed one's position, as `role=x` matches them all.
		const roleCount = seen.get(role) ?? 0;
		seen.set(role, roleCount + 1);
		if (!kind) continue;
		const name = (quoted ?? '').replace(/\\(.)/g, '$1');
		const key = `${role}\n${name}`;
		const nth = name ? (seen.get(key) ?? 0) : roleCount;
		if (name) seen.set(key, nth + 1);
		const selector = name ? `role=${role}[name=${JSON.stringify(name)} s] >> nth=${nth}` : `role=${role} >> nth=${nth}`;
		const value = rest.trim().replace(/^"(.*)"$/, '$1');
		const shown = `${role}${name ? ` "${name.length > 80 ? `${name.slice(0, 80)}…` : name}"` : ''}${states.trim() ? ` ${states.trim()}` : ''}`;
		const label = kind === 'field' ? `${shown}${value ? ` holding "${value.slice(0, 60)}"` : ' (empty)'}` : shown;
		out.push({ role, name, label, selector, kind });
	}
	return out;
}

const pct = (p: number | null) => (p === null ? '' : ` (${p.toFixed(2)})`);

/**
 * Drives the page toward `goal` through `step`, one decision-model round per
 * action, and says how it ended. Stops when the goal is reached or out of
 * reach, when the model is unsure, before a click to confirm, or after
 * `maxActions`. `onAction` hears each action as it is taken.
 */
export async function autopilot(
	id: string,
	step: (command: BrowserInput) => Promise<BrowserState>,
	input: AutopilotInput,
	options: { signal?: AbortSignal; onAction?: (actions: AutopilotAction[], decisions: number, cost: number) => void } = {},
): Promise<AutopilotResult> {
	const values = Object.entries(input.values ?? {}).filter(([, value]) => typeof value === 'string');
	const typed = new Set<string>();
	const actions: AutopilotAction[] = [];
	const limit = Math.min(MAX_ACTIONS, Math.max(1, input.maxActions ?? DEFAULT_ACTIONS));
	let decisions = 0;
	let cost = 0;
	let unchanged = 0;
	let state = await step({ action: 'look' });

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

	/** Acts, then waits for the page to show it: some sites change the page without loading a new one. */
	const act = async (command: BrowserInput): Promise<boolean> => {
		const before = state.snapshot;
		state = await step(command);
		for (let wait = 0; wait < 2 && !state.problem && state.snapshot === before && command.action !== 'type' && command.action !== 'select'; wait++) {
			state = await step({ action: 'wait', ms: 700 });
		}
		return state.snapshot !== before;
	};

	for (let round = 0; ; round++) {
		if (options.signal?.aborted) return end('stopped');
		if (actions.length >= limit) return end('max_actions');
		const candidates = candidatesOf(state.snapshot);
		const clicks = candidates.filter((candidate) => candidate.kind === 'click').slice(0, MAX_CLICKS);
		const fields = candidates.filter((candidate) => candidate.kind === 'field').slice(0, MAX_FIELDS);
		const left = values.filter(([name]) => !typed.has(name));
		const kinds: Record<string, string> = {
			...(clicks.length ? { click: 'Click a link, button, tab or option' } : {}),
			...(fields.length && left.length ? { type: 'Type the given values into their fields' } : {}),
			scroll: 'Scroll down to find something not on the page yet',
			...(actions.length ? { back: 'Go back to the previous page' } : {}),
		};
		const questions: Record<string, Question> = {
			done: { type: 'yes-no', instructions: 'Is the goal already reached? Say yes only if this page itself shows it (its address, title or content prove it), not because a link toward it is on the page.' },
			stuck: { type: 'yes-no', instructions: 'Is the goal out of reach from this page: it needs signing in, the control it needs is missing, or the page shows an error?' },
			action: { type: 'choice', instructions: 'Which kind of action should come next toward the goal?', options: kinds },
		};
		if (clicks.length) questions.click = { type: 'choice', instructions: 'If clicking, which element moves toward the goal?', options: Object.fromEntries(clicks.map((candidate, index) => [`e${index}`, candidate.label])) };
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
				// A select is chosen from; any other field is typed into.
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
		if (kind.choice === 'click') {
			const pick = choiceOf(answers.click);
			const element = pick ? clicks[Number(pick.choice.slice(1))] : undefined;
			if (!pick || !element || pick.p < UNSURE) return end('unsure', weighed(answers.click, Object.fromEntries(clicks.map((candidate, index) => [`e${index}`, candidate.label]))));
			const confirmed = Boolean(input.confirm?.trim()) && element.label.toLowerCase().includes(input.confirm!.trim().toLowerCase());
			if (!confirmed && (element.role !== 'link' || mayBeIrreversible(element.label))) {
				const risky = await ask(
					{ goal: input.goal.slice(0, 2000), url: state.url, title: state.title, element: element.label, page: state.snapshot.slice(0, PAGE_CHARS / 2) },
					{ risky: { type: 'yes-no', instructions: IRREVERSIBLE } },
				);
				if ((yesOf(risky.risky) ?? 1) >= RISKY) return end('needs_confirmation', element.label);
			}
			const changed = await act({ action: 'click', target: element.selector });
			const failed = Boolean(state.problem);
			did({ what: `${failed ? 'Could not click' : 'Clicked'} ${element.label}${failed ? `: ${state.problem}` : changed ? '' : ' (the page did not change)'}`, p: pick.p, failed });
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

/** The question asked before a click that could matter. */
export const IRREVERSIBLE = 'Would clicking this element buy or pay for something, send or post a message, publish, delete, or otherwise make a change that cannot be undone?';

/** The top choices a model weighed, for an agent taking over from an unsure round. */
function weighed(answer: Answer | undefined, labels: Record<string, string>): string | null {
	if (!answer || !('probabilities' in answer)) return null;
	const top = Object.entries(answer.probabilities)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([key, p]) => `${labels[key] ?? key}${pct(p)}`);
	return `it weighed: ${top.join('; ')}`;
}

/** What the agent should make of how a run ended. */
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
