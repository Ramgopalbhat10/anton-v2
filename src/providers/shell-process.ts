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

/** How long a stopped command's group has after TERM before it is killed. */
const KILL_GRACE_MS = 2000;

/**
 * Stops the whole process group. Node's own `signal` ends only the shell, and what it started goes on: a setup stopped
 * on This server left its `npm install` running.
 */
function stopGroup(pid: number | undefined): void {
	if (!pid) return;
	const kill = (signal: NodeJS.Signals) => {
		try {
			process.kill(-pid, signal);
		} catch {
			// The group has already ended.
		}
	};
	kill('SIGTERM');
	setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref();
}

const aborted = (signal: AbortSignal) => Object.assign(new Error('The operation was aborted', { cause: signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' });

/** A server left in the background may hold the output open for good, so this stops waiting once the process exits and the output is quiet. */
export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const { signal } = options;
		if (signal?.aborted) return reject(aborted(signal));
		// In a group of its own, so a stop reaches everything the command started.
		const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: Boolean(signal), timeout: options.timeoutMs });
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
		const onAbort = () => {
			if (settled) return;
			settled = true;
			stopGroup(child.pid);
			reject(aborted(signal!));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		child.on('exit', () => signal?.removeEventListener('abort', onAbort));
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
