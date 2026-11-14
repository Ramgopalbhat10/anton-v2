import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { config } from '../../config.ts';

/** JSONL is intentionally local IPC, not an HTTP service or an agent runtime. */
export type WorkerRequest = { action: 'models' | 'stream'; key: string; [field: string]: unknown };
export type WorkerMessage = { type: string; models?: DevinModel[]; event?: unknown; message?: string };
export type DevinModel = {
	id: string;
	requestModelId?: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};
export type WorkerOptions = { executable?: string; script?: string; timeoutMs?: number };

export function runDevinWorker(request: WorkerRequest, receive: (message: WorkerMessage) => void, signal?: AbortSignal, options: WorkerOptions = {}): Promise<void> {
	if (signal?.aborted) return Promise.reject(new DOMException('Devin request cancelled.', 'AbortError'));
	return new Promise((resolve, reject) => {
		const dir = path.resolve('workers/devin');
		const child = spawn(options.executable ?? (config.devinBun || path.join(dir, 'node_modules/.bin/bun')), [options.script ?? path.join(dir, 'worker.mjs')], {
			stdio: ['pipe', 'pipe', 'ignore'],
			// Do not inherit server secrets, preload hooks, or credentials from other providers.
			env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
		});
		const lines = createInterface({ input: child.stdout });
		let complete = false;
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill('SIGTERM');
			killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
			killTimer.unref();
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			if (error) { stop(); reject(error); } else resolve();
		};
		const safe = (value: string) => value.replaceAll(request.key, '[redacted]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted token]');
		const abort = () => finish(new DOMException('Devin request cancelled.', 'AbortError'));
		const timer = setTimeout(() => finish(new Error('Devin worker timed out. Try again or use SWE-2.')), options.timeoutMs ?? 300_000);
		timer.unref();
		signal?.addEventListener('abort', abort, { once: true });
		child.on('error', () => finish(new Error('Devin worker could not start. Run npm run setup:devin on the server (Bun is installed separately).')));
		child.stdin.on('error', () => finish(new Error('Devin worker closed its input unexpectedly.')));
		child.on('close', (code) => {
			clearTimeout(killTimer);
			lines.close();
			if (signal?.aborted) abort();
			else if (!complete || code !== 0) finish(new Error('Devin worker stopped before completing. Check its installation with npm run setup:devin.'));
			else finish();
		});
		lines.on('line', (line) => {
			if (settled) return;
			try {
				const message = JSON.parse(line) as WorkerMessage;
				// Only diagnostics are redactable. Text, deltas and executable tool
				// arguments may legitimately contain JWT fixtures and must be lossless.
				if (typeof message.message === 'string' && message.type === 'failure') message.message = safe(message.message);
				if (message.type === 'event' && message.event && typeof message.event === 'object') {
					const event = message.event as Record<string, unknown>;
					for (const field of ['partial', 'message', 'error']) {
						const output = event[field];
						if (!output || typeof output !== 'object') continue;
						const diagnostic = output as Record<string, unknown>;
						for (const name of ['errorMessage', 'errorClassificationMessage']) {
							if (typeof diagnostic[name] === 'string') diagnostic[name] = safe(diagnostic[name]);
						}
					}
				}
				if (message.type === 'failure') finish(new Error(message.message ?? 'Devin worker failed.'));
				else if (message.type === 'complete') complete = true;
				else receive(message);
			} catch { finish(new Error('Devin worker returned an invalid response.')); }
		});
		child.stdin.end(JSON.stringify(request));
	});
}

export async function discoverDevinModels(key: string, options?: WorkerOptions): Promise<DevinModel[]> {
	let models: DevinModel[] | undefined;
	await runDevinWorker({ action: 'models', key }, (message) => { if (message.type === 'models') models = message.models; }, undefined, options);
	if (!models?.length) throw new Error('Neither SWE-2 Flash nor SWE-2 is available to this Devin account.');
	return models;
}
