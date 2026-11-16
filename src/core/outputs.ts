// A reply's link like `../outputs/shot.png` means nothing to a browser, so the thread reads it as the Library file it names.

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

export const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path);

export function linkTargets(text: string): string[] {
	return [...text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((match) => match[1]);
}

export function outputLinksIn(text: string): string[] {
	const paths: string[] = [];
	for (const target of linkTargets(text)) {
		const path = outputLinkPath(target);
		if (path && !paths.includes(path)) paths.push(path);
	}
	return paths;
}
