import { defineTool, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { MAX_TODO_REPOS } from '../../../core/space-todos.ts';
import { setThreadRepos } from '../../../services/projects/thread-repos.ts';
import { startTodoThreadsIn } from '../../../services/projects/todos.ts';

/** For a thread in a project: the repository it works in, once the user picked or confirmed it. */
export function useSetRepo(id: string) {
	useTool(
		defineTool({
			name: 'set_repo',
			description:
				"Choose which of the project's repositories this thread works in, after the user picked or confirmed it. The first is this thread's: it moves there when this reply ends (only while it has changed and pushed nothing where it is), and Anton then tells you to carry on there. " +
				'Each further one gets a thread of its own for the same to-do. Naming the repository this thread already works in first only starts those others.',
			input: v.object({
				repos: v.pipe(
					v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
					v.minLength(1),
					v.maxLength(MAX_TODO_REPOS),
					v.description("The project's repositories, as owner/name or name, this thread's first"),
				),
			}),
			async run({ data }) {
				const result = await setThreadRepos(id, data.repos, async (todoId, repos, from) => (await startTodoThreadsIn(todoId, repos, from, id)).map(({ id: threadId, title }) => ({ id: threadId, title })));
				return result.moving ? { output: result.output, terminate: true } : { output: result.output };
			},
		}),
	);
}
