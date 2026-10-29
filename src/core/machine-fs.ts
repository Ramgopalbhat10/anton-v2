import type { Machine } from './ports.ts';
import { CommandError, quote } from './shell.ts';

/** Reads of a file that came back a different size from it before the read is given up. */
const READ_TRIES = 3;

/**
 * Whole-file IO over `exec`, so every provider gets it for free. The file's size
 * goes to stderr before its bytes, and a read that came back short is read again:
 * a provider can stop collecting output it is still sending (Modal keeps a second
 * of quiet after the command exits), and a cut file would otherwise pass for whole,
 * as a broken screenshot or a checkpoint with half a file.
 */
export async function readMachineFile(machine: Machine, path: string): Promise<Uint8Array> {
	for (let attempt = 1; ; attempt++) {
		const result = await machine.exec(`wc -c < ${quote(path)} >&2 && cat -- ${quote(path)}`);
		if (result.exitCode !== 0) throw new CommandError(`read ${path}`, result);
		const size = Number.parseInt(result.stderr.trim().split('\n').pop() ?? '', 10);
		// No size (a provider without stderr) or the size it said: as before.
		if (!Number.isFinite(size) || size === result.stdout.length) return result.stdout;
		// A file still being written changes size between reads; the last read is what it holds now.
		if (attempt >= READ_TRIES) {
			if (result.stdout.length < size) throw new Error(`Could not read all of ${path}: ${result.stdout.length} of ${size} bytes arrived`);
			return result.stdout;
		}
	}
}

export async function writeMachineFile(machine: Machine, path: string, content: Uint8Array): Promise<void> {
	const result = await machine.exec(`cat > ${quote(path)}`, { stdin: content });
	if (result.exitCode !== 0) throw new CommandError(`write ${path}`, result);
}

export type MachineFileInfo = { path: string; size: number; mtimeMs: number };

/** Regular files under `dir`, relative to it. */
export async function listMachineFiles(machine: Machine, dir: string): Promise<MachineFileInfo[]> {
	const result = await machine.exec(`test -d ${quote(dir)} && cd ${quote(dir)} && find . -type f -printf '%P\\t%s\\t%T@\\n'`);
	if (result.exitCode !== 0) return [];
	return new TextDecoder()
		.decode(result.stdout)
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [path, size, mtime] = line.split('\t');
			return { path, size: Number(size), mtimeMs: Math.round(Number(mtime) * 1000) };
		});
}
