import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Answer, DecisionModel, Question } from '../src/core/ports.ts';
import type { BrowserInput, BrowserState } from '../src/services/browser.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-autopilot-'));
process.env.ANTON_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { autopilot, candidatesOf, outcomeNote } = await import('../src/services/browser-autopilot.ts');
const { setProviders } = await import('../src/providers/index.ts');

/** Answers each round from `rule`, with whatever the test wants; records what was asked. */
let rule: (state: Record<string, unknown>, questions: Record<string, Question>) => Record<string, Answer> = () => ({});
let asked: Array<{ state: Record<string, unknown>; questions: Record<string, Question> }> = [];
const decisions: DecisionModel = {
	name: 'openrouter/~typesafe/jev-latest',
	async decide(state, questions) {
		asked.push({ state, questions });
		return { answers: rule(state, questions), inputTokens: 500, cost: 0.0001 };
	},
};
setProviders({ sandbox: {} as never, store: {} as never, git: {} as never, models: { name: 'x', list: async () => [] }, decisions });

const no = { yes: 0.02 };
const pick = (choice: string, p = 0.97): Answer => ({ choice, probabilities: { [choice]: p } });
/** The option whose label contains `text`. */
const option = (question: Question | undefined, text: string) => Object.entries(question && 'options' in question ? question.options : {}).find(([, label]) => label.includes(text))?.[0] ?? 'none';

/** A checkout page that fills as it is typed into and is replaced when its order is placed. */
function shop() {
	const fields: Record<string, string> = { 'Full name': '', Email: '' };
	let placed = false;
	const commands: BrowserInput[] = [];
	const snapshot = () =>
		placed
			? '- heading "Thanks, your order is placed" [level=1]'
			: [
					'- heading "Checkout" [level=1]',
					'- link "Help":',
					'  - /url: /help',
					...Object.entries(fields).map(([name, value]) => `- textbox "${name}"${value ? `: ${value}` : ''}`),
					'- button "Place order — $49.00"',
				].join('\n');
	const step = async (command: BrowserInput): Promise<BrowserState> => {
		commands.push(command);
		let problem: string | null = null;
		const name = /name="([^"]+)"/.exec(command.target ?? '')?.[1];
		if (command.action === 'type' && name && name in fields) fields[name] = command.text ?? '';
		else if (command.action === 'click' && name?.startsWith('Place order')) placed = true;
		else if (command.action === 'click') problem = 'No element matches';
		return { url: 'https://shop.test/checkout', title: 'Checkout', status: 200, problem, errors: [], screenshot: null, snapshot: snapshot() };
	};
	return { step, commands, fields, isPlaced: () => placed };
}

test('the page becomes a list of controls, each with a selector that finds exactly it', () => {
	const found = candidatesOf(
		[
			'- navigation:',
			'  - link "Docs":',
			'    - /url: /docs',
			'  - link "Docs":',
			'- textbox "Email": ada@example.com',
			'- textbox',
			'- searchbox "Search \\"all\\""',
			"- 'button \"Save: draft\"'",
			'- checkbox "Remember me" [checked]',
			'- paragraph: Some text',
		].join('\n'),
	);
	assert.deepEqual(
		found.map((candidate) => [candidate.kind, candidate.label, candidate.selector]),
		[
			['click', 'link "Docs"', 'role=link[name="Docs" s] >> nth=0'],
			['click', 'link "Docs"', 'role=link[name="Docs" s] >> nth=1'],
			['field', 'textbox "Email" holding "ada@example.com"', 'role=textbox[name="Email" s] >> nth=0'],
			['field', 'textbox (empty)', 'role=textbox >> nth=1'],
			['field', 'searchbox "Search "all"" (empty)', 'role=searchbox[name="Search \\"all\\"" s] >> nth=0'],
			['click', 'button "Save: draft"', 'role=button[name="Save: draft" s] >> nth=0'],
			['click', 'checkbox "Remember me" [checked]', 'role=checkbox[name="Remember me" s] >> nth=0'],
		],
	);
});

