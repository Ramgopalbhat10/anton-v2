import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupResources, skillInParts } from '../src/services/skill-parts.ts';
import { readFullResult } from '../src/services/tool-results.ts';

const BASE = '/.flue/packaged-skills/skill%3Adiagrams%3Aabc';
const files = ['SKILL-notes.md', 'references/style.md', 'references/types.md', 'scripts/export.py'];
const list = files.map((file) => `- ${file} → read_skill_resource ${BASE}/${file}`).join('\n');
const skill = (instructions: string) =>
	`Run the skill named "diagrams".\n\n<skill_instructions>\n${instructions}</skill_instructions>\n\n` +
	`Supporting skill resources are available but are not loaded into context unless needed:\n<skill_resources>\n${list}\n</skill_resources>`;
const result = (text: string) => ({ content: [{ type: 'text', text }] });
const textOf = (value: unknown) => (value as { content: Array<{ text: string }> }).content[0].text;

test('a skill’s files are listed once per folder, each still named', () => {
	assert.equal(
		groupResources(`${list}\n`),
		`Supporting skill resources are available but are not loaded into context unless needed. Read one with read_skill_resource ${BASE}/<path>, the path as listed (folder, then file name):\n<skill_resources>\nSKILL-notes.md\nreferences/ style.md, types.md\nscripts/ export.py\n`,
	);
	assert.equal(groupResources('- a.md → read_skill_resource /elsewhere/b.md\n'), null, 'a list in another shape is left alone');
	const given = textOf(skillInParts(result(skill('# Diagrams\n\nDraw them.\n')), 'k1', 'task'));
	assert.match(given, /<skill_instructions>\n# Diagrams\n\nDraw them\.\n<\/skill_instructions>/);
	assert.match(given, /references\/ style\.md, types\.md\nscripts\/ export\.py\n<\/skill_resources>$/);
});

test('instructions past 32KB keep their start and list the sections after it, each read from its offset', () => {
	const section = (n: number) => `## Section ${n}\n\n${'Step. '.repeat(1_000)}\n\n`;
	const instructions = `# Diagrams\n\n${Array.from({ length: 8 }, (_, n) => section(n)).join('')}`;
	const given = textOf(skillInParts(result(skill(instructions)), 'k2', 'task'));
	assert.ok(given.length < 20_000, `${given.length} characters`);
	assert.match(given, /\[The instructions go on for [\d,]+ more characters\. Read the sections the work needs with read_full_result, id "k2" and the offset given:\n/);
	const offsets = [...given.matchAll(/- ## Section (\d) \(offset (\d+)\)/g)];
	assert.ok(offsets.length >= 4);
	for (const [, n, offset] of offsets) assert.ok(readFullResult('task', 'k2', Number(offset)).startsWith(`## Section ${n}\n`));
	assert.match(given, /scripts\/ export\.py/, 'the files are listed after');
	assert.equal(textOf(skillInParts(result(skill(instructions)), 'k3', null)).includes(section(7)), true, 'a subagent’s comes whole');
});

test('anything else passes as it is', () => {
	const other = result('No skill named "x". Available: diagrams.');
	assert.equal(skillInParts(other, 'k4', 'task'), other);
	assert.equal(skillInParts('not a result', 'k5', 'task'), 'not a result');
});
