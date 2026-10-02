import type { Machine } from './ports.ts';
import { CommandError, quote } from './shell.ts';

/** Whole-file IO over `exec`, so every provider gets it for free. */
export async function readMachineFile(machine: Machine, path: string): Promise<Uint8Array> {
	const result = await machine.exec(`cat -- ${quote(path)}`);
	if (result.exitCode !== 0) throw new CommandError(`read ${path}`, result);
	return result.stdout;
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
