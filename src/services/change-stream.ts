import { type Change, onChange } from '../core/changes.ts';

/** What `streamChanges` writes to: Hono's server-sent events stream. */
export type ChangeStream = {
	readonly aborted: boolean;
	onAbort(listener: () => void): void;
	writeSSE(message: { data: string }): Promise<void>;
	write(text: string): Promise<unknown>;
};

/** A comment line often enough that proxies (Cloudflare closes idle streams at 100 s) keep the stream open. */
export const HEARTBEAT_MS = 25_000;

/**
 * Sends an open page each change as it happens, and a comment line when
 * there are none. A change that lands while earlier ones are still being
 * written goes out right after them: waiting for the next change or the
 * heartbeat instead would leave a page showing a finished reply as still
 * being written, its question locked, for up to the heartbeat.
 */
export async function streamChanges(stream: ChangeStream, heartbeatMs = HEARTBEAT_MS): Promise<void> {
	const queue: Change[] = [];
	let wake: (() => void) | null = null;
	const stop = onChange((change) => {
		queue.push(change);
		wake?.();
	});
	stream.onAbort(() => {
		stop();
		wake?.();
	});
	try {
		while (!stream.aborted) {
			// Checked again after each write, as more can land while one is written.
			while (queue.length && !stream.aborted) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
			if (stream.aborted) break;
			const quiet = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(true), heartbeatMs);
				wake = () => {
					clearTimeout(timer);
					resolve(false);
				};
			});
			wake = null;
			if (quiet && !stream.aborted) await stream.write(': ping\n\n');
		}
	} finally {
		stop();
	}
}
