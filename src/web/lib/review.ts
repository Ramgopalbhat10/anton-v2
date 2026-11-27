import { createContext, useCallback, useEffect, useState } from 'react';

/** A comment on one line or a range of the diff; `side` says whether `line` counts in the old or new file. `endLine` is inclusive when the comment spans several lines; `code` then joins the range's lines with newlines. */
export type ReviewComment = { path: string; side: 'old' | 'new'; line: number; endLine?: number; code: string; text: string };

/** Sends a message to the task's agent; provided by the task page so panels can talk to the agent. */
export const SendToAgent = createContext<((text: string) => Promise<void>) | null>(null);

const key = (sessionId: string) => `anton.review.${sessionId}`;

function load(sessionId: string): ReviewComment[] {
	try {
		return JSON.parse(sessionStorage.getItem(key(sessionId)) ?? '[]') as ReviewComment[];
	} catch {
		return [];
	}
}

/** Draft comments for a task, kept in sessionStorage so closing the panel or reloading keeps them. */
export function useReviewComments(sessionId: string) {
	const [comments, setComments] = useState(() => load(sessionId));
	useEffect(() => {
		try {
			sessionStorage.setItem(key(sessionId), JSON.stringify(comments));
		} catch {}
	}, [comments, sessionId]);
	const add = useCallback((comment: ReviewComment) => setComments((current) => [...current, comment]), []);
	const remove = useCallback((comment: ReviewComment) => setComments((current) => current.filter((item) => item !== comment)), []);
	const removeAll = useCallback((sent: ReviewComment[]) => setComments((current) => current.filter((item) => !sent.includes(item))), []);
	const clear = useCallback(() => setComments([]), []);
	return { comments, add, remove, removeAll, clear };
}

const snippet = (code: string) => (code.trim().length > 120 ? `${code.trim().slice(0, 117)}...` : code.trim());

function inlineCode(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = '`'.repeat(longest + 1);
	const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim().length > 0) ? ' ' : '';
	return `${fence}${pad}${text}${pad}${fence}`;
}

const SETEXT_UNDERLINE = /^\s*(?:=+|-+)\s*$/;
const TABLE_DELIMITER = /^\s*(?:\|\s*:?-{1,}:?(?:\s*\|\s*:?-{1,}:?)*\s*\|?|:?-{1,}:?\s*\|(?:\s*:?-{1,}:?\s*\|?)*)\s*$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s/;

function needsReviewBreak(lines: string[]): boolean {
	const first = lines[0] ?? '';
	if (SETEXT_UNDERLINE.test(first) || TABLE_DELIMITER.test(first) || ORDERED_ITEM.test(first)) return true;
	const second = lines[1];
	return second !== undefined && SETEXT_UNDERLINE.test(second);
}

export function reviewMessage(comments: ReviewComment[]): string {
	const items = comments.map((comment, index) => {
		const prefix = `${index + 1}. `;
		const indent = ' '.repeat(prefix.length);
		const span = comment.endLine !== undefined && comment.endLine !== comment.line ? `lines ${comment.line}–${comment.endLine}` : `line ${comment.line}`;
		const where = `${comment.path}, ${comment.side === 'old' ? 'removed ' : ''}${span}`;
		const code = comment.code.trim() ? ` (${inlineCode(snippet(comment.code))})` : '';
		const lines = comment.text.trim().replace(/\r\n?/g, '\n').split('\n');
		const sep = needsReviewBreak(lines) ? `\n\n${indent}` : `\n${indent}`;
		const body = lines.map((line, lineIndex) => (lineIndex > 0 && line ? `${indent}${line}` : line)).join('\n');
		return `${prefix}${where}${code}${sep}${body}`;
	});
	return ['Review comments on your changes. Address each one, then say briefly what you changed.', '', ...items].join('\n');
}