test('a form is filled in one round, and a click that would place an order stops for confirmation', async () => {
	const page = shop();
	asked = [];
	rule = (state, questions): Record<string, Answer> => {
		if (questions.risky) return { risky: { yes: 0.91 } };
		const filled = String(state.page).includes('Ada');
		return {
			done: no,
			stuck: no,
			action: pick(filled ? 'click' : 'type'),
			click: pick(option(questions.click, 'Place order')),
			...Object.fromEntries(Object.entries(questions).filter(([key]) => key.startsWith('value')).map(([key, question]) => [key, pick(option(question, question.instructions.includes('email') ? 'Email' : 'Full name'))])),
		};
	};
	const heard: number[] = [];
	const result = await autopilot('t1', page.step, { goal: 'Fill in the checkout form', values: { name: 'Ada', email: 'ada@example.com' } }, { onAction: (actions) => heard.push(actions.length) });
	assert.equal(result.outcome, 'needs_confirmation');
	assert.equal(result.about, 'button "Place order — $49.00"');
	assert.deepEqual(page.fields, { 'Full name': 'Ada', Email: 'ada@example.com' });
	assert.equal(page.isPlaced(), false);
	assert.deepEqual(result.actions.map((action) => action.what), ['Typed name into textbox "Full name"', 'Typed email into textbox "Email"']);
	assert.deepEqual(heard, [1, 2]);
	// One round fills both fields, a second picks the button, and a third asks whether it is safe.
	assert.equal(result.decisions, 3);
	assert.equal(asked.length, 3);
	assert.ok(Math.abs(result.cost - 0.0003) < 1e-9);
	assert.match(outcomeNote(result), /confirm set to its name/);
});

test('an element the agent confirms by name is clicked without asking', async () => {
	const page = shop();
	asked = [];
	rule = (state, questions): Record<string, Answer> => (String(state.page).includes('Thanks') ? { done: { yes: 0.97 }, stuck: no, action: pick('scroll') } : { done: no, stuck: no, action: pick('click'), click: pick(option(questions.click, 'Place order')) });
	const result = await autopilot('t1', page.step, { goal: 'Place the order', confirm: 'place order' });
	assert.equal(result.outcome, 'done');
	assert.equal(page.isPlaced(), true);
	assert.ok(asked.every((call) => !call.questions.risky));
});

test('an unsure choice hands the next step back with what was weighed, and a page that will not change ends as stuck', async () => {
	const page = shop();
	rule = (_state, questions) => ({ done: no, stuck: no, action: { choice: 'click', probabilities: { click: 0.4, scroll: 0.35, back: 0.25 } }, click: pick(option(questions.click, 'Help')) });
	let result = await autopilot('t1', page.step, { goal: 'Find the help page' });
	assert.equal(result.outcome, 'unsure');
	assert.match(result.about ?? '', /^it weighed: Click a link, button, tab or option \(0\.40\); Scroll down/);

	// The help link "works" but leaves the page as it was: two such actions and it stops.
	rule = (_state, questions) => ({ done: no, stuck: no, action: pick('scroll'), click: pick(option(questions.click, 'Help')) });
	result = await autopilot('t1', page.step, { goal: 'Find the help page' });
	assert.equal(result.outcome, 'stuck');
	assert.deepEqual(result.actions.map((action) => action.what), ['Scrolled down (nothing new)', 'Scrolled down (nothing new)']);
	// Each scroll that changed nothing waited for the page twice before giving up on it.
	assert.equal(page.commands.filter((command) => command.action === 'wait').length, 4);
});

test('a run stops after its most actions, and when the model is sure the goal is out of reach', async () => {
	const page = shop();
	let scrolls = 0;
	const step = async (command: BrowserInput) => ({ ...(await page.step(command)), snapshot: `- paragraph: ${command.action === 'scroll' ? ++scrolls : scrolls}` });
	rule = () => ({ done: no, stuck: no, action: pick('scroll') });
	let result = await autopilot('t1', step, { goal: 'Read to the end', maxActions: 3 });
	assert.equal(result.outcome, 'max_actions');
	assert.equal(result.actions.length, 3);
	rule = () => ({ done: no, stuck: { yes: 0.9 }, action: pick('scroll') });
	result = await autopilot('t1', step, { goal: 'Open the admin page' });
	assert.equal(result.outcome, 'stuck');
	assert.equal(result.actions.length, 0);
});
