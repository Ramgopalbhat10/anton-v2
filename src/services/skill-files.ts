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
	const lines = ['set -e', `rm -rf ${quote(root)}`];
	for (const skill of withFiles)
		for (const [path, content] of Object.entries(skill.files)) {
			const target = `${root}/${skill.name}/${path}`;
			const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
			lines.push(`mkdir -p ${quote(target.slice(0, target.lastIndexOf('/')))}`, `base64 -d > ${quote(target)} <<'ANTON_SKILL_FILE'`, ...(bytes.toString('base64').match(/.{1,76}/g) ?? []), 'ANTON_SKILL_FILE');
		}
	lines.push(`printf %s ${quote(mark)} > ${quote(`${root}/${MARKER}`)}`, '');
	const script = `${root}.sh`;
	const result = await machine.exec(`cat > ${quote(script)} && bash ${quote(script)}; status=$?; rm -f ${quote(script)}; exit $status`, {
		stdin: new TextEncoder().encode(lines.join('\n')),
		timeoutMs: COPY_MS,
	});
	if (result.exitCode !== 0) throw new CommandError('copy the skills into the sandbox', result);
}
