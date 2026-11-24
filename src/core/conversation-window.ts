/**
 * A conversation's latest turns, and older ones a page at a time, cut from Flue's history snapshot. A turn starts at a
 * message you sent; a message that joined a reply already under way belongs to that reply's turn, so it never starts one.
 */

export type HistoryMessage = { id: string; role: string; submissionId?: string; joined?: boolean };
type HistorySettlement = { submissionId: string; answeredBySubmissionId?: string };
export type HistorySnapshot = { messages: HistoryMessage[]; settlements?: HistorySettlement[]; incarnation?: string };

/** Turns sent when a conversation opens and per older page. */
export const WINDOW_TURNS = 10;
export const MAX_WINDOW_TURNS = 50;

/** `before`: the first message sent, to ask for what precedes it; null when nothing does. */
export type WindowInfo = { before: string | null; total: number };
export type OlderPage = { messages: HistoryMessage[]; before: string | null; incarnation: string | null };

function joinedHosts(history: HistorySnapshot): Map<string, string> {
	const hosts = new Map<string, string>();
	for (const { submissionId, answeredBySubmissionId } of history.settlements ?? []) {
		if (answeredBySubmissionId && answeredBySubmissionId !== submissionId) hosts.set(submissionId, answeredBySubmissionId);
	}
	return hosts;
}

/** Where the `turns`-th last turn before `end` starts; 0 when there are no more turns than that. */
function turnStart(history: HistorySnapshot, end: number, turns: number): number {
	const hosts = joinedHosts(history);
	let seen = 0;
	for (let index = end - 1; index >= 0; index--) {
		const message = history.messages[index];
		if (message.role !== 'user' || message.joined === true || (message.submissionId && hosts.has(message.submissionId))) continue;
		seen += 1;
		if (seen === turns) return index;
	}
	return 0;
}

/** The snapshot with only its latest `turns` turns, and where the rest begins. Everything else in it, settlements included, is kept whole. */
export function latestTurns<T extends HistorySnapshot>(history: T, turns: number): T & { window: WindowInfo } {
	const start = turnStart(history, history.messages.length, turns);
	return { ...history, messages: history.messages.slice(start), window: { before: start > 0 ? history.messages[start].id : null, total: history.messages.length } };
}

/**
 * The snapshot from the message `from` on, so a conversation read again (after a dropped connection) starts where it
 * started before and what you scrolled to stays joined up. If that input has since settled as a join, include its
 * host turn too. When the message is gone, take the latest `turns` turns.
 */
export function turnsFrom<T extends HistorySnapshot>(history: T, from: string, turns: number): T & { window: WindowInfo } {
	let start = history.messages.findIndex((message) => message.id === from);
	if (start < 0) return latestTurns(history, turns);
	const anchor = history.messages[start];
	if (anchor.role === 'user' && anchor.submissionId) {
		const host = joinedHosts(history).get(anchor.submissionId);
		if (host) {
			const hostStart = history.messages.findIndex((message) => message.submissionId === host && (message.role === 'user' || message.role === 'assistant'));
			if (hostStart >= 0 && hostStart < start) start = hostStart;
		}
	}
	return { ...history, messages: history.messages.slice(start), window: { before: start > 0 ? history.messages[start].id : null, total: history.messages.length } };
}

/** The `turns` turns before the message `before`, or null when that message is gone (the conversation was rewound or compacted since). */
export function turnsBefore(history: HistorySnapshot, before: string, turns: number): OlderPage | null {
	const end = history.messages.findIndex((message) => message.id === before);
	if (end < 0) return null;
	const start = turnStart(history, end, turns);
	return { messages: history.messages.slice(start, end), before: start > 0 ? history.messages[start].id : null, incarnation: history.incarnation ?? null };
}

/** A count of turns from a query: a whole number from 1 to the cap, or null. */
export function turnsParam(value: string | undefined): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const turns = Number(value);
	return turns >= 1 ? Math.min(turns, MAX_WINDOW_TURNS) : null;
}
