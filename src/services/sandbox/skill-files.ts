import { createHash } from 'node:crypto';
import type { Machine } from '../../core/ports.ts';
import { CommandError, quote, text } from '../../core/shell.ts';
import type { MountedSkill } from '../settings/plugins.ts';

/** Beside the working folder, so outside the repository and its pull request. */
export const skillsDir = (machine: Machine) => `${machine.root}/skills`;

const MARKER = '.anton-skills';

/** The largest copy takes a few seconds; short enough not to hold a reply. */
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

/** Bash reads a script piped to `bash -s` one byte at a time (minutes for a few MB), so the script is saved to a file and run. A stuck copy is given up; skills stay readable through Anton. */
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

const copies = new Map<string, Promise<void>>();

/** Does not hold the sandbox start: a few MB of skills take tens of seconds and most tasks never use them. */
export function copySkillFilesSoon(id: string, machine: Machine, skills: MountedSkill[], onError: (error: unknown) => void): void {
	const copy = copySkillFiles(machine, skills).catch(onError);
	copies.set(id, copy);
	void copy.finally(() => {
		if (copies.get(id) === copy) copies.delete(id);
	});
}

export function skillFilesReady(id: string): Promise<void> {
	return copies.get(id) ?? Promise.resolve();
}
