import type { Machine, TreeEntry } from '../../core/ports.ts';
import { quote, run } from '../../core/shell.ts';
import { getProviders } from '../../providers/index.ts';
import { repoDir } from './git.ts';

/** A machine the agent used has no git credentials, so a lazy fetch would fail; these make a missing object an error at once. */
export const OFFLINE_GIT = { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'none', GIT_TERMINAL_PROMPT: '0' };

/** Past this a fresh task is the better way in. */
const MAX_BLOBS = 2000;
const BATCH_BYTES = 8 * 1024 * 1024;
const FETCHES_AT_ONCE = 8;

const SHA = /^[0-9a-f]{40}$/;

/** Read without fetching anything. */
async function blobsIn(machine: Machine, refs: string[]): Promise<Set<string>> {
	const known = new Set<string>();
	for (const ref of refs) {
		const listed = await machine.exec(`git ls-tree -r --full-tree ${quote(ref)}`, { cwd: repoDir(machine), env: OFFLINE_GIT });
		if (listed.exitCode !== 0) continue;
		for (const line of new TextDecoder().decode(listed.stdout).split('\n')) {
			const [, type, sha] = line.split('\t')[0].split(' ');
			if (type === 'blob' && sha) known.add(sha);
		}
	}
	return known;
}

async function fetchBlobs(repo: string, shas: string[]): Promise<Map<string, Uint8Array>> {
	const { git } = getProviders();
	const blobs = new Map<string, Uint8Array>();
	let next = 0;
	const worker = async () => {
		while (next < shas.length) {
			const sha = shas[next++];
			blobs.set(sha, await git.blob(repo, sha));
		}
	};
	await Promise.all(Array.from({ length: Math.min(FETCHES_AT_ONCE, shas.length) }, worker));
	return blobs;
}

async function writeBlobs(machine: Machine, blobs: Map<string, Uint8Array>): Promise<void> {
	const entries = [...blobs];
	for (let start = 0; start < entries.length; ) {
		const batch: Array<[string, Uint8Array]> = [];
		for (let bytes = 0; start < entries.length && (batch.length === 0 || bytes < BATCH_BYTES); start += 1) {
			batch.push(entries[start]);
			bytes += entries[start][1].length;
		}
		const lines = batch.map(([, content]) => Buffer.from(content).toString('base64')).join('\n');
		const out = await run(machine, `while IFS= read -r line; do printf '%s' "$line" | base64 -d | git hash-object -w --stdin || exit 1; done`, {
			cwd: repoDir(machine),
			env: OFFLINE_GIT,
			stdin: new TextEncoder().encode(`${lines}\n`),
			timeoutMs: 5 * 60_000,
		});
		const written = out.split('\n').filter(Boolean);
		batch.forEach(([sha], index) => {
			if (written[index] !== sha) throw new Error(`A file came out as ${written[index] ?? 'nothing'} instead of ${sha}`);
		});
	}
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

async function writeTrees(machine: Machine, root: string, entries: TreeEntry[]): Promise<void> {
	const children = new Map<string, TreeEntry[]>([['', []]]);
	for (const entry of entries) {
		if (entry.type === 'tree') children.set(entry.path, children.get(entry.path) ?? []);
		const parent = parentOf(entry.path);
		const siblings = children.get(parent);
		if (siblings) siblings.push(entry);
		else children.set(parent, [entry]);
	}
	const expected = new Map(entries.filter((entry) => entry.type === 'tree').map((entry) => [entry.path, entry.sha]));
	expected.set('', root);
	const order = [...children.keys()].filter((path) => children.get(path)?.length).sort((a, b) => b.split('/').length - a.split('/').length || (b ? 1 : 0) - (a ? 1 : 0));
	// `git mktree --batch -z`: NUL after each entry, an empty record after each tree; one hash out per tree.
	const input = order
		.map((path) => `${(children.get(path) ?? []).map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${nameOf(entry.path)}\0`).join('')}\0`)
		.join('');
	const out = await run(machine, 'git mktree -z --missing --batch', { cwd: repoDir(machine), env: OFFLINE_GIT, stdin: new TextEncoder().encode(input) });
	const written = out.split('\n').filter(Boolean);
	order.forEach((path, index) => {
		if (written[index] !== expected.get(path)) throw new Error(`The folder ${path || '(root)'} came out as ${written[index] ?? 'nothing'} instead of ${expected.get(path)}`);
	});
}

export async function hasCommit(machine: Machine, sha: string): Promise<boolean> {
	if (!SHA.test(sha)) return false;
	return (await machine.exec(`git rev-parse -q --verify ${sha}^{commit}`, { cwd: repoDir(machine), env: OFFLINE_GIT })).exitCode === 0;
}

/**
 * Rebuilds the commit's files from the host's API with exact hashes; a commit the machine lacks gets a stand-in (a replace
 * ref), so merges, diffs and pushes use its real hash. Its history is not brought: the stand-in's parent is `parent`.
 */
export async function bringCommit(machine: Machine, repo: string, sha: string, parent: string, note: string): Promise<void> {
	const known = await hasCommit(machine, sha);
	if (!known && !(await hasCommit(machine, parent))) throw new Error(`The sandbox lacks commit ${parent.slice(0, 7)}, so ${sha.slice(0, 7)} cannot be brought in. Start a new task instead.`);
	const listing = await getProviders().git.treeEntries(repo, sha);
	// Files in checked-out trees are there; a partial clone may lack any other, even one in a commit it has.
	const present = await blobsIn(machine, [parent, 'HEAD']);
	const missing = [...new Set(listing.entries.filter((entry) => entry.type === 'blob' && !present.has(entry.sha)).map((entry) => entry.sha))];
	if (missing.length > MAX_BLOBS) throw new Error(`${missing.length} files differ from what the sandbox has, too many to bring in. Start a new task instead.`);
	await writeBlobs(machine, await fetchBlobs(repo, missing));
	if (known) return;
	await writeTrees(machine, listing.sha, listing.entries);
	const cwd = repoDir(machine);
	const people = { GIT_AUTHOR_NAME: 'Anton', GIT_AUTHOR_EMAIL: 'anton@users.noreply.github.com', GIT_COMMITTER_NAME: 'Anton', GIT_COMMITTER_EMAIL: 'anton@users.noreply.github.com' };
	const standIn = (
		await run(machine, `git -c commit.gpgsign=false commit-tree ${listing.sha} -p ${parent}`, { cwd, env: { ...OFFLINE_GIT, ...people }, stdin: new TextEncoder().encode(note) })
	).trim();
	await run(machine, `git update-ref refs/replace/${sha} ${standIn}`, { cwd, env: OFFLINE_GIT });
	const tree = (await run(machine, `git rev-parse ${sha}^{tree}`, { cwd, env: OFFLINE_GIT })).trim();
	if (tree !== listing.sha) throw new Error(`Commit ${sha.slice(0, 7)} reads as tree ${tree.slice(0, 7)} instead of ${listing.sha.slice(0, 7)}`);
}
