import type { FlueConversationMessage, FlueConversationPart, FlueConversationSettlement } from '@flue/react';
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
		const { byReply, moved } = joinedTodoHandoffs([a, host, b, c], [], host);
		expect([...byReply.get(host.id)!]).toEqual([['third-send', [b, c]]]);
		expect(moved).toEqual(new Set([b.id, c.id]));
	});

	it('leaves unrelated inputs, separate replies, and unlinked retries where they were', () => {
		const a = handoff('first', 'aaaaaaaa');
		const retry = handoff('retry', 'aaaaaaaa');
		const separate = handoff('separate', 'bbbbbbbb');
		const unmatched = handoff('unmatched', 'cccccccc');
		const host = reply('first', tool('first-start', 'aaaaaaaa'), tool('other-marker', 'bbbbbbbb'), tool('not-a-dispatch', 'cccccccc', 'remember'));
		const { byReply, moved } = joinedTodoHandoffs([a, host, retry, unmatched, separate, reply('separate')], [], host);
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

	it.each(['start_thread', 'message_thread'] as const)('uses the resolved to-do from %s instead of the wrong raw ID', (toolName) => {
		const b = handoff('board', 'bbbbbbbb');
		const unrelated = handoff('other', 'cccccccc');
		const host = reply('chat', { type: 'dynamic-tool', toolName, toolCallId: 'dispatch', state: 'output-available', input: { todo_id: 'cccccccc' }, output: { output: 'Done', todoId: 'todo_bbbbbbbb' } });
		const { byReply, moved } = joinedTodoHandoffs([host, b, unrelated], [{ submissionId: 'board', outcome: 'completed', answeredBySubmissionId: 'chat' }], host);
		expect([...byReply]).toEqual([[host.id, new Map([['dispatch', [b]]])]]);
		expect(moved).toEqual(new Set([b.id]));
	});

	it('keeps a new handoff after a finished ordinary reply that failed to start the same to-do', () => {
		const board = handoff('board', 'bbbbbbbb');
		const host = reply('chat', { type: 'dynamic-tool', toolName: 'start_thread', toolCallId: 'old-start', state: 'output-error', input: { todo_id: 'bbbbbbbb' }, errorText: 'Request is not the user’s words' });
		const settled: FlueConversationSettlement = { submissionId: 'chat', outcome: 'completed' };
		expect(joinedTodoHandoffs([host, board], [settled], host).moved.size).toBe(0);
		expect(joinedTodoHandoffs([host, board], [settled, { submissionId: 'board', outcome: 'failed' }]).moved.size).toBe(0);
		const finished = { ...host, metadata: { completedAt: 42 } };
		expect(joinedTodoHandoffs([finished, board], [], finished).moved.size).toBe(0);
		expect(joinedTodoHandoffs([host, board], []).moved.size).toBe(0);
	});

	it('does not use provisional linkage for a settled handoff even if the candidate reply is live', () => {
		const board = handoff('board', 'bbbbbbbb');
		const host = reply('chat', tool('old-start', 'bbbbbbbb'));
		expect(joinedTodoHandoffs([host, board], [{ submissionId: 'board', outcome: 'failed' }], host).moved.size).toBe(0);
	});
});
