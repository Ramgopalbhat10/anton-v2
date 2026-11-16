import { defineTool, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { listRepoFiles, readRepoFile, searchRepo } from '../../../services/sandbox/repo-snapshot.ts';

/**
 * A chat's and a plan's or review's tools before its sandbox, answering from the repo at the task's base commit,
 * with no sandbox, clone or branch; given `repo`, from any GitHub repository instead, which is how a chat reads code
 * at all. A repository task's read, grep and glob (`useTaskWorkspace`) read the same snapshot until it has its workspace.
 */
export function useRepoSnapshot(id: string, chat: boolean) {
	const repo = v.optional(
		v.pipe(
			v.string(),
			v.description(
				chat
					? 'The GitHub repository to read, as owner/name, optionally @branch, tag or commit (its default branch otherwise)'
					: "Another GitHub repository to read instead of this task's, as owner/name, optionally @branch, tag or commit",
			),
		),
	);
	const filter = {
		path: v.optional(v.pipe(v.string(), v.description('Only under this folder, relative to the repo root'))),
		glob: v.optional(v.pipe(v.string(), v.description('Only paths matching this glob, such as **/*.ts or package.json'))),
		repo,
	};
	useTool(
		defineTool({
			name: 'list_files',
			description: 'List file paths in the repository, optionally under a folder or matching a glob.',
			input: v.object(filter),
			run: async ({ data }) => ({ output: await listRepoFiles(id, data) }),
		}),
	);
	useTool(
		defineTool({
			name: 'read_file',
			description: 'Read a file of the repository with line numbers. Long files come in pages; pass offset to read on.',
			input: v.object({
				path: v.pipe(v.string(), v.minLength(1), v.description('Path relative to the repo root')),
				offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.description('First line to show'))),
				limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2000))),
				repo,
			}),
			run: async ({ data }) => ({ output: await readRepoFile(id, data.path, data.offset, data.limit, data.repo) }),
		}),
	);
	useTool(
		defineTool({
			name: 'search_code',
			description: 'Search file contents with a regular expression. Returns path:line: text for each match.',
			input: v.object({
				pattern: v.pipe(v.string(), v.minLength(1), v.description('JavaScript regular expression')),
				ignoreCase: v.optional(v.boolean()),
				...filter,
			}),
			run: async ({ data }) => ({ output: await searchRepo(id, data) }),
		}),
	);
}
