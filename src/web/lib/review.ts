import { createContext, useCallback, useEffect, useState } from 'react';

/** A comment on one line of the diff; `side` says whether `line` counts in the old or new file. */
export type ReviewComment = { path: string; side: 'old' | 'new'; line: number; code: string; text: string };

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
	const clear = useCallback(() => setComments([]), []);
	return { comments, add, remove, clear };
}

const snippet = (code: string) => (code.trim().length > 120 ? `${code.trim().slice(0, 117)}...` : code.trim());

/** One message the agent can work through: where each comment is, the code it is on, and what it says. */
export function reviewMessage(comments: ReviewComment[]): string {
	const items = comments.map((comment, index) => {
		const where = `${comment.path}, ${comment.side === 'old' ? 'removed line' : 'line'} ${comment.line}`;
		const code = comment.code.trim() ? ` (\`${snippet(comment.code)}\`)` : '';
		return `${index + 1}. ${where}${code}\n   ${comment.text.trim().replace(/\n/g, '\n   ')}`;
	});
	return ['Review comments on your changes. Address each one, then say briefly what you changed.', '', ...items].join('\n');
}
