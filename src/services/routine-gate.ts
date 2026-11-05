import { CodemodeSandbox, type CodemodeTool } from '@earendil-works/pi-codemode';
import type { Automation, GateAnswer } from '../db/automations.ts';
import { httpRequest } from './http-request.ts';
import { installedSkillFile } from './plugins.ts';
import { readSpaceFile } from './space-files.ts';

/**
 * A routine's gate: a script from an installed skill that runs on Anton's side when a scheduled run is due, before
 * any thread starts, and answers whether this run is worth one. A trading check-in every 15 minutes mostly finds
 * nothing new; its gate reads the project's records and a few quotes and skips the run, so a quiet check-in costs no
 * model call and no sandbox. The script is the skill's own (`skill-name/scripts/gate.js`), so it updates with the skill.
 *
 * It runs like a run_script program, in a fresh QuickJS VM that reaches only what is handed to it: http_request (with
 * the sealed secrets filled in on Anton's side, as for the agent, and the answer not cut at the agent's 100k characters)
 * and read_project_file (the project's Library). It
 * gets `args` ({ now, lastRunAt, lastGate }) and returns `{ run, reason }`. A gate that fails lets the run start.
 */

const TIMEOUT_MS = 30_000;
const MEMORY_BYTES = 64 * 1024 * 1024;
/** A Library file a gate reads; its records are small. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REASON = 300;
/** Characters of an answer a gate is given: a script, not the model, reads it, so a whole market's quotes fit (about 400 KB per 500 stocks). */
const MAX_ANSWER = 4 * 1024 * 1024;
const GATE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/((?:[\w.-]+\/)*[\w.-]+\.js)$/;

/** Why `gate` cannot name a skill's script, or null. */
export function gateProblem(gate: string): string | null {
	if (!GATE.test(gate) || gate.split('/').some((part) => part === '..' || part === '.')) return 'Name the gate as skill-name/scripts/file.js, a script of an installed skill';
	return null;
}

function gateTools(automation: Automation): CodemodeTool[] {
	return [
		{
			name: 'http_request',
			description: "One HTTP request from Anton's server with {{secret:NAME}} filled in there. Resolves to the tool's text: status, a few headers, then the body (secrets hidden, cut past 4 MB).",
			inputSchema: {
				type: 'object',
				properties: {
					url: { type: 'string' },
					method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] },
					headers: { type: 'object', additionalProperties: { type: 'string' } },
					body: { type: 'string' },
				},
				required: ['url'],
			},
			outputSchema: { type: 'string' },
			// Nothing is saved: a gate only reads.
			execute: (args, { signal }) => {
				const { url, method, headers, body } = args as { url: string; method?: string; headers?: Record<string, string>; body?: string };
				return httpRequest(automation.id, { url, method, headers, body }, { signal, maxShown: MAX_ANSWER });
			},
		},
		{
			name: 'read_project_file',
			description: "A file of the project's Library as text, by its path there (a thread's ../project-files/<path>); null when there is none.",
			inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
			outputSchema: { type: ['string', 'null'] },
			execute: async (args) => {
				if (!automation.spaceId) return null;
				const bytes = await readSpaceFile(automation.spaceId, (args as { path: string }).path);
				if (!bytes) return null;
				if (bytes.length > MAX_FILE_BYTES) throw new Error(`${(args as { path: string }).path} is over 1 MB`);
				return new TextDecoder().decode(bytes);
			},
		},
	];
}

/** Runs the routine's gate and returns its answer; throws when the gate cannot run or fails. */
export async function runGate(automation: Automation & { gate: string }, now: number): Promise<GateAnswer> {
	const [skill, ...rest] = automation.gate.split('/');
	const text = await installedSkillFile(skill, rest.join('/'));
	if (text === null) throw new Error(`No installed skill that is on has ${automation.gate}`);
	const args = { now: new Date(now).toISOString(), lastRunAt: automation.lastRunAt, lastGate: automation.lastGate };
	const sandbox = new CodemodeSandbox({ tools: gateTools(automation), globals: [], timeoutMs: TIMEOUT_MS, memoryLimitBytes: MEMORY_BYTES });
	try {
		const result = await sandbox.execute(`const args = ${JSON.stringify(args)};\n${text}`);
		if (!result.ok) throw new Error(`${result.error.kind === 'timeout' ? 'ran out of time' : 'failed'}: ${result.error.message}`);
		const value = result.value as { run?: unknown; reason?: unknown } | boolean | undefined;
		const run = typeof value === 'boolean' ? value : Boolean(value?.run);
		const reason = typeof value === 'object' && value && typeof value.reason === 'string' ? value.reason.trim().slice(0, MAX_REASON) : '';
		return { at: new Date(now).toISOString(), run, reason };
	} finally {
		await sandbox.close();
	}
}
