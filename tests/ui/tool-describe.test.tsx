import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { describeTool, toolTone } from '@/components/tool-describe';
import { nowText } from '@/lib/now-text';

const sentence = (toolName: string, input: unknown) => render(<p>{describeTool({ toolName, input }).body}</p>).container.textContent;

describe('background jobs in the thread', () => {
	it('reads as a command started in the background, and a job checked, waited for or stopped', () => {
		expect(sentence('run_in_background', { command: 'npm test\n# all' })).toBe('Started npm test in the background');
		expect(sentence('check_job', { job: 2 })).toBe('Checked job 2');
		expect(sentence('check_job', { job: 2, wait: 120 })).toBe('Waited for job 2');
		expect(sentence('check_job', { job: 3, stop: true })).toBe('Stopped job 3');
		expect(toolTone('run_in_background', false)).toBe(toolTone('bash', false));
		expect(nowText({ what: 'running', tool: 'check_job', detail: null, since: '', chars: 0 } as never, 'replying')).toBe('Checking a background job');
	});

	it('draws read, grep and glob, with the repository they named, and the old read-only tools of earlier tasks the same way', () => {
		expect(sentence('read', { path: 'src/app.ts', offset: 10, limit: 5 })).toBe('Read src/app.ts:10-14');
		expect(sentence('read', { path: 'src/app.ts', repo: 'acme/other' })).toBe('Read src/app.ts in acme/other');
		expect(sentence('grep', { pattern: 'answer', context: 2 })).toBe('Searched answer');
		expect(sentence('glob', { pattern: '**/*.ts', repo: 'acme/other@main' })).toBe('Listed **/*.ts in acme/other@main');
		// Conversations from before keep their calls, and chats still make them.
		expect(sentence('read_file', { path: 'README.md' })).toBe('Read README.md');
		expect(sentence('search_code', { pattern: 'TODO' })).toBe('Searched TODO');
		expect(sentence('list_files', { glob: '*.md' })).toBe('Listed *.md');
		expect(sentence('list_files', {})).toBe('Listed the repository');
		const running = (tool: string, detail: string | null) => nowText({ what: 'running', tool, detail, since: '', chars: 0 } as never, 'replying');
		expect(running('start_workspace', null)).toBe('Starting the sandbox');
		expect(running('read_file', 'src/app.ts')).toBe('Reading app.ts');
		expect(running('grep', null)).toBe('Searching the code');
		expect(running('list_files', null)).toBe('Listing files');
	});

	it('draws an apply_patch call as the files it changed, and the now line as the file it is writing', () => {
		const patch = (...lines: string[]) => ({ input: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') });
		expect(sentence('apply_patch', patch('*** Update File: src/a.ts', '@@', ' x', '-y', '+z', '+w'))).toBe('Edited src/a.ts +2 -1');
		expect(sentence('apply_patch', patch('*** Add File: docs/new.md', '+# New', '+text'))).toBe('Wrote docs/new.md +2');
		expect(sentence('apply_patch', patch('*** Delete File: old.ts'))).toBe('Deleted old.ts');
		expect(sentence('apply_patch', patch('*** Update File: a.ts', '*** Move to: b.ts'))).toBe('Moved a.ts to b.ts +0 -0');
		const many = patch('*** Add File: a', '+1', '*** Add File: b', '+2', '*** Update File: c', '@@', '-3', '+4', '*** Delete File: d');
		expect(sentence('apply_patch', many)).toBe('Edited 4 files a, b, c and 1 more +3 -1');
		expect(sentence('apply_patch', { input: 'not a patch' })).toBe('Applied a patch');
		expect(toolTone('apply_patch', false)).toBe(toolTone('edit', false));
		const now = (what: string, detail: string | null, chars = 0) => nowText({ what, tool: 'apply_patch', detail, since: '', chars } as never, 'replying');
		expect(now('writing', 'src/a.ts', 2048)).toBe('Editing a.ts · 2.0 KB');
		expect(now('writing', null)).toBe('Writing a patch');
		expect(now('running', 'src/a.ts')).toBe('Saving a.ts');
		expect(now('running', null)).toBe('Applying a patch');
	});

	it('draws a tool it does not know by its name', () => {
		expect(sentence('some_new_tool', {})).toBe('Called some_new_tool');
	});
});
