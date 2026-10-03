import type { CommitData, CommitSource, GitHost, Machine, Signature, TreeChange } from '../core/ports.ts';
import { quote, run } from '../core/shell.ts';

/** `mode` is git's file mode in the working tree: 100755 for executables, 120000 for symlinks. */
export type FileChange = { path: string; status: 'A' | 'M' | 'D'; mode?: string };
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
		run(machine, withScratchIndex(`git diff --cached --no-renames --raw -z ${baseSha}`), { cwd }),
		run(machine, withScratchIndex(`git diff --cached --no-renames --binary ${baseSha}`), { cwd }),
		run(machine, `git log --format='%H%x09%s%x09%cI' ${baseSha}..HEAD`, { cwd }),
	]);
	return { patch, files: parseRaw(names), log: parseLog(log) };
}

/** Tracked files plus new ones that are not ignored. */
export async function listFiles(machine: Machine): Promise<string[]> {
	const out = await run(machine, 'git ls-files -co --exclude-standard', { cwd: repoDir(machine) });
	return out.split('\n').filter(Boolean);
}

/** Commits everything and sends the branch to the host; returns false when there was nothing to push. */
export async function commitAndPush(machine: Machine, host: GitHost, input: { repo: string; branch: string; baseSha: string; message: string }): Promise<boolean> {
	const cwd = repoDir(machine);
	// Unsigned, as a signature the host cannot reproduce would change the commit's hash.
	await run(machine, `git add -A && (git diff --cached --quiet || git -c commit.gpgsign=false commit -q -m ${quote(input.message)})`, { cwd });
	const ahead = Number((await run(machine, `git rev-list --count ${input.baseSha}..HEAD`, { cwd })).trim());
	if (ahead === 0) return false;
	const head = (await run(machine, 'git rev-parse HEAD', { cwd })).trim();
	const commits = await unpushedCommits(machine, input.baseSha, await host.branchHead(input.repo, input.branch));
	await host.pushCommits({ repo: input.repo, branch: input.branch, head, commits, source: commitSource(machine) });
	return true;
}

const SHA = /^[0-9a-f]{40}$/;

/** Commits on HEAD the host may lack, oldest first: past the base, and past the host's branch when this machine has it. */
export async function unpushedCommits(machine: Machine, baseSha: string, remoteHead: string | null): Promise<string[]> {
	const cwd = repoDir(machine);
	const known = remoteHead !== null && SHA.test(remoteHead) && (await machine.exec(`git cat-file -e ${remoteHead}^{commit}`, { cwd })).exitCode === 0;
	const out = await run(machine, `git rev-list --reverse --topo-order HEAD ^${baseSha}${known ? ` ^${remoteHead}` : ''}`, { cwd });
	return out.split('\n').filter(Boolean);
}

/** git's empty tree, the parent of a commit that has none. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Reads commits and contents from the machine's repo, for the host to recreate. */
export function commitSource(machine: Machine): CommitSource {
	const cwd = repoDir(machine);
	return {
		async commit(sha) {
			const raw = parseCommit(sha, await run(machine, `git cat-file commit ${sha}`, { cwd }));
			const parent = raw.parents[0];
			const [changes, parentTree] = await Promise.all([
				run(machine, `git diff-tree -r -z --raw --no-renames --no-commit-id ${parent ?? EMPTY_TREE} ${sha}`, { cwd }),
				parent ? run(machine, `git rev-parse ${parent}^{tree}`, { cwd }) : null,
			]);
			return { ...raw, sha, parentTree: parentTree?.trim() ?? null, changes: parseTreeChanges(changes) };
		},
		async blob(sha) {
			const result = await machine.exec(`git cat-file blob ${sha}`, { cwd });
			if (result.exitCode !== 0) throw new Error(`Could not read ${sha} from the repo: ${result.stderr.trim()}`);
			return result.stdout;
		},
	};
}

/** `Name <email> 1790988601 +0530` as the host's signature, keeping the offset. */
function parseSignature(line: string): Signature {
	const match = /^(.*) <(.*)> (\d+) ([+-])(\d{2})(\d{2})$/.exec(line);
	if (!match) throw new Error(`Unreadable commit signature: ${line}`);
	const [, name, email, seconds, sign, hours, minutes] = match;
	const offset = (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
	const local = new Date((Number(seconds) + offset * 60) * 1000).toISOString().slice(0, 19);
	return { name, email, date: `${local}${sign}${hours}:${minutes}` };
}

/**
 * Splits a raw commit into its headers and message. A signature or any other
 * header would be lost on the host, giving the commit a new hash, so those
 * commits are refused rather than pushed changed.
 */
export function parseCommit(sha: string, raw: string): Pick<CommitData, 'tree' | 'parents' | 'author' | 'committer' | 'message'> {
	const split = raw.indexOf('\n\n');
	const headers = (split === -1 ? raw : raw.slice(0, split)).split('\n');
	const message = split === -1 ? '' : raw.slice(split + 2);
	const value = (name: string) => headers.filter((line) => line.startsWith(`${name} `)).map((line) => line.slice(name.length + 1));
	const other = headers.find((line) => !/^(tree|parent|author|committer) /.test(line));
	if (other !== undefined) throw new Error(`Commit ${sha.slice(0, 7)} has a "${other.split(' ')[0]}" header (a signature?), so it can't be pushed unchanged. Recreate it without one.`);
	const [tree] = value('tree');
	const [author] = value('author');
	const [committer] = value('committer');
	if (!tree || !author || !committer) throw new Error(`Commit ${sha.slice(0, 7)} is incomplete`);
	return { tree, parents: value('parent'), author: parseSignature(author), committer: parseSignature(committer), message };
}

/** Parses `git diff-tree --raw -z`, keeping each path's new mode and contents, or its old mode when removed. */
export function parseTreeChanges(out: string): TreeChange[] {
	const fields = out.split('\0');
	const changes: TreeChange[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const [oldMode, newMode, , newSha, status] = fields[index].slice(1).split(' ');
		const path = fields[index + 1];
		if (!status || !path) continue;
		changes.push(status === 'D' ? { path, mode: oldMode, sha: null } : { path, mode: newMode, sha: newSha });
	}
	return changes;
}

/**
 * Parses `git diff --raw -z`: a `:oldmode newmode oldsha newsha status` field
 * then the path, NUL-separated, so any file name comes through as is.
 */
export function parseRaw(out: string): FileChange[] {
	const fields = out.split('\0');
	const changes: FileChange[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const [, mode, , , status] = fields[index].split(' ');
		const path = fields[index + 1];
		if (!status || !path) continue;
		const kind = (status[0] === 'A' || status[0] === 'D' ? status[0] : 'M') as FileChange['status'];
		changes.push(kind === 'D' ? { path, status: kind } : { path, status: kind, mode });
	}
	return changes;
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
