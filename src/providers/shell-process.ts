import { spawn } from 'node:child_process';
import type { ExecResult } from '../core/ports.ts';

/** How long the output may stay quiet after the shell exits before exec stops waiting for it. */
const OUTPUT_GRACE_MS = 1000;
/**
 * The most of each stream kept; the rest is read and dropped. Past 512MB Node cannot make the stream a string at
 * all and the server dies (ERR_STRING_TOO_LONG): one command printing in a loop is enough.
 */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

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
		const sizes = new Map<Buffer[], number>();
		// Output after settling, or past the cap, is read and dropped, so a background process never blocks or dies writing it.
		const collect = (into: Buffer[]) => (chunk: Buffer) => {
			if (settled) return;
			lastChunkAt = Date.now();
			const size = sizes.get(into) ?? 0;
			if (size >= MAX_STREAM_BYTES) return;
			const kept = chunk.subarray(0, MAX_STREAM_BYTES - size);
			into.push(kept);
			sizes.set(into, size + kept.length);
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
