import { queryOptions } from '@tanstack/react-query';
import { api, refreshFor, type Source } from '@/lib/api';

/**
 * A task's queries, made here rather than inline in the components that read them.
 *
 * The query cache keeps the options of the last component that read a query, its
 * `queryFn` among them, for `gcTime` after the page is gone. An arrow written
 * inside a component shares that component's closure scope, so a cached query
 * kept the whole scope alive: the conversation's rows, refs and, through them,
 * the page's detached DOM. A function made here closes over the task's id alone.
 * Spread one into `useQuery` to add options: `useQuery({ ...taskQueries.files(id), staleTime })`.
 */
export const taskQueries = {
	session: (id: string) => queryOptions({ queryKey: ['session', id], queryFn: () => api.session(id) }),
	waiting: (id: string) => queryOptions({ queryKey: ['waiting', id], queryFn: () => api.waiting(id) }),
	joins: (id: string) => queryOptions({ queryKey: ['joins', id], queryFn: () => api.joins(id) }),
	files: (id: string) => queryOptions({ queryKey: ['files', id], queryFn: () => api.files(id) }),
	outputs: (id: string) => queryOptions({ queryKey: ['outputs', id], queryFn: () => api.outputs(id) }),
	now: (id: string) => queryOptions({ queryKey: ['now', id], queryFn: () => api.now(id) }),
	fallback: (id: string) => queryOptions({ queryKey: ['fallback', id], queryFn: () => api.fallbackModel(id) }),
	scripts: (id: string) => queryOptions({ queryKey: ['scripts', id], queryFn: () => api.scripts(id) }),
	todos: (id: string) => queryOptions({ queryKey: ['todos', id], queryFn: () => api.todos(id) }),
	subagents: (id: string) => queryOptions({ queryKey: ['subagents', id], queryFn: () => api.subagents(id) }),
	budget: (id: string) => queryOptions({ queryKey: ['budget', id], queryFn: () => api.budget(id) }),
	context: (id: string) => queryOptions({ queryKey: ['context', id], queryFn: () => api.context(id) }),
	checkpoints: (id: string) => queryOptions({ queryKey: ['checkpoints', id], queryFn: () => api.checkpoints(id) }),
	previews: (id: string) => queryOptions({ queryKey: ['previews', id], queryFn: () => api.previews(id) }),
	pulls: (id: string) => queryOptions({ queryKey: ['pulls', id], queryFn: () => api.pulls(id) }),
	computer: (id: string) => queryOptions({ queryKey: ['computer', id], queryFn: () => api.computer(id) }),
	browser: (id: string) => queryOptions({ queryKey: ['browser', id], queryFn: () => api.browser(id) }),
	toolApprovals: (id: string) => queryOptions({ queryKey: ['tool-approvals', id], queryFn: () => api.toolApprovals(id) }),
	mail: (id: string) => queryOptions({ queryKey: ['mail', id], queryFn: () => api.mailApprovals(id) }),
};

/** How often a panel that shows a sandbox listing polls it: often while it reads the live sandbox, rarely from a snapshot. Made here for the same reason as `taskQueries`. */
export const refreshBySource = (query: { state: { data?: { source?: Source } } }) => refreshFor(query.state.data?.source);
