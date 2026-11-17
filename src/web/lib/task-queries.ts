import { queryOptions } from '@tanstack/react-query';
import { api, refreshFor } from '@/lib/api';
import type { Source } from '@/lib/api/workspace';

/**
 * Made here, not inline: the query cache keeps the last reader's `queryFn` for `gcTime`, and an inline arrow kept that
 * component's whole closure (rows, refs, detached DOM) alive. These close over the task's id alone.
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

/** Polls often while the listing reads the live sandbox, rarely from a snapshot; made here for the same reason as `taskQueries`. */
export const refreshBySource = (query: { state: { data?: { source?: Source } } }) => refreshFor(query.state.data?.source);
