import type { FlueConversationMessage, FlueConversationPart, FlueConversationSettlement } from '@flue/react';
import { useMemo, useState } from 'react';
import { shortTodoId, todoHandoffId, todoRef } from '../../core/space-todos';

export type HandoffsBeforeTool = Map<string, FlueConversationMessage[]>;

function actionFor(parts: FlueConversationPart[], todo: string): number {
	let fallback = -1;
	for (const [index, part] of parts.entries()) {
		if (part.type !== 'dynamic-tool' || part.state === 'output-error' || (part.toolName !== 'start_thread' && part.toolName !== 'message_thread')) continue;
		const output = part.state === 'output-available' ? part.output : undefined;
		if (output && typeof output === 'object' && 'todoId' in output && typeof output.todoId === 'string') {
			if (shortTodoId(output.todoId) === todo) return index;
			continue;
		}
		// Pending calls and older transcripts only have the original tool input.
		if (fallback !== -1) continue;
		const ref = (part.input as { todo_id?: unknown } | undefined)?.todo_id;
		if (typeof ref !== 'string') continue;
		const id = todoRef(ref);
		if ((id.startsWith('todo_') ? shortTodoId(id) : id) === todo) fallback = index;
	}
	return fallback;
}

type PendingJoins = ReadonlyMap<string, string>;
const NO_JOINS: PendingJoins = new Map();

/** Flue lists joined inputs after the whole assistant reply. Show each board handoff before its first thread action. */
export function joinedTodoHandoffs(messages: FlueConversationMessage[], settlements: FlueConversationSettlement[], liveReply?: FlueConversationMessage, kept: PendingJoins = NO_JOINS) {
	const answeredBy = new Map(settlements.map((item) => [item.submissionId, item.answeredBySubmissionId]));
	const active = liveReply && !answeredBy.has(liveReply.submissionId ?? '') && liveReply.metadata?.completedAt === undefined && !liveReply.metadata?.usage ? liveReply : undefined;
	const ownReplies = new Set(messages.flatMap((message) => message.role === 'assistant' && !message.settlement && message.submissionId ? [message.submissionId] : []));
	const earlierReplies = new Map<string, FlueConversationMessage>();
	const seen = new Set<string>();
	const joined = new Map<FlueConversationMessage, { message: FlueConversationMessage; at: number }[]>();
	const pending = new Map<string, string>();
	let previousReply: FlueConversationMessage | undefined;
	for (const message of messages) {
		if (message.settlement) continue;
		if (message.role === 'assistant') {
			previousReply = message;
			if (message.submissionId) earlierReplies.set(message.submissionId, message);
			continue;
		}
		if (message.role !== 'user' || !message.submissionId) continue;
		const todo = todoHandoffId(message.parts.map((part) => part.type === 'text' ? part.text : '').join(''));
		if (!todo) continue;
		const host = answeredBy.get(message.submissionId);
		// Only a live reply can establish a provisional join. Finish metadata can arrive before Flue settles the joined submission.
		const provisional = !answeredBy.has(message.submissionId) && !ownReplies.has(message.submissionId) && !seen.has(todo)
			? kept.get(message.submissionId) ?? (active === previousReply ? active?.submissionId : undefined)
			: undefined;
		const reply = earlierReplies.get(host ?? provisional ?? '');
		seen.add(todo);
		if (!reply) continue;
		const at = actionFor(reply.parts, todo);
		if (at < 0) continue;
		if (!host && provisional) pending.set(message.submissionId, provisional);
		const entries = joined.get(reply) ?? [];
		entries.push({ message, at });
		joined.set(reply, entries);
	}
	const byReply = new Map<string, HandoffsBeforeTool>();
	const moved = new Set<string>();
	for (const [reply, entries] of joined) {
		const before: HandoffsBeforeTool = new Map();
		let at = reply.parts.length;
		// Keep the inputs in submission order even if their tools ran in a different order.
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			at = Math.min(at, entry.at);
			const part = reply.parts[at];
			if (part.type !== 'dynamic-tool') continue;
			before.set(part.toolCallId, [entry.message, ...(before.get(part.toolCallId) ?? [])]);
			moved.add(entry.message.id);
		}
		byReply.set(reply.id, before);
	}
	return { byReply, moved, pending };
}

export function useJoinedTodoHandoffs(spaceId: string, messages: FlueConversationMessage[], settlements: FlueConversationSettlement[], liveReply?: FlueConversationMessage) {
	const [saved, setSaved] = useState<{ spaceId: string; pending: PendingJoins }>({ spaceId, pending: NO_JOINS });
	const kept = saved.spaceId === spaceId ? saved.pending : NO_JOINS;
	const placed = useMemo(() => joinedTodoHandoffs(messages, settlements, liveReply, kept), [messages, settlements, liveReply, kept]);
	if (saved.spaceId !== spaceId || placed.pending.size !== kept.size || [...placed.pending].some(([id, host]) => kept.get(id) !== host)) {
		setSaved({ spaceId, pending: placed.pending });
	}
	return placed;
}
