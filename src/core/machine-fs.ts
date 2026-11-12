import type { Machine } from './ports.ts';
import { CommandError, quote } from './shell.ts';

/** Reads of a file that came back a different size from it before the read is given up. */
const READ_TRIES = 3;

/** Why a file could not be read or written, in the words the shell uses, from a Node or provider error code. */
const REASONS: Record<string, string> = {
	ENOENT: 'No such file or directory',
	EISDIR: 'Is a directory',
	ENOTDIR: 'Not a directory',
	EACCES: 'Permission denied',
	EPERM: 'Operation not permitted',
	ENOSPC: 'No space left on device',
	EROFS: 'Read-only file system',
};

export const reasonOf = (error: unknown): string => REASONS[(error as { code?: string })?.code ?? ''] ?? (error instanceof Error ? error.message : String(error));

/**
 * The error a provider's own read or write gives (`Machine.readFile`, `writeFile`): the `CommandError` the shell's
 * gives, naming the same operation and path with the same reason, without the shell's own `bash: line 1:` before it.
 */
export function fileError(operation: 'read' | 'write', path: string, reason: string): CommandError {
	return new CommandError(`${operation} ${path}`, { stdout: new Uint8Array(), stderr: `${path}: ${reason}`, exitCode: 1 });
}

/**
 * Whole-file IO, through the machine's own file access when it has one (`Machine.readFile`, `writeFile`: no login
 * shell per read and write), else over `exec`, so every provider gets it for free. Through `exec`, the file's size
 * goes to stderr before its bytes, and a read that came back short is read again:
 * a provider can stop collecting output it is still sending (Modal keeps a second
 * of quiet after the command exits), and a cut file would otherwise pass for whole,
 * as a broken screenshot or a checkpoint with half a file.
 */
export async function readMachineFile(machine: Machine, path: string): Promise<Uint8Array> {
	const direct = await machine.readFile?.(path);
	if (direct) return direct;
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
	if (await machine.writeFile?.(path, content)) return;
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
