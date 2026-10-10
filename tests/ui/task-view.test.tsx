import { describe, expect, it } from 'vitest';
import { taskNote } from '@/lib/task-view';
import { session } from './render';

describe('Task notes', () => {
	it('a task whose last reply asks you something waits on you, until it works again', () => {
		expect(taskNote(session({ asking: 'Should I run it against production too?' }))).toEqual({ text: 'Waiting on you', tone: 'warning', attention: true });
		expect(taskNote(session({ asking: 'Should I?', working: true }))?.text).toBe('Working');
		expect(taskNote(session({ asking: null }))?.attention ?? false).toBe(false);
	});
});
