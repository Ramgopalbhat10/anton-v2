import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mixText, runTasks, toolMix } from '../scripts/tool-mix.ts';

test('the tool mix adds up each model’s calls by tool over the replies, apart for each profile', () => {
	const gpt = 'openai/gpt-6.1-terra[872k]';
	const haiku = 'openrouter/anthropic/claude-haiku-5.5';
	const rows = toolMix([
		{ toolProfile: 'patch', tools: { [gpt]: { bash: 3, apply_patch: 2 }, [haiku]: { read: 4 } } },
		{ toolProfile: 'patch', tools: { [gpt]: { bash: 1, apply_patch: 1, read: 1 } } },
		{ toolProfile: 'edit', tools: { [gpt]: { bash: 9, edit: 1 } } },
		// From before profiles, and a reply with no calls.
		{ tools: { [gpt]: { edit: 1, bash: 1 } } },
		{},
	]);
	assert.deepEqual(rows, [
		{ model: gpt, profile: 'edit', replies: 2, tools: { bash: 10, edit: 2 } },
		{ model: gpt, profile: 'patch', replies: 2, tools: { bash: 4, apply_patch: 3, read: 1 } },
		{ model: haiku, profile: 'patch', replies: 1, tools: { read: 4 } },
	]);
	const text = mixText(rows);
	assert.match(text, /^openai\/gpt-6\.1-terra\[872k\] · edit profile · 2 replies · 12 tool calls\n {2}bash\s+10\s+83\.3%\n {2}edit\s+2\s+16\.7%/);
	assert.match(text, /openai\/gpt-6\.1-terra\[872k\] · patch profile · 2 replies · 8 tool calls\n {2}bash\s+4\s+50\.0%\n {2}apply_patch\s+3\s+37\.5%\n {2}read\s+1\s+12\.5%/);
	assert.equal(mixText([]), 'No tool calls in the replies read.');
});

test('the tool mix reads the tasks of an anton:run output file, and is an npm script', () => {
	assert.deepEqual(runTasks('{"name":"a","task":"t1","outcome":"completed"}\n\n{"name":"b","task":"t2"}\n'), ['t1', 't2']);
	assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts['tool:mix'], 'node --experimental-strip-types scripts/tool-mix.ts');
});
