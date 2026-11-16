import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/*
 * Values saved in Settings › Connections, kept in `<data dir>/anton.env` under
 * the environment variable each one replaces, and read over the environment
 * when Anton starts. A saved value wins; removing it gives the environment's
 * back. The file is only readable by Anton's own user, as the sealing key is.
 *
 * It is read before anything else (the database URL is in it), so it is a
 * plain file and not a row in the database. Values that are used as they are
 * read (`applyNow`) change the running process at once; the rest, such as
 * which sandbox provider to use, wait for the next start (`bootValue` is
 * what this process runs with).
 */

const FILE = 'anton.env';
/** One line per value: NAME="json string". */
const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

let file: string | undefined;
let saved: Record<string, string> = {};
/** What the environment itself held for each saved name, before the file was laid over it. */
const fromEnvironment = new Map<string, string | undefined>();
/** Each name's value as this process started with it, after the file. */
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

/** Reads the file and lays its values over `process.env`. Called once, by `config.ts`, before any setting is read. */
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

/** The value the environment gives a name, whatever is saved over it. */
export function environmentValue(name: string): string {
	return (fromEnvironment.has(name) ? fromEnvironment.get(name) : process.env[name])?.trim() ?? '';
}

/** The value saved for a name in Settings, or undefined when none is. An empty string is saved too: it turns the environment's off. */
export function savedValue(name: string): string | undefined {
	return saved[name];
}

/** A name's value as this process started with it, whatever has been saved since for the next start. */
export function bootValue(name: string): string {
	return (atBoot.has(name) ? atBoot.get(name) : process.env[name])?.trim() ?? '';
}

/**
 * Saves values (null removes one, giving the environment's back) and writes the file whole, only readable by
 * this user. Names in `applyNow` change `process.env` at once; the others are kept for the next start.
 */
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

/** For tests: forget everything loaded, so the next load starts clean. */
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
