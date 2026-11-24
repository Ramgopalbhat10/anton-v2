import type { FlueConversationMessage, FlueConversationPart, FlueConversationSettlement } from '@flue/react';
import { shortTodoId, todoHandoffId, todoRef } from '../../core/space-todos';

export type HandoffsBeforeTool = Map<string, FlueConversationMessage[]>;

function toolTodo(part: FlueConversationPart): string | null {
	if (part.type !== 'dynamic-tool' || (part.toolName !== 'start_thread' && part.toolName !== 'message_thread')) return null;
	const output = part.state === 'output-available' ? part.output : undefined;
	if (output && typeof output === 'object' && 'todoId' in output && typeof output.todoId === 'string') return shortTodoId(output.todoId);
	// Pending calls and older transcripts only have the original tool input.
	const ref = (part.input as { todo_id?: unknown } | undefined)?.todo_id;
	if (typeof ref !== 'string') return null;
	const id = todoRef(ref);
	return id.startsWith('todo_') ? shortTodoId(id) : id;
}

/** Flue lists joined inputs after the whole assistant reply. Show each board handoff before its first thread action. */
export function joinedTodoHandoffs(messages: FlueConversationMessage[], settlements: FlueConversationSettlement[], liveReply?: FlueConversationMessage) {
	const answeredBy = new Map(settlements.map((item) => [item.submissionId, item.answeredBySubmissionId]));
	const active = liveReply && !answeredBy.has(liveReply.submissionId ?? '') && liveReply.metadata?.completedAt === undefined && !liveReply.metadata?.usage ? liveReply : undefined;
	const ownReplies = new Set(messages.flatMap((message) => message.role === 'assistant' && !message.settlement && message.submissionId ? [message.submissionId] : []));
	const earlierReplies = new Map<string, FlueConversationMessage>();
	const seen = new Set<string>();
	const joined = new Map<FlueConversationMessage, { message: FlueConversationMessage; at: number }[]>();
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
		// A matching tool is provisional evidence only while both sides are active. Retries need explicit linkage.
		const provisional = active && active === previousReply && !answeredBy.has(message.submissionId) && !ownReplies.has(message.submissionId) && !seen.has(todo);
		const reply = host ? earlierReplies.get(host) : provisional ? active : undefined;
		seen.add(todo);
		if (!reply) continue;
		const at = reply.parts.findIndex((part) => toolTodo(part) === todo);
		if (at < 0) continue;
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
	return { byReply, moved };
}
