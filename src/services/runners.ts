import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { SandboxProvider } from '../core/ports.ts';
import type { RunOn } from '../core/types.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { getProviders } from '../providers/index.ts';

/*
 * Where a task's commands run, picked per task in the composer's + menu: its
 * sandbox (Modal, Docker, or a folder, as ANTON_SANDBOX says), or This server,
 * a folder on the server Anton runs on, which goes out from its address and
 * reaches what it reaches. A task's machine is always looked for where its
 * task says, so the two never see each other's machines.
 */

/** Whether This server is a choice of its own: not when every task already runs in a folder here. */
export const hostRunnerAvailable = (): boolean => Boolean(getProviders().host);

export function runnerFor(runOn: RunOn): SandboxProvider {
	const { sandbox, host } = getProviders();
	return runOn === 'host' && host ? host : sandbox;
}

/** The runner of a task, or null for an id that is no task. */
export async function runnerOf(id: string): Promise<SandboxProvider | null> {
	const record = await getSessionRecord(id);
	return record ? runnerFor(record.runOn) : null;
}

/** Every runner, each once. */
export function allRunners(): SandboxProvider[] {
	const { sandbox, host } = getProviders();
	return host ? [sandbox, host] : [sandbox];
}

/** The keys of the machines running now, on every runner. */
export async function runningOnAll(): Promise<Set<string>> {
	const sets = await Promise.all(allRunners().map((runner) => runner.running().catch(() => new Set<string>())));
	return new Set(sets.flatMap((set) => [...set]));
}

/** Commands an agent commonly reaches for, checked on this server's PATH for a task that runs here. */
const COMMON_TOOLS = ['node', 'npm', 'bun', 'python3', 'pip3', 'uv', 'git', 'curl', 'jq', 'rg', 'sqlite3', 'docker'];

let toolsHere: { found: string[]; missing: string[] } | undefined;

/** Which common commands this server has, looked up once: a task on This server cannot install them as a sandbox would. */
export function toolsOnHost(): { found: string[]; missing: string[] } {
	if (toolsHere) return toolsHere;
	const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
	const has = (name: string) =>
		dirs.some((dir) => {
			try {
				accessSync(path.join(dir, name), constants.X_OK);
				return true;
			} catch {
				return false;
			}
		});
	// Node is what runs Anton, so it is there whatever PATH says.
	const found = COMMON_TOOLS.filter((name) => name === 'node' || has(name));
	toolsHere = { found, missing: COMMON_TOOLS.filter((name) => !found.includes(name)) };
	return toolsHere;
}
