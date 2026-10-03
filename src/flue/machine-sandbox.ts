import { type FileStat, type Sandbox, type SandboxDriver, sandboxFromDriver } from '@flue/runtime';
import { readMachineFile, writeMachineFile } from '../core/machine-fs.ts';
import type { Machine } from '../core/ports.ts';
import { CommandError, quote, text } from '../core/shell.ts';

type ShellOptions = { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal };

/**
 * Adapts any `Machine` to Flue's sandbox contract, so the agent is provider-agnostic.
 * While `canWrite` says no, the file tools refuse to write; it is asked at each call.
 */
export function machineSandbox(machine: Machine, cwd: string, canWrite: () => boolean = () => true): Sandbox {
	function writable(): void {
		if (!canWrite()) throw new Error('Plan mode is on: nothing can be changed until the user approves your plan. Call propose_plan instead.');
	}

	async function check(command: string): Promise<string> {
		const result = await machine.exec(command);
		if (result.exitCode !== 0) throw new CommandError(command, result);
		return text(result.stdout);
	}

	const driver: SandboxDriver = {
		async exec(command: string, options?: ShellOptions) {
			const result = await machine.exec(command, options);
			return { stdout: text(result.stdout), stderr: result.stderr, exitCode: result.exitCode };
		},
		readFile: async (path) => text(await readMachineFile(machine, path)),
		readFileBuffer: (path) => readMachineFile(machine, path),
		async writeFile(path, content) {
			writable();
			await writeMachineFile(machine, path, typeof content === 'string' ? new TextEncoder().encode(content) : content);
		},
		async stat(path): Promise<FileStat> {
			const out = await check(`stat -L -c '%F|%s|%Y' -- ${quote(path)} && { test -L ${quote(path)} && echo link || echo plain; }`);
			const [fields, link] = out.trim().split('\n');
			const [type, size, mtime] = fields.split('|');
			return {
				isFile: type.startsWith('regular'),
				isDirectory: type === 'directory',
				isSymbolicLink: link === 'link',
				size: Number(size),
				mtime: new Date(Number(mtime) * 1000),
			};
		},
		readdir: async (path) => (await check(`ls -A1 -- ${quote(path)}`)).split('\n').filter(Boolean),
		exists: async (path) => (await machine.exec(`test -e ${quote(path)}`)).exitCode === 0,
		async mkdir(path, options) {
			writable();
			await check(`mkdir ${options?.recursive ? '-p ' : ''}-- ${quote(path)}`);
		},
		async rm(path, options) {
			writable();
			const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
			await check(`rm ${flags ? `-${flags} ` : ''}-- ${quote(path)}`);
		},
	};
	return sandboxFromDriver(driver, cwd);
}
