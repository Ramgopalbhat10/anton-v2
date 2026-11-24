import type { FlueConversationMessage, FlueConversationPart } from '@flue/react';
import { describe, expect, it } from 'vitest';
import { joinedTodoHandoffs } from '@/lib/coordinator-handoffs';

const handoff = (submissionId: string, todoId: string): FlueConversationMessage => ({
	id: `u-${submissionId}`, submissionId, role: 'user', purpose: 'user', display: 'visible',
	parts: [{ type: 'text', state: 'done', text: `Start the project to-do [todo:${todoId}]: Work on ${todoId}` }],
});
const tool = (toolCallId: string, todo_id: string, toolName = 'start_thread'): FlueConversationPart => ({
	type: 'dynamic-tool', state: 'input-available', toolCallId, toolName, input: { todo_id },
});
const reply = (submissionId: string, ...parts: FlueConversationPart[]): FlueConversationMessage => ({
	id: `a-${submissionId}`, submissionId, role: 'assistant', purpose: 'assistant', display: 'visible', parts,
});

describe('joined to-do handoffs', () => {
	it('keeps joined inputs in their original order if the coordinator acts on them in reverse', () => {
		const a = handoff('first', 'aaaaaaaa');
		const b = handoff('second', 'bbbbbbbb');
		const c = handoff('third', 'cccccccc');
		const host = reply('first', tool('first-start', 'aaaaaaaa'), tool('third-send', 'cccccccc', 'message_thread'), tool('second-start', 'todo_bbbbbbbb'), tool('second-split', '[todo:bbbbbbbb]'));
		const { byReply, moved } = joinedTodoHandoffs([a, host, b, c], []);
		expect([...byReply.get(host.id)!]).toEqual([['third-send', [b, c]]]);
		expect(moved).toEqual(new Set([b.id, c.id]));
	});

	it('leaves unrelated inputs, separate replies, and unlinked retries where they were', () => {
		const a = handoff('first', 'aaaaaaaa');
		const retry = handoff('retry', 'aaaaaaaa');
		const separate = handoff('separate', 'bbbbbbbb');
		const unmatched = handoff('unmatched', 'cccccccc');
		const host = reply('first', tool('first-start', 'aaaaaaaa'), tool('other-marker', 'bbbbbbbb'), tool('not-a-dispatch', 'cccccccc', 'remember'));
		const { byReply, moved } = joinedTodoHandoffs([a, host, retry, unmatched, separate, reply('separate')], []);
		expect(byReply.size).toBe(0);
		expect(moved.size).toBe(0);
	});

	it('uses explicit settlement linkage rather than the nearest reply in history', () => {
		const a = handoff('first', 'aaaaaaaa');
		const b = handoff('second', 'bbbbbbbb');
		const host = reply('first', tool('first-start', 'aaaaaaaa'), tool('second-start', '[todo:bbbbbbbb]'));
		const other = reply('other', tool('not-this-start', 'bbbbbbbb'));
		const { byReply } = joinedTodoHandoffs([a, host, other, b], [{ submissionId: 'second', outcome: 'completed', answeredBySubmissionId: 'first' }]);
		expect([...byReply]).toEqual([[host.id, new Map([['second-start', [b]]])]]);
	});
});
