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

	it('draws a tool it does not know by its name', () => {
		expect(sentence('some_new_tool', {})).toBe('Called some_new_tool');
	});
});
