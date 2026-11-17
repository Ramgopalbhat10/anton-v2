import type { CommitData, CommitSource, GitHost, Machine, Signature, TreeChange } from '../../core/ports.ts';
import { quote, run } from '../../core/shell.ts';

/** `mode` is git's file mode: 100755 for executables, 120000 for symlinks. */
export type FileChange = { path: string; status: 'A' | 'M' | 'D'; mode?: string };
export type LogEntry = { sha: string; subject: string; at: string; pushed?: boolean };
export type Changes = { patch: string; files: FileChange[]; log: LogEntry[] };

export const repoDir = (machine: Machine) => `${machine.root}/repo`;

const AUTHOR = ['user.name "Anton"', 'user.email "anton@users.noreply.github.com"'];

/** A throwaway index, so diffs include new files without touching the index the agent sees. */
const withScratchIndex = (command: string) =>
	`export GIT_INDEX_FILE="$(mktemp)"; cp .git/index "$GIT_INDEX_FILE" 2>/dev/null; git add -A >/dev/null 2>&1; ${command}; status=$?; rm -f "$GIT_INDEX_FILE"; exit $status`;

/** A machine on this server reads the user's own git config, whose diff.mnemonicPrefix, diff.noprefix or colors would break the `a/` and `b/` paths patches are read and applied by. */
const PATCH = 'git diff --cached --no-renames --binary --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/';

/** A chat's sandbox is an empty folder under git, so its changes and checkpoints work as a repo's. The first commit is empty and dated the epoch, so every chat's is the same. */
export const SCRATCH_BRANCH = 'scratch';
export const SCRATCH_BASE = '5dbaf08032448172a03f0a1292bf74bcd21a8898';
const SCRATCH_DATE = '1970-01-01T00:00:00Z';

/** A scratch folder has no .gitignore, so without these an `npm install` puts hundreds of files in Changes and its checkpoints. */
const SCRATCH_IGNORES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc', '.pytest_cache/', '.mypy_cache/', '.next/', '.turbo/', '.parcel-cache/', '.cache/', '.npm/', '.DS_Store'];

/** Chats begun before it get it at their next look at Changes. */
const IGNORE_IN_SCRATCH = `mkdir -p .git/info && { grep -qxF 'node_modules/' .git/info/exclude 2>/dev/null || printf '%s\\n' ${SCRATCH_IGNORES.map(quote).join(' ')} >> .git/info/exclude; }`;

export async function initScratch(machine: Machine): Promise<void> {
	await run(machine, `rm -rf repo && mkdir repo && git -C repo init -q -b ${SCRATCH_BRANCH}`, { cwd: machine.root });
	await run(machine, AUTHOR.map((setting) => `git config ${setting}`).join(' && '), { cwd: repoDir(machine) });
	await run(machine, IGNORE_IN_SCRATCH, { cwd: repoDir(machine) });
	await run(machine, "git -c commit.gpgsign=false commit -q --allow-empty -m 'Scratch folder'", {
		cwd: repoDir(machine),
		env: { GIT_AUTHOR_DATE: SCRATCH_DATE, GIT_COMMITTER_DATE: SCRATCH_DATE },
	});
}

export async function cloneRepo(machine: Machine, url: string, auth: Record<string, string>): Promise<void> {
	await run(machine, `rm -rf repo && git clone --filter=blob:none ${quote(url)} repo`, { cwd: machine.root, env: auth });
	await run(machine, AUTHOR.map((setting) => `git config ${setting}`).join(' && '), { cwd: repoDir(machine) });
}

/** One command, as each is a round trip to the sandbox; the fetch happens only when the image lacks the commit. */
export async function checkoutTaskBranch(machine: Machine, branch: string, sha: string, auth: Record<string, string>): Promise<void> {
	const fetch = `git cat-file -e ${quote(`${sha}^{commit}`)} 2>/dev/null || git fetch --filter=blob:none origin ${quote(sha)}`;
	// The credentials are for the fetch alone: they are gone before checkout runs the repo's filters.
	const forget = Object.keys(auth).length ? `unset ${Object.keys(auth).join(' ')}; ` : '';
	await run(machine, `(${fetch}) && { ${forget}git checkout -f -B ${quote(branch)} ${quote(sha)} && git clean -fd; }`, { cwd: repoDir(machine), env: auth });
}

