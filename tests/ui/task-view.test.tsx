import { describe, expect, it } from 'vitest';
import { shownPaths, threadFolders } from '@/lib/project-library';
import { FACETS, taskNote } from '@/lib/task-view';
import { session } from './render';

describe('Task notes', () => {
	it('a task whose last reply asks you something waits on you, until it works again', () => {
		expect(taskNote(session({ asking: 'Should I run it against production too?' }))).toEqual({ text: 'Waiting on you', tone: 'warning', attention: true });
		expect(taskNote(session({ asking: 'Should I?', working: true }))?.text).toBe('Working');
		expect(taskNote(session({ asking: null }))?.attention ?? false).toBe(false);
	});

	it('a plan waits on your review only once the agent proposed one', () => {
		expect(taskNote(session({ planMode: true, usage: { inputTokens: 10, outputTokens: 10, cost: 0 } }))?.attention ?? false).toBe(false);
		expect(taskNote(session({ planMode: true, plan: '1. Change app.ts' }))).toEqual({ text: 'Plan ready for review', tone: 'warning', attention: true });
		expect(taskNote(session({ planMode: false, plan: '1. Change app.ts' }))?.attention ?? false).toBe(false);
	});
});

describe('Task status', () => {
	const status = (value: string) => (task: ReturnType<typeof session>) => FACETS.status.test(task, value);
	const sandbox = (value: string) => (task: ReturnType<typeof session>) => FACETS.sandbox.test(task, value);

	it('reads the states a project shows its threads in, apart from whether the sandbox runs', () => {
		const done = session({ resolvedAt: '2026-10-04T00:00:00Z', status: 'running' });
		const idle = session({});
		const failed = session({ status: 'error' });
		expect(FACETS.status.options().map((option) => option.label)).toEqual(['Needs you', 'Failed', 'Working', 'Queued', 'In review', 'Idle', 'Done']);
		expect([done, idle, failed].map(status('done'))).toEqual([true, false, false]);
		expect([done, idle, failed].map(status('idle'))).toEqual([false, true, false]);
		expect([done, idle, failed].map(status('attention'))).toEqual([false, false, true]);
		expect([done, idle].map(sandbox('running'))).toEqual([true, false]);
		// The server's word, when it gives one, is the one shown.
		expect(status('done')(session({ threadState: 'resolved' }))).toBe(true);
	});
});

describe('Project Library', () => {
	it('names a folder per thread, telling runs with one title apart by their day', () => {
		const runs = [
			session({ id: 'aaaaaa1', title: 'Daily briefing', createdAt: '2026-10-18T09:00:00Z' }),
			session({ id: 'bbbbbb2', title: 'Daily briefing', createdAt: '2026-10-19T09:00:00Z' }),
			session({ id: 'cccccc3', title: 'Daily briefing', createdAt: '2026-10-19T10:00:00Z' }),
			session({ id: 'dddddd4', title: 'Fix a/b' }),
		];
		const folders = threadFolders(runs);
		expect(folders.get('aaaaaa1')).toBe('Daily briefing · Oct 18');
		expect(folders.get('bbbbbb2')).toBe('Daily briefing · Oct 19 · bbbbbb');
		expect(folders.get('cccccc3')).toBe('Daily briefing · Oct 19 · cccccc');
		expect(folders.get('dddddd4')).toBe('Fix a∕b');
	});

	it("leaves Anton's own folders out of the path, unless two files would meet", () => {
		const shown = shownPaths(['renders/paper.html', 'images/logo.png', 'notes/plan.md', 'renders/report.html', 'report.html']);
		expect([...shown.values()]).toEqual(['paper.html', 'logo.png', 'notes/plan.md', 'renders/report.html', 'report.html']);
	});
});
