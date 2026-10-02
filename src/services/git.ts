import type { Machine } from '../core/ports.ts';
import { quote, run } from '../core/shell.ts';

export type FileChange = { path: string; status: 'A' | 'M' | 'D' };
export type LogEntry = { sha: string; subject: string; at: string };
export type Changes = { patch: string; files: FileChange[]; log: LogEntry[] };

export const repoDir = (machine: Machine) => `${machine.root}/repo`;

const AUTHOR = ['user.name "Anton"', 'user.email "anton@users.noreply.github.com"'];

/**
 * Stages the whole working tree into a throwaway index, so diffs include
 * new files without touching the index the agent sees.
 */
const withScratchIndex = (command: string) =>
	`export GIT_INDEX_FILE="$(mktemp)"; cp .git/index "$GIT_INDEX_FILE" 2>/dev/null; git add -A >/dev/null 2>&1; ${command}; status=$?; rm -f "$GIT_INDEX_FILE"; exit $status`;

export async function cloneRepo(machine: Machine, url: string, auth: Record<string, string>): Promise<void> {
	await run(machine, `rm -rf repo && git clone --filter=blob:none ${quote(url)} repo`, { cwd: machine.root, env: auth });
	await run(machine, AUTHOR.map((setting) => `git config ${setting}`).join(' && '), { cwd: repoDir(machine) });
}

/** Puts the repo on a fresh task branch at `sha`, discarding anything left in the image. */
export async function checkoutTaskBranch(machine: Machine, branch: string, sha: string, auth: Record<string, string>): Promise<void> {
	const cwd = repoDir(machine);
	await run(machine, `git cat-file -e ${sha}^{commit} 2>/dev/null || git fetch --filter=blob:none origin ${sha}`, { cwd, env: auth });
	await run(machine, `git checkout -f -B ${quote(branch)} ${sha} && git clean -fd`, { cwd });
}

export async function changes(machine: Machine, baseSha: string): Promise<Changes> {
	const cwd = repoDir(machine);
	const [names, patch, log] = await Promise.all([
		run(machine, withScratchIndex(`git diff --cached --no-renames --name-status ${baseSha}`), { cwd }),
		run(machine, withScratchIndex(`git diff --cached --no-renames --binary ${baseSha}`), { cwd }),
		run(machine, `git log --format='%H%x09%s%x09%cI' ${baseSha}..HEAD`, { cwd }),
	]);
	return { patch, files: parseNameStatus(names), log: parseLog(log) };
}

/** Tracked files plus new ones that are not ignored. */
export async function listFiles(machine: Machine): Promise<string[]> {
	const out = await run(machine, 'git ls-files -co --exclude-standard', { cwd: repoDir(machine) });
	return out.split('\n').filter(Boolean);
}

/** Commits everything and pushes the branch; returns false when there was nothing to push. */
export async function commitAndPush(
	machine: Machine,
	input: { branch: string; baseSha: string; message: string; auth: Record<string, string> },
): Promise<boolean> {
	const cwd = repoDir(machine);
	await run(machine, `git add -A && (git diff --cached --quiet || git commit -q -m ${quote(input.message)})`, { cwd });
	const ahead = Number((await run(machine, `git rev-list --count ${input.baseSha}..HEAD`, { cwd })).trim());
	if (ahead === 0) return false;
	await run(machine, `git push -q -f origin HEAD:refs/heads/${quote(input.branch)}`, { cwd, env: input.auth });
	return true;
}

export function parseNameStatus(out: string): FileChange[] {
	return out
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [status, path] = line.split('\t');
			return { path, status: (status[0] === 'A' || status[0] === 'D' ? status[0] : 'M') as FileChange['status'] };
		});
}

export function parseLog(out: string): LogEntry[] {
	return out
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [sha, subject, at] = line.split('\t');
			return { sha, subject, at };
		});
}
