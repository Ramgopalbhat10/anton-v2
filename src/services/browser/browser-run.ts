import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { RUN_FACADE, type RunExecute } from './browser-step.ts';

/** Each call it makes on the page has its own short timeout. */
export const RUN_MS = 120_000;
export const RUN_RESULT_CHARS = 4_000;
const MEMORY_BYTES = 64 * 1024 * 1024;

/** In a fresh QuickJS VM that reaches only `__call`, so model-written code never runs in Anton. A function passed to evaluate runs in the page. */
export const quickjsExecute: RunExecute = async (code, call) => {
	const sandbox = new CodemodeSandbox({
		timeoutMs: RUN_MS,
		memoryLimitBytes: MEMORY_BYTES,
		globals: [{ name: '__call', execute: (op) => call(op) }],
	});
	try {
		const result = await sandbox.execute(`const page = (${RUN_FACADE})(__call);\n${code}`);
		const logs = result.output.flatMap((item) => (item.type === 'text' ? [item.text] : []));
		if (!result.ok) throw new Error(result.error.kind === 'timeout' ? `The code did not finish within ${RUN_MS / 1000} seconds` : result.error.message);
		return { value: result.value, logs };
	} finally {
		await sandbox.close();
	}
};

export function codeReport(result: string | undefined, logs: string[] | undefined): { result: string; logs?: string[] } {
	const text = result ?? '';
	const cut = text.length > RUN_RESULT_CHARS ? `${text.slice(0, RUN_RESULT_CHARS)}… (cut at ${RUN_RESULT_CHARS} characters; return less)` : text;
	const kept: string[] = [];
	let left = RUN_RESULT_CHARS;
	for (const line of logs ?? []) {
		if (left <= 0) break;
		kept.push(line.slice(0, left));
		left -= line.length;
	}
	return { result: cut, ...(kept.length ? { logs: kept } : {}) };
}
