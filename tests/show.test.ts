import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, formMessage, libraryPath, parseFormula, specText, type UiNode } from '../src/core/ui-spec.ts';
import { checkImages, checkSpec, SHOW_INPUT, shownNote } from '../src/services/show.ts';

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
	assert.throws(() => checkSpec({ children: [{ type: 'image', path: '../../etc/passwd' }] }), /path in the Library/);
	assert.throws(() => checkSpec({ children: [{ type: 'image', path: '/etc/passwd' }] }), /path in the Library/);
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

test('an image named through the outputs folder is the Library path it names, and one not in the Library is refused', async () => {
	assert.equal(libraryPath('/workspace/outputs/nourish/desktop.png'), 'nourish/desktop.png');
	assert.equal(libraryPath('../outputs/screenshots/home.png'), 'screenshots/home.png');
	assert.equal(libraryPath('outputs/home.png'), 'home.png');
	assert.equal(libraryPath('screenshots/home.png'), 'screenshots/home.png');
	assert.equal(libraryPath('src/outputs/x.png'), 'src/outputs/x.png', 'only a path through the outputs folder itself');
	const spec = checkSpec({ children: [{ type: 'image', path: '/workspace/outputs/nourish/desktop.png', alt: 'Nourish' }] });
	assert.deepEqual(spec.children[0], { type: 'image', path: 'nourish/desktop.png', alt: 'Nourish' });
	await checkImages(spec, async (path) => path === 'nourish/desktop.png');
	await assert.rejects(checkImages(spec, async () => false), /"nourish\/desktop.png" is not in the Library/);
});

test('the tool’s schema leaves each component open to its fields, so a provider that constrains output to it does not cut them off', () => {
	// An object with a rest is what the runtime's JSON schema gives additionalProperties; a loose object gets none.
	const [children] = SHOW_INPUT.entries.children.pipe;
	assert.equal(children.item.type, 'object_with_rest');
});
