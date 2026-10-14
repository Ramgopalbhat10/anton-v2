import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, formMessage, parseFormula, specText, type UiNode } from '../src/core/ui-spec.ts';
import { checkSpec, shownNote } from '../src/services/show.ts';

const card = {
	title: 'Spend this week',
	children: [
		{ type: 'row', children: [{ type: 'stat', label: 'Total', value: 12.5, format: 'currency', change: '+8%' }, { type: 'stat', label: 'Tasks', value: 14 }] },
		{ type: 'chart', kind: 'bar', x: 'day', series: [{ key: 'cost', label: 'Cost' }], data: [{ day: 'Mon', cost: 2 }, { day: 'Tue', cost: 3.5 }], format: 'currency' },
		{ type: 'table', columns: [{ key: 'model' }, { key: 'cost', format: 'currency' }], rows: [{ model: 'kimi', cost: 7 }, { model: 'opus', cost: 5.5 }] },
	],
};

test('a card from the catalog passes, and the agent is told what the user sees', () => {
	const spec = checkSpec(card);
	const note = shownNote(spec);
	assert.match(note, /## Spend this week/);
	assert.match(note, /Total: \$12\.50 \(\+8%\)/);
	assert.match(note, /bar chart of Cost by day, 2 points/);
	assert.match(note, /\| kimi \| \$7\.00 \|/);
	// Nothing to press, so it says nothing about answers.
	assert.doesNotMatch(note, /next message/);
});

test('a card that does not fit the catalog comes back to the agent with what to fix', () => {
	assert.throws(() => checkSpec({ children: [{ type: 'stat', label: 'Total' }] }), /children\[0\]\.value/);
	assert.throws(() => checkSpec({ children: [{ type: 'carousel' }] }), /not valid/);
	assert.throws(() => checkSpec({ children: [{ type: 'chart', kind: 'line', x: 'day', series: [{ key: 'cost' }], data: [{ day: 'Mon', price: 1 }] }] }), /names "cost", which no data row has/);
	assert.throws(
		() => checkSpec({ children: [{ type: 'number', name: 'qty' }, { type: 'value', label: 'Total', formula: 'qty * price' }] }),
		/reads "price", which is not an input's name/,
	);
	assert.throws(() => checkSpec({ children: [{ type: 'value', label: 'Total', formula: 'alert(1)' }] }), /Unknown function alert/);
	assert.throws(() => checkSpec({ children: [{ type: 'toggle', name: 'a', label: 'A' }, { type: 'toggle', name: 'a', label: 'B' }] }), /Two inputs are named "a"/);
	assert.throws(() => checkSpec({ children: [{ type: 'image', path: '../../etc/passwd' }] }), /relative to the repository or the Library/);
	assert.throws(() => checkSpec({ children: [{ type: 'text', text: 'x'.repeat(70_000) }] }), /too big/);
});

test('formulas are arithmetic over the inputs, with no way to reach anything else', () => {
	const total = parseFormula('round(price * seats * (1 - discount / 100), 2)');
	assert.equal(evaluate(total, { price: 19.99, seats: 3, discount: 10 }), 53.97);
	assert.equal(evaluate(parseFormula('2 ** 3 ** 2'), {}), 512);
	assert.equal(evaluate(parseFormula('-2 * 3 + 10 % 4'), {}), -4);
	assert.equal(evaluate(parseFormula('seats > 10 ? seats * 9 : seats * 10'), { seats: 12 }), 108);
	assert.ok(Number.isNaN(evaluate(parseFormula('missing + 1'), {})));
	for (const bad of ['constructor.constructor("x")()', 'a[0]', 'a; b', '`x`', 'max(1,']) assert.throws(() => parseFormula(bad));
});

test('a form sends its title and each input as words', () => {
	const form: Extract<UiNode, { type: 'form' }> = {
		type: 'form',
		title: 'Deploy settings',
		children: [
			{ type: 'select', name: 'region', label: 'Region', options: [{ label: 'EU West', value: 'eu-west' }, { label: 'US East', value: 'us-east' }] },
			{ type: 'number', name: 'replicas', label: 'Replicas' },
			{ type: 'toggle', name: 'canary', label: 'Canary first' },
			{ type: 'choice', name: 'checks', label: 'Checks', multiple: true, options: [{ label: 'Smoke' }, { label: 'Load' }] },
		],
	};
	assert.equal(
		formMessage(form, { region: 'eu-west', replicas: 3, canary: true, checks: ['Smoke', 'Load'] }),
		'Submitted "Deploy settings":\n- Region: EU West\n- Replicas: 3\n- Canary first: on\n- Checks: Smoke, Load',
	);
	const spec = checkSpec({ children: [form] });
	assert.match(shownNote(spec), /arrives as their next message/);
	assert.match(specText(spec), /Form "Deploy settings":/);
});
