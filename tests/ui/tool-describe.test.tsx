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

	it('draws a tool it does not know by its name', () => {
		expect(sentence('some_new_tool', {})).toBe('Called some_new_tool');
	});
});