/** With `since` (the last commit pushed) the diff starts there, so it holds only work the host lacks. */
export async function changes(machine: Machine, baseSha: string, since: string | null = null): Promise<Changes> {
	const cwd = repoDir(machine);
	if (baseSha === SCRATCH_BASE) await run(machine, IGNORE_IN_SCRATCH, { cwd });
	const from = since ?? baseSha;
	const [names, patch, log, pushed] = await Promise.all([
		run(machine, withScratchIndex(`git diff --cached --no-renames --raw -z ${from}`), { cwd }),
		run(machine, withScratchIndex(`${PATCH} ${from}`), { cwd }),
		run(machine, `git log --format='%H%x09%s%x09%cI' ${baseSha}..HEAD`, { cwd }),
		since ? run(machine, `git rev-list ${baseSha}..${since}`, { cwd }) : null,
	]);
	const host = pushed === null ? null : new Set(pushed.split('\n').filter(Boolean));
	return { patch, files: parseRaw(names), log: parseLog(log).map((entry) => (host ? { ...entry, pushed: host.has(entry.sha) } : entry)) };
}

export const workingPatchCommand = (from: string) => `(${withScratchIndex(`${PATCH} ${from}`)})`;

/** So a build's untracked output never comes back whole. */
const MAX_OTHER_PATCH = 200_000;

/** Each repository it cloned or found is diffed from its last commit before `since`, under its own path; the agent's index is untouched. */
export async function otherRepoChanges(machine: Machine, since: Date, under = '/'): Promise<string> {
	const epoch = Math.floor(since.getTime() / 1000);
	const git = `git -c safe.directory='*'`;
	const script = [
		`for g in $(find ${quote(under)} -xdev -maxdepth 4 \\( -path /proc -o -path /sys -o -path /dev -o -name node_modules \\) -prune -o -name .git -type d -print 2>/dev/null); do`,
		'd="${g%/.git}"',
		`[ "$d" = ${quote(repoDir(machine))} ] && continue`,
		`if ${git} -C "$d" rev-parse -q --verify HEAD >/dev/null 2>&1; then base=$(${git} -C "$d" rev-list -1 --before=@${epoch} HEAD 2>/dev/null); else base=; fi`,
		`(cd "$d" && export GIT_INDEX_FILE="$(mktemp)"; cp .git/index "$GIT_INDEX_FILE" 2>/dev/null; ${git} add -A >/dev/null 2>&1; ${git} diff --cached --no-renames --binary --no-color --no-ext-diff --no-textconv --src-prefix="a$d/" --dst-prefix="b$d/" "\${base:-${EMPTY_TREE}}"; rm -f "$GIT_INDEX_FILE")`,
		`done | head -c ${MAX_OTHER_PATCH}; true`,
	].join('\n');
	return run(machine, script, { cwd: machine.root, timeoutMs: 60_000 });
}

export async function listFiles(machine: Machine): Promise<string[]> {
	const out = await run(machine, 'git ls-files -co --exclude-standard', { cwd: repoDir(machine) });
	return out.split('\n').filter(Boolean);
}

export async function commitAndPush(machine: Machine, host: GitHost, input: { repo: string; branch: string; baseSha: string; message: string }): Promise<string | null> {
	const cwd = repoDir(machine);
	// Unsigned, as a signature the host cannot reproduce would change the commit's hash.
	await run(machine, `git add -A && (git diff --cached --quiet || git -c commit.gpgsign=false commit -q -m ${quote(input.message)})`, { cwd });
	const ahead = Number((await run(machine, `git rev-list --count ${input.baseSha}..HEAD`, { cwd })).trim());
	if (ahead === 0) return null;
	const head = (await run(machine, 'git rev-parse HEAD', { cwd })).trim();
	const commits = await unpushedCommits(machine, input.baseSha, await host.branchHead(input.repo, input.branch));
	await host.pushCommits({ repo: input.repo, branch: input.branch, head, commits, source: commitSource(machine) });
	return head;
}

const SHA = /^[0-9a-f]{40}$/;

export async function unpushedCommits(machine: Machine, baseSha: string, remoteHead: string | null): Promise<string[]> {
	const cwd = repoDir(machine);
	const known = remoteHead !== null && SHA.test(remoteHead) && (await machine.exec(`git cat-file -e ${remoteHead}^{commit}`, { cwd })).exitCode === 0;
	const out = await run(machine, `git rev-list --reverse --topo-order HEAD ^${baseSha}${known ? ` ^${remoteHead}` : ''}`, { cwd });
	return out.split('\n').filter(Boolean);
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

function parseSignature(line: string): Signature {
	const match = /^(.*) <(.*)> (\d+) ([+-])(\d{2})(\d{2})$/.exec(line);
	if (!match) throw new Error(`Unreadable commit signature: ${line}`);
	const [, name, email, seconds, sign, hours, minutes] = match;
	const offset = (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
	const local = new Date((Number(seconds) + offset * 60) * 1000).toISOString().slice(0, 19);
	return { name, email, date: `${local}${sign}${hours}:${minutes}` };
}

/** A signature or any other header would be lost on the host and change the hash, so those commits are refused. */
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
