export type DiffLine =
	| { kind: 'hunk'; text: string }
	| { kind: 'context' | 'add' | 'remove'; number: number; text: string };

export type FileDiff = {
	path: string;
	prevPath?: string;
	status: 'A' | 'M' | 'D';
	added: number;
	removed: number;
	lines: DiffLine[];
	patch: string;
};

/** Binary patches list the file with no lines. */
export function parsePatch(patch: string): FileDiff[] {
	const files: FileDiff[] = [];
	let current: FileDiff | null = null;
	let currentRaw: string[] = [];
	let renameFrom: string | undefined;
	let minusPath: string | undefined;
	let plusPath: string | undefined;
	let oldLine = 0;
	let newLine = 0;

	const flush = () => {
		if (!current) return;
		const prev = renameFrom ?? (minusPath && plusPath && minusPath !== plusPath ? minusPath : undefined);
		if (prev && prev !== current.path) current.prevPath = prev;
		current.patch = `${currentRaw.join('\n')}\n`;
		currentRaw = [];
		renameFrom = undefined;
		minusPath = undefined;
		plusPath = undefined;
	};

	const rawLines = patch.split('\n');
	if (rawLines.at(-1) === '') rawLines.pop();

	for (const raw of rawLines) {
		if (raw.startsWith('diff --git ')) {
			flush();
			const match = / b\/(.+)$/.exec(raw);
			const path = match?.[1] ?? raw.slice(11);
			current = { path, status: 'M', added: 0, removed: 0, lines: [], patch: '' };
			currentRaw = [raw];
			files.push(current);
			continue;
		}
		if (!current) continue;
		currentRaw.push(raw);
		if (raw.startsWith('new file mode')) current.status = 'A';
		else if (raw.startsWith('deleted file mode')) current.status = 'D';
		else if (raw.startsWith('rename from ')) renameFrom = raw.slice('rename from '.length);
		else if (raw.startsWith('rename to ')) current.path = raw.slice('rename to '.length);
		else if (raw.startsWith('--- a/')) minusPath = raw.slice('--- a/'.length);
		else if (raw.startsWith('+++ b/')) plusPath = raw.slice('+++ b/'.length);
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
	flush();
	return files;
}
