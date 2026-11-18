import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { quotedFrom, threadBrief, withoutContext } from '../src/core/briefs.ts';

const ASK =
	'When the agent is starting to respond, there is no animation of this icon like we had earlier where it rotates, jumps, expands, etc. I want that animation back till the agent keeps doing it work and stops once the entire response is rendered.';

test("a request copied from the user's message passes, whatever its case, spacing and punctuation", () => {
	assert.ok(quotedFrom(ASK, ASK));
	assert.ok(quotedFrom('i want that animation back   till the agent keeps doing it work', ASK));
	assert.ok(quotedFrom('When the agent is starting to respond … I want that animation back', ASK));
	assert.ok(quotedFrom('Fix the login page’s “Save” button', 'hey, fix the login page\'s "save" button please'));
});

test('a request the coordinator wrote or grew is refused', () => {
	// What a coordinator sent in place of the ask above.
	const grown =
		'Restore the previous animated Anton icon in chat while the agent is working. Handle completion, errors and cancellation correctly, respect reduced-motion settings, add regression coverage and verify in running UI.';
	assert.ok(!quotedFrom(grown, ASK));
	assert.ok(!quotedFrom(`${ASK} Also check it at 320px and on mobile.`, ASK));
	assert.ok(!quotedFrom('animation', 'animations'), 'whole words only');
	assert.ok(!quotedFrom('…', ASK));
});

test("the coordinator's background goes after the request, and the reply checks read only the request", () => {
	const brief = threadBrief('Fix the export button on Safari.', 'The button is in src/web/export.tsx; the user decided to drop the old CSV path.');
	assert.match(brief, /^Fix the export button on Safari\.\n\n<project-context>\n[\s\S]+src\/web\/export\.tsx[\s\S]+<\/project-context>$/);
	assert.equal(withoutContext(brief), 'Fix the export button on Safari.');
	assert.equal(threadBrief('Fix it.', '  '), 'Fix it.');
	const attached = `${brief}\n\n<attachment name="a.png" path="a.png" kind="PNG image" size="1" library="project">\nAn image\n</attachment>`;
	assert.equal(withoutContext(attached), 'Fix the export button on Safari.\n\n<attachment name="a.png" path="a.png" kind="PNG image" size="1" library="project">\nAn image\n</attachment>');
});

test("start_thread checks the request against the user's message", () => {
	const source = readFileSync(new URL('../src/agents/coordinator.ts', import.meta.url), 'utf8');
	assert.match(source, /if \(said\.trim\(\) && !data\.approved && !quotedFrom\(data\.request, said\)\)/);
	assert.match(source, /threadBrief\(data\.request, data\.context\)/);
});
