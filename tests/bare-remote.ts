import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { PushInput } from '../src/core/ports.ts';

/**
 * Receives a push the way GitHub's API does: every commit is rebuilt in a
 * bare repo from its contents, and must come out with the same hash.
 */
export function bareRemote(remote: string) {
	const git = (args: string[], options: { input?: Uint8Array | string; env?: Record<string, string> } = {}) =>
		execFileSync('git', args, { cwd: remote, input: options.input, env: { ...process.env, ...options.env } }).toString().trim();
	const has = (sha: string) => {
		try {
			git(['cat-file', '-e', `${sha}^{commit}`]);
			return true;
		} catch {
			return false;
		}
	};
	/** Every commit the remote was sent, to check what a push carried. */
	const received: string[] = [];

	return {
		received,
		async branchHead(_repo: string, branch: string): Promise<string | null> {
			try {
				return git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
			} catch {
				return null;
			}
		},
		async pushCommits({ branch, head, commits, source }: PushInput): Promise<void> {
			for (const sha of commits) {
				if (has(sha)) continue;
				const commit = await source.commit(sha);
				const index = { GIT_INDEX_FILE: path.join(remote, `push-${sha}.index`) };
				git(commit.parentTree ? ['read-tree', commit.parentTree] : ['read-tree', '--empty'], { env: index });
				const records: string[] = [];
				for (const change of commit.changes) {
					if (change.sha !== null && change.mode !== '160000') git(['hash-object', '-w', '--stdin'], { input: await source.blob(change.sha) });
					// A zero mode removes the path.
					records.push(change.sha === null ? `0 ${'0'.repeat(40)}\t${change.path}` : `${change.mode} ${change.sha}\t${change.path}`);
				}
				if (records.length) git(['update-index', '-z', '--index-info'], { input: `${records.join('\0')}\0`, env: index });
				const tree = git(['write-tree'], { env: index });
				rmSync(index.GIT_INDEX_FILE, { force: true });
				if (tree !== commit.tree) throw new Error(`tree ${tree} is not ${commit.tree}`);
				const people = {
					GIT_AUTHOR_NAME: commit.author.name,
					GIT_AUTHOR_EMAIL: commit.author.email,
					GIT_AUTHOR_DATE: commit.author.date,
					GIT_COMMITTER_NAME: commit.committer.name,
					GIT_COMMITTER_EMAIL: commit.committer.email,
					GIT_COMMITTER_DATE: commit.committer.date,
				};
				const parents = commit.parents.flatMap((parent) => ['-p', parent]);
				const created = git(['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...parents], { input: commit.message, env: people });
				if (created !== sha) throw new Error(`commit ${sha} came out as ${created}`);
				received.push(sha);
			}
			git(['update-ref', `refs/heads/${branch}`, head]);
		},
	};
}
