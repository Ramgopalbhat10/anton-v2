import type { FlueConversationMessage, FlueConversationPart } from '@flue/react';
import type { Join } from '@/lib/api';

/** The runtime lists a message sent while the agent worked after the whole reply it joined, so the reply is cut after the tool call where the agent read it (joins.ts). */

export type ThreadRow = {
	message: FlueConversationMessage;
	/** The stretch of a cut reply this row shows; its first carries the header, its last the footer. */
	segment?: { key: string; parts: FlueConversationPart[]; first: boolean; last: boolean };
	joined?: boolean;
};

/** The page compares as much of a message as the server keeps. */
const JOIN_TEXT = 500;

export const messageText = (message: FlueConversationMessage) => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');

const isTool = (part: FlueConversationPart): part is Extract<FlueConversationPart, { type: 'dynamic-tool' }> => part.type === 'dynamic-tool';

/** Where in the reply's parts the message was read: after its tool call, and after the words that closed the reply when it came in last. */
function cutAt(parts: FlueConversationPart[], join: Join): number | null {
	const index = parts.findIndex((part) => isTool(part) && part.toolCallId === join.afterTool);
	if (index === -1) return null;
	// The step's last call to start: the message is read once its calls are back.
	let at = index + 1;
	if (join.final) while (at < parts.length && (parts[at].type === 'text' || parts[at].type === 'reasoning')) at += 1;
	return at;
}

/** Slices kept per reply, so a reply that did not change keeps its rows and its memoized render. */
const slices = new WeakMap<FlueConversationPart[], Map<string, FlueConversationPart[]>>();

function slice(parts: FlueConversationPart[], from: number, to: number): FlueConversationPart[] {
	let kept = slices.get(parts);
	if (!kept) slices.set(parts, (kept = new Map()));
	const key = `${from}:${to}`;
	let cut = kept.get(key);
	if (!cut) kept.set(key, (cut = parts.slice(from, to)));
	return cut;
}

/** Each message sent while the agent worked moved into the reply it joined; `answeredBy` is the reply that answered each message. */
export function placeJoined(messages: FlueConversationMessage[], joins: Join[], answeredBy: Map<string, string | undefined>, liveReply?: FlueConversationMessage): ThreadRow[] {
	if (!joins.length) return messages.map((message) => ({ message }));
	const unused = [...joins];
	const cuts = new Map<FlueConversationMessage, Array<{ at: number; message: FlueConversationMessage }>>();
	const moved = new Set<FlueConversationMessage>();
	messages.forEach((message, index) => {
		if (message.role !== 'user' || !message.submissionId) return;
		const host = answeredBy.get(message.submissionId);
		// Answered by the reply it joined; or, before that reply settles, sent after the reply still being written.
		const reply =
			host && host !== message.submissionId
				? messages.find((other) => other.role === 'assistant' && other.submissionId === host)
				: !answeredBy.has(message.submissionId) && liveReply && messages.indexOf(liveReply) < index
					? liveReply
					: undefined;
		if (!reply || messages.indexOf(reply) > index) return;
		const text = messageText(message).trim().slice(0, JOIN_TEXT);
		const found = unused.findIndex((join) => join.text === text);
		if (found === -1) return;
		const at = cutAt(reply.parts, unused[found]);
		if (at === null) return;
		unused.splice(found, 1);
		cuts.set(reply, [...(cuts.get(reply) ?? []), { at, message }]);
		moved.add(message);
	});
	if (!moved.size) return messages.map((message) => ({ message }));
	const rows: ThreadRow[] = [];
	for (const message of messages) {
		if (moved.has(message)) continue;
		const at = cuts.get(message);
		if (!at) {
			rows.push({ message });
			continue;
		}
		const points = [...at].sort((a, b) => a.at - b.at);
		let from = 0;
		points.forEach((point, index) => {
			rows.push({ message, segment: { key: `${message.id}~${index}`, parts: slice(message.parts, from, point.at), first: index === 0, last: false } });
			rows.push({ message: point.message, joined: true });
			from = point.at;
		});
		rows.push({ message, segment: { key: message.id, parts: slice(message.parts, from, message.parts.length), first: false, last: true } });
	}
	return rows;
}
