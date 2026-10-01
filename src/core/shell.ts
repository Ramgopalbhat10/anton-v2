import type { ExecOptions, ExecResult, Machine } from './ports.ts';

export function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

const decoder = new TextDecoder();

export function text(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

/** Runs a command and returns stdout as text, throwing on a non-zero exit. */
export async function run(machine: Machine, command: string, options?: ExecOptions): Promise<string> {
	const result = await machine.exec(command, options);
	if (result.exitCode !== 0) throw new CommandError(command, result);
	return text(result.stdout);
}

export class CommandError extends Error {
	readonly result: ExecResult;
	constructor(command: string, result: ExecResult) {
		const detail = result.stderr.trim() || text(result.stdout).trim() || `exit ${result.exitCode}`;
		super(`\`${command.split('\n')[0]}\` failed: ${detail.slice(0, 500)}`);
		this.result = result;
	}
}

/**
 * Normalises a client-supplied repo path and rejects anything that could
 * leave the repo: absolute paths, `..` segments and empty names.
 */
export function safeRelativePath(input: string): string {
	const parts = input.split('/').filter((part) => part !== '' && part !== '.');
	if (parts.length === 0 || input.startsWith('/') || parts.includes('..')) {
		throw new Error(`Invalid path: ${input}`);
	}
	return parts.join('/');
}
