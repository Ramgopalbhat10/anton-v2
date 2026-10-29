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

/** A chat with a rail of bars: clicking one scrolls the chat to that input, and hovering one shows its preview. */
function chatRail() {
	let scrolledTo = 0;
	let hovered: string | null = null;
	const commands: BrowserInput[] = [];
	const step = async (command: BrowserInput): Promise<BrowserState> => {
		commands.push(command);
		const input = /Go to input (\d)/.exec(command.target ?? '')?.[1] ?? null;
		if (command.action === 'click' && input) scrolledTo = Number(input) * 900;
		if (command.action === 'hover') hovered = input;
		const snapshot = [
			'- navigation "Chat navigation":',
			...(hovered ? [`  - tooltip "Earlier request number ${hovered}"`] : []),
			'  - button "Go to input 1: tidy the panels"',
			'  - button "Go to input 2: fix the tests"',
			'- paragraph: The conversation',
		].join('\n');
		return { url: 'http://localhost:43127/agents/perf-task', title: 'Anton', status: null, problem: null, errors: [], screenshot: null, snapshot, view: `0,0 ${scrolledTo},0` };
	};
	return { step, commands };
}

test('a click that only scrolls the page counts as doing something, and hover is an action of its own', async () => {
	const rail = chatRail();
	rule = (_state, questions): Record<string, Answer> => (questions.risky ? { risky: no } : { done: no, stuck: no, action: pick('click'), click: pick(option(questions.click, 'Go to input 1')) });
	let result = await autopilot('t1', rail.step, { goal: 'Go to the first input', maxActions: 2 });
	assert.equal(result.outcome, 'max_actions', 'a scroll is a change, so it did not end as stuck after the first click');
	assert.equal(result.actions[0].what, 'Clicked button "Go to input 1: tidy the panels" (the page scrolled)');
	assert.equal(rail.commands.filter((command) => command.action === 'wait').length, 2, 'only the repeat, which scrolled nowhere new, waited for the page');

	asked = [];
	rule = (state, questions): Record<string, Answer> =>
		String(state.page).includes('tooltip') ? { done: { yes: 0.95 }, stuck: no, action: pick('scroll') } : { done: no, stuck: no, action: pick('hover'), click: pick(option(questions.click, 'Go to input 2')) };
	result = await autopilot('t1', chatRail().step, { goal: 'Hover over the second bar to show its preview' });
	assert.equal(result.outcome, 'done');
	assert.deepEqual(result.actions.map((action) => action.what), ['Hovered over button "Go to input 2: fix the tests"']);
	assert.ok(asked.every((call) => !call.questions.risky), 'hovering is never checked as risky');
	assert.match(String((asked[0].questions.action as { options: Record<string, string> }).options.hover), /tooltip, preview or menu/);
});

/** A counter app: Add one counts up, a tab switches views, and done comes once it reads 2. */
function counter() {
	let count = 0;
	const commands: BrowserInput[] = [];
	const snapshot = () => [`- tab "History"`, `- paragraph: "${count}"`, '- button "Add one"'].join('\n');
	const step = async (command: BrowserInput): Promise<BrowserState> => {
		commands.push(command);
		if (command.action === 'click' && command.target?.includes('Add one')) count += 1;
		return { url: 'http://localhost:3000/', title: 'Counter', status: 200, problem: null, errors: [], screenshot: null, snapshot: snapshot() };
	};
	return { step, commands, count: () => count };
}

test('a run starts on the page the step before opened, and asks about a button once however often it clicks it', async () => {
	const app = counter();
	asked = [];
	rule = (state, questions): Record<string, Answer> => {
		if (questions.risky) return { risky: no };
		const page = String(state.page);
		return { done: { yes: page.includes('"2"') ? 0.97 : 0.02 }, stuck: no, action: pick('click'), click: pick(option(questions.click, 'Add one')) };
	};
	const opened = await app.step({ action: 'open', url: 'http://localhost:3000' });
	const result = await autopilot('t', app.step, { goal: 'Click Add one twice so the counter reads 2' }, { start: opened });
	assert.equal(result.outcome, 'done');
	assert.equal(app.count(), 2);
	assert.deepEqual(app.commands.map((command) => command.action), ['open', 'click', 'click'], 'no look before the first round');
	assert.equal(asked.filter((call) => call.questions.risky).length, 1, 'the second click on the same button asks nothing');
	assert.equal(result.decisions, 4);
});

test('a tab is clicked without asking whether it buys or deletes anything', async () => {
	const app = counter();
	asked = [];
	let clicked = false;
	rule = (_state, questions): Record<string, Answer> => {
		if (questions.risky) return { risky: no };
		const done = clicked;
		clicked = true;
		return { done: { yes: done ? 0.97 : 0.02 }, stuck: no, action: pick('click'), click: pick(option(questions.click, 'History')) };
	};
	const result = await autopilot('t', app.step, { goal: 'Open the History tab' });
	assert.equal(result.outcome, 'done');
	assert.equal(asked.filter((call) => call.questions.risky).length, 0);
	assert.equal(app.commands[0].action, 'look', 'with no page in hand, the run looks first');
});

test('controls inside an iframe get selectors that enter it, counted within their frame', () => {
	const found = candidatesOf(
		[
			'- button "Pay now"',
			'- iframe',
			'- iframe [frame=1]:',
			'  - textbox "Card number"',
			'  - button "Pay now"',
			'- iframe [frame=3]:',
			'  - button "Pay now"',
			'- link "Terms"',
		].join('\n'),
	);
	assert.deepEqual(
		found.map((candidate) => [candidate.label, candidate.selector]),
		[
			['button "Pay now"', 'role=button[name="Pay now" s] >> nth=0'],
			['textbox "Card number" (in an embedded frame) (empty)', 'frame=1 >> role=textbox[name="Card number" s] >> nth=0'],
			['button "Pay now" (in an embedded frame)', 'frame=1 >> role=button[name="Pay now" s] >> nth=0'],
			['button "Pay now" (in an embedded frame)', 'frame=3 >> role=button[name="Pay now" s] >> nth=0'],
			['link "Terms"', 'role=link[name="Terms" s] >> nth=0'],
		],
	);
});

test('a button judged safe on a page is not asked about again in a later run of the same task', async () => {
	asked = [];
	rule = (state, questions): Record<string, Answer> => {
		if (questions.risky) return { risky: no };
		const page = String(state.page);
		return { done: { yes: page.includes('"1"') ? 0.97 : 0.02 }, stuck: no, action: pick('click'), click: pick(option(questions.click, 'Add one')) };
	};
	const first = counter();
	await autopilot('same-task', first.step, { goal: 'Click Add one once' });
	const second = counter();
	await autopilot('same-task', second.step, { goal: 'Click Add one once' });
	assert.equal(asked.filter((call) => call.questions.risky).length, 1, 'asked in the first run only');
	const other = counter();
	await autopilot('other-task', other.step, { goal: 'Click Add one once' });
	assert.equal(asked.filter((call) => call.questions.risky).length, 2, 'another task asks for itself');
});
