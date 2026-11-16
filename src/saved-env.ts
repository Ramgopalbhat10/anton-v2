import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Values saved in Settings › Connections, kept in `<data dir>/anton.env` and laid over the environment at start.
// A plain file, not a database row: it is read before anything else (the database URL is in it). Only Anton's user can read it.

const FILE = 'anton.env';
/** One line per value: NAME="json string". */
const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

let file: string | undefined;
let saved: Record<string, string> = {};
const fromEnvironment = new Map<string, string | undefined>();
const atBoot = new Map<string, string | undefined>();

function parse(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const raw of text.split('\n')) {
		const match = LINE.exec(raw.trim());
		if (!match) continue;
		try {
			const value = JSON.parse(match[2]);
			if (typeof value === 'string') values[match[1]] = value;
		} catch {
			// A line this Anton did not write is skipped, not guessed at.
		}
	}
	return values;
}

/** Called once, by `config.ts`, before any setting is read. */
export function loadSavedEnv(dataDir: string): void {
	file = path.join(dataDir, FILE);
	try {
		saved = parse(readFileSync(file, 'utf8'));
	} catch {
		saved = {};
	}
	for (const [name, value] of Object.entries(saved)) {
		fromEnvironment.set(name, process.env[name]);
		process.env[name] = value;
	}
}

export function environmentValue(name: string): string {
	return (fromEnvironment.has(name) ? fromEnvironment.get(name) : process.env[name])?.trim() ?? '';
}

/** An empty string is saved too: it turns the environment's value off. */
export function savedValue(name: string): string | undefined {
	return saved[name];
}

export function bootValue(name: string): string {
	return (atBoot.has(name) ? atBoot.get(name) : process.env[name])?.trim() ?? '';
}

/** Writes the file whole. Names in `applyNow` change `process.env` at once; the others wait for the next start. */
export function writeSavedEnv(changes: Record<string, string | null>, applyNow: boolean): void {
	if (!file) throw new Error('The saved settings file was never loaded');
	for (const name of Object.keys(changes)) {
		// What this process started with is remembered before the first change, so a restart-only value shows as pending.
		if (!atBoot.has(name)) atBoot.set(name, process.env[name]);
		if (!fromEnvironment.has(name)) fromEnvironment.set(name, name in saved ? undefined : process.env[name]);
	}
	const next = { ...saved };
	for (const [name, value] of Object.entries(changes)) {
		if (value === null) delete next[name];
		else next[name] = value;
	}
	const text = Object.entries(next)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}=${JSON.stringify(value)}`)
		.join('\n');
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, text ? `${text}\n` : '', { mode: 0o600 });
	renameSync(temp, file);
	saved = next;
	if (!applyNow) return;
	for (const [name, value] of Object.entries(changes)) {
		if (value === null) {
			const original = fromEnvironment.get(name);
			if (original === undefined) delete process.env[name];
			else process.env[name] = original;
		} else process.env[name] = value;
		atBoot.set(name, process.env[name]);
	}
}

export function resetSavedEnv(): void {
	for (const [name, value] of fromEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	file = undefined;
	saved = {};
	fromEnvironment.clear();
	atBoot.clear();
}
