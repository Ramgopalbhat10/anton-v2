import { describe, expect, it } from 'vitest';
import { taskNote } from '@/lib/task-view';
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
