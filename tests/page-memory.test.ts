import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetPages, pageForAgent } from '../src/services/page-memory.ts';

const page = (items: string[]) => ['- banner:', '  - link "Home"', '- main:', ...items.map((item) => `  - listitem: ${item}`), '- contentinfo:', '  - text: Footer'].join('\n');
const list = Array.from({ length: 30 }, (_, index) => `Story ${index + 1}`);

test('a page comes back whole the first time, and as unchanged after', () => {
	forgetPages('t:panel');
	const first = page(list);
	assert.equal(pageForAgent('t:panel', 'https://news.ycombinator.com/', first), first);
	assert.match(pageForAgent('t:panel', 'https://news.ycombinator.com/#top', first), /^\(This page is unchanged since the last step/);
	assert.equal(pageForAgent('t:panel', 'https://news.ycombinator.com/', first, true), first, 'full asks for all of it');
});

test('a changed page comes back as its changes, with context, and back on an earlier page diffs against that view', () => {
	forgetPages('t:panel');
	pageForAgent('t:panel', 'https://news.ycombinator.com/', page(list));
	pageForAgent('t:panel', 'https://news.ycombinator.com/item?id=1', '- main:\n  - text: Comments');
	const changed = [...list];
	changed[4] = 'Story 5 (updated)';
	const answer = pageForAgent('t:panel', 'https://news.ycombinator.com/', page(changed));
	assert.match(answer, /^\(Changes since 2 steps ago/);
	assert.match(answer, /^- {3}- listitem: Story 5$/m);
	assert.match(answer, /^\+ {3}- listitem: Story 5 \(updated\)$/m);
	assert.match(answer, /^ {4}- listitem: Story 4$/m, 'a line of context before');
	assert.ok(!answer.includes('Story 20'), 'far from the change is left out');
	assert.ok(answer.length < page(changed).length / 2);
});

test('a page that mostly changed comes back whole, and browsers are remembered apart', () => {
	forgetPages('t:panel');
	forgetPages('t:sandbox');
	pageForAgent('t:panel', 'http://x.test/', page(list));
	const other = page(list.map((item) => `${item}!`));
	assert.equal(pageForAgent('t:panel', 'http://x.test/', other), other);
	assert.equal(pageForAgent('t:sandbox', 'http://x.test/', other), other, 'the sandbox browser has not seen it');
});
