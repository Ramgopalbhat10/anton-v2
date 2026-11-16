import { type Change, onChange } from '../../core/changes.ts';

export type ChangeStream = {
	readonly aborted: boolean;
	onAbort(listener: () => void): void;
	writeSSE(message: { data: string }): Promise<void>;
	write(text: string): Promise<unknown>;
};

/** Cloudflare closes idle streams at 100 s. */
export const HEARTBEAT_MS = 25_000;

/** A change that lands while earlier ones are being written goes out right after them, not at the next heartbeat. */
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
