import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { SandboxProvider } from '../../core/ports.ts';
import type { RunOn } from '../../core/types.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { getProviders } from '../../providers/index.ts';

// A task's machine is always looked for on its own runner, so a sandbox and This server never see each other's machines.

/** Not when every task already runs in a folder here. */
export const hostRunnerAvailable = (): boolean => Boolean(getProviders().host);

export function runnerFor(runOn: RunOn): SandboxProvider {
	const { sandbox, host } = getProviders();
	return runOn === 'host' && host ? host : sandbox;
}

export async function runnerOf(id: string): Promise<SandboxProvider | null> {
	const record = await getSessionRecord(id);
	return record ? runnerFor(record.runOn) : null;
}

export function allRunners(): SandboxProvider[] {
	const { sandbox, host } = getProviders();
	return host ? [sandbox, host] : [sandbox];
}

export async function runningOnAll(): Promise<Set<string>> {
	const sets = await Promise.all(allRunners().map((runner) => runner.running().catch(() => new Set<string>())));
	return new Set(sets.flatMap((set) => [...set]));
}

const COMMON_TOOLS = ['node', 'npm', 'bun', 'python3', 'pip3', 'uv', 'git', 'curl', 'jq', 'rg', 'sqlite3', 'docker'];

let toolsHere: { found: string[]; missing: string[] } | undefined;

/** Looked up once: a task on This server cannot install them as a sandbox would. */
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
