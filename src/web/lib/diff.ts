export type DiffLine =
	| { kind: 'hunk'; text: string }
	| { kind: 'context' | 'add' | 'remove'; number: number; text: string };

export type FileDiff = {
	path: string;
	status: 'A' | 'M' | 'D';
	added: number;
	removed: number;
	lines: DiffLine[];
};

/**
 * Parse a unified `git diff` patch into per-file line lists. Binary patches
 * list the file with no lines.
 */
export function parsePatch(patch: string): FileDiff[] {
	const files: FileDiff[] = [];
	let current: FileDiff | null = null;
	let oldLine = 0;
	let newLine = 0;

	for (const raw of patch.split('\n')) {
		if (raw.startsWith('diff --git ')) {
			const match = / b\/(.+)$/.exec(raw);
			const path = match?.[1] ?? raw.slice(11);
			current = { path, status: 'M', added: 0, removed: 0, lines: [] };
			files.push(current);
			continue;
		}
		if (!current) continue;
		if (raw.startsWith('new file mode')) current.status = 'A';
		else if (raw.startsWith('deleted file mode')) current.status = 'D';
		else if (raw.startsWith('@@')) {
			const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
			oldLine = Number(match?.[1] ?? 0);
			newLine = Number(match?.[2] ?? 0);
			current.lines.push({ kind: 'hunk', text: raw.replace(/^@@ /, '').replace(/ @@.*$/, '') });
		} else if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('index ')) {
			continue;
		} else if (raw.startsWith('+')) {
			current.added += 1;
			current.lines.push({ kind: 'add', number: newLine++, text: raw.slice(1) });
		} else if (raw.startsWith('-')) {
			current.removed += 1;
			current.lines.push({ kind: 'remove', number: oldLine++, text: raw.slice(1) });
		} else if (raw.startsWith(' ')) {
			current.lines.push({ kind: 'context', number: newLine++, text: raw.slice(1) });
			oldLine++;
		}
	}
	return files;
}
