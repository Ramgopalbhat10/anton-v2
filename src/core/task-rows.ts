import type { Session } from './types.ts';

/** Texts a list row shows a line of; a page that needs one whole reads the task alone. */
export const CUT_FIELDS = ['lastReply', 'lastInput', 'brief', 'plan'] as const;
export type CutField = (typeof CUT_FIELDS)[number];

/** Enough for the first line of prose after headings and lists, which is all a row shows (`threadLine`); a reply opens with them most. */
export const ROW_TEXT_CHARS: Record<CutField, number> = { lastReply: 600, lastInput: 300, brief: 300, plan: 300 };

/** A project's newest threads whose last replies stay whole: a coordinator link to a copied path is matched against them (`useThreadFileResolver`). */
export const WHOLE_REPLY_THREADS = 24;

export type TaskRow = Session & { cut?: CutField[] };

function shorten(text: string, chars: number): string {
	let end = chars;
	// Not between the two halves of a surrogate pair.
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return text.slice(0, end);
}

/** The task list as rows: long texts cut, each row naming what was cut. `sessions` is newest first. */
export function taskRows(sessions: Session[]): TaskRow[] {
	const whole = new Map<string, number>();
	return sessions.map((session) => {
		const keepReply = session.spaceId ? (whole.get(session.spaceId) ?? 0) < WHOLE_REPLY_THREADS : false;
		if (session.spaceId) whole.set(session.spaceId, (whole.get(session.spaceId) ?? 0) + 1);
		const cut: CutField[] = [];
		const row: TaskRow = { ...session };
		for (const field of CUT_FIELDS) {
			const text = session[field];
			if (field === 'lastReply' && keepReply) continue;
			if (typeof text === 'string' && text.length > ROW_TEXT_CHARS[field]) {
				row[field] = shorten(text, ROW_TEXT_CHARS[field]);
				cut.push(field);
			}
		}
		if (cut.length) row.cut = cut;
		return row;
	});
}
