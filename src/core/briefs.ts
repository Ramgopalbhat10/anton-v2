/*
 * A thread's brief is the user's own words, quoted, and what the coordinator adds goes in a <project-context> block after
 * them. The checks at a reply's end hold the thread to its request, so only the quote is the request: twice a coordinator
 * grew a one-line ask into a checklist of checks the user never named, though its prompt said not to, and the thread spent
 * most of a long reply finishing them.
 */

const OPEN = '<project-context>';
const CLOSE = '</project-context>';
const CONTEXT = new RegExp(`\\n*${OPEN}[\\s\\S]*?${CLOSE}\\n*`, 'g');

export function threadBrief(request: string, context?: string): string {
	const extra = context?.trim();
	return extra ? `${request.trim()}\n\n${OPEN}\nBackground from the project, for finding your way; it adds no work to the request above.\n${extra}\n${CLOSE}` : request.trim();
}

/** The request without the coordinator's background. */
export const withoutContext = (text: string): string => text.replace(CONTEXT, '\n\n').trim();

const normal = (text: string) =>
	text
		.toLowerCase()
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();

/** Each part between ellipses appears in the message, ignoring case, spacing and punctuation. */
export function quotedFrom(request: string, message: string): boolean {
	const said = ` ${normal(message)} `;
	const parts = request
		.split(/\.\.\.|…|\[…\]|\[\.\.\.\]/)
		.map(normal)
		.filter(Boolean);
	return parts.length > 0 && parts.every((part) => said.includes(` ${part} `));
}
