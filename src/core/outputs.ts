/*
 * The agent saves what it makes to the outputs folder beside its working
 * folder, which the user sees as the task's Library, and names those files
 * in its replies by their path there: `../outputs/shot.png` from its working
 * folder, or `/workspace/outputs/shot.png`. A link like that means nothing
 * to a browser (it would resolve against the page's own address), so the
 * thread reads it as the Library file it names.
 */

/** The Library path a reply's link or image names, or null when it points anywhere else. */
export function outputLinkPath(href: string): string | null {
	const trimmed = href.trim();
	// Another site, a page anchor, or a protocol-relative address.
	if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
	const bare = trimmed.replace(/[?#].*$/, '');
	let decoded: string;
	try {
		decoded = decodeURI(bare);
	} catch {
		decoded = bare;
	}
	const inside = /^(?:\.\.\/|\.\/)?outputs\/(.+)$/.exec(decoded) ?? /^\/(?:[^/]+\/)*outputs\/(.+)$/.exec(decoded);
	const path = inside?.[1];
	if (!path || path.endsWith('/') || path.split('/').some((part) => part === '..' || part === '.' || part === '')) return null;
	return path;
}

/** Whether a Library file shows as a picture. */
export const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path);

/** Where each Markdown link and image in a text points, in order. */
export function linkTargets(text: string): string[] {
	return [...text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((match) => match[1]);
}

/** The Library paths a reply's text links to or shows, in the order it names them, each once. */
export function outputLinksIn(text: string): string[] {
	const paths: string[] = [];
	for (const target of linkTargets(text)) {
		const path = outputLinkPath(target);
		if (path && !paths.includes(path)) paths.push(path);
	}
	return paths;
}
