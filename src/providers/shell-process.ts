import { spawn } from 'node:child_process';
import type { ExecResult } from '../core/ports.ts';

/** How long the output may stay quiet after the shell exits before exec stops waiting for it. */
const OUTPUT_GRACE_MS = 1000;

export type ProcessOptions = { cwd?: string; env: Record<string, string>; stdin?: Uint8Array; signal?: AbortSignal; timeoutMs?: number };

/**
 * Runs a shell command's process (`bash -lc` here, `docker exec` into a container) to its end. A server it leaves in
 * the background may hold the output open for good, so it stops waiting once the process has exited and the output
 * has been quiet for a moment, and never keeps Anton's own process alive.
 */
export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { cwd: options.cwd, env: options.env, signal: options.signal, timeout: options.timeoutMs });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let lastChunkAt = Date.now();
		let settled = false;
		// Output after settling is read and dropped, so a background process never blocks or dies writing it.
		const collect = (into: Buffer[]) => (chunk: Buffer) => {
			if (settled) return;
			into.push(chunk);
			lastChunkAt = Date.now();
		};
		child.stdout.on('data', collect(out));
		child.stderr.on('data', collect(err));
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			// A server started in the background may hold the pipes for good; they must not keep Anton's process alive.
			(child.stdout as unknown as { unref?: () => void }).unref?.();
			(child.stderr as unknown as { unref?: () => void }).unref?.();
			child.unref();
			resolve({
				stdout: new Uint8Array(Buffer.concat(out)),
				stderr: Buffer.concat(err).toString('utf8'),
				exitCode: code ?? child.exitCode ?? 124,
			});
		};
		child.on('error', reject);
		// A server started in the background keeps the output open: stop waiting once it has been quiet for a moment.
		child.on('exit', (code) => {
			const check = () => {
				const quiet = Date.now() - lastChunkAt;
				if (quiet >= OUTPUT_GRACE_MS) finish(code);
				else setTimeout(check, OUTPUT_GRACE_MS - quiet);
			};
			lastChunkAt = Math.max(lastChunkAt, Date.now());
			setTimeout(check, OUTPUT_GRACE_MS);
		});
		child.on('close', (code) => finish(code));
		child.stdin.end(options.stdin ?? undefined);
	});
}
