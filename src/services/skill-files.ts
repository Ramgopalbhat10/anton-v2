import { createHash } from 'node:crypto';
import type { Machine } from '../core/ports.ts';
import { CommandError, quote, text } from '../core/shell.ts';
import type { MountedSkill } from './plugins.ts';

/**
 * Where a sandbox keeps a copy of the installed skills' files, beside the
 * working folder and so outside the repository and its pull request.
 */
export const skillsDir = (machine: Machine) => `${machine.root}/skills`;

/** The copy's fingerprint, kept in the folder so an unchanged copy is not written again. */
const MARKER = '.anton-skills';

/** Long enough for the largest copy, which takes a few seconds; short enough not to hold a reply. */
const COPY_MS = 60_000;

const fingerprint = (skills: MountedSkill[]) => {
	const hash = createHash('sha256');
	for (const skill of skills)
		for (const [path, content] of Object.entries(skill.files)) {
			hash.update(`${skill.name}\0${path}\0`);
			hash.update(content);
			hash.update('\0');
		}
	return hash.digest('hex').slice(0, 32);
};

/**
 * Copies each installed skill's files to `skills/<name>/` in the sandbox,
 * where the agent's shell can run its scripts and import its kits. The
 * `read_skill_resource` tool only reaches them through Anton, never from a
 * command. One script writes them all, each file as base64 in a heredoc.
 * Bash reads a script piped to `bash -s` one byte at a time, which for a few
 * MB of skills held a reply's sandbox start for minutes, so the script is
 * saved to a file first and run from there. A copy still stuck after
 * `COPY_MS` is given up: the skills stay readable through Anton.
 */
export async function copySkillFiles(machine: Machine, skills: MountedSkill[]): Promise<void> {
	const withFiles = skills.filter((skill) => Object.keys(skill.files).length > 0);
	if (withFiles.length === 0) return;
	const root = skillsDir(machine);
	const mark = fingerprint(withFiles);
	const current = await machine.exec(`cat ${quote(`${root}/${MARKER}`)} 2>/dev/null`);
	if (text(current.stdout).trim() === mark) return;
	// Written beside the folder and moved into place at the end, so a command never sees half a copy.
	const next = `${root}.next`;
	const lines = ['set -e', `rm -rf ${quote(next)}`];
	for (const skill of withFiles)
		for (const [path, content] of Object.entries(skill.files)) {
			const target = `${next}/${skill.name}/${path}`;
			const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
			lines.push(`mkdir -p ${quote(target.slice(0, target.lastIndexOf('/')))}`, `base64 -d > ${quote(target)} <<'ANTON_SKILL_FILE'`, ...(bytes.toString('base64').match(/.{1,76}/g) ?? []), 'ANTON_SKILL_FILE');
		}
	lines.push(`mkdir -p ${quote(next)}`, `printf %s ${quote(mark)} > ${quote(`${next}/${MARKER}`)}`, `rm -rf ${quote(root)}`, `mv ${quote(next)} ${quote(root)}`, '');
	const script = `${root}.sh`;
	const result = await machine.exec(`cat > ${quote(script)} && bash ${quote(script)}; status=$?; rm -f ${quote(script)}; exit $status`, {
		stdin: new TextEncoder().encode(lines.join('\n')),
		timeoutMs: COPY_MS,
	});
	if (result.exitCode !== 0) throw new CommandError('copy the skills into the sandbox', result);
}

/** Each task's copy in flight, so a skill being activated can wait for its files. */
const copies = new Map<string, Promise<void>>();

/**
 * Starts the copy without holding the sandbox start: a few MB of skills take tens of seconds, and
 * most tasks never use a skill's files. `skillFilesReady` waits for it when a skill is activated.
 */
export function copySkillFilesSoon(id: string, machine: Machine, skills: MountedSkill[], onError: (error: unknown) => void): void {
	const copy = copySkillFiles(machine, skills).catch(onError);
	copies.set(id, copy);
	void copy.finally(() => {
		if (copies.get(id) === copy) copies.delete(id);
	});
}

/** Resolves once the task's copy, if one is running, is done or given up. */
export function skillFilesReady(id: string): Promise<void> {
	return copies.get(id) ?? Promise.resolve();
}
