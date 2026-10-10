import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Session } from '@/lib/api';

/** Renders with a fresh query cache, seeded with whatever the test passes. */
export function renderWithQueries(ui: ReactNode, seed: Array<[unknown[], unknown]> = []) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
	for (const [key, value] of seed) client.setQueryData(key, value);
	return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

export const session = (patch: Partial<Session> = {}): Session => ({
	id: 's1',
	projectId: 'p1',
	repo: 'acme/demo',
	title: 'Task',
	model: 'openrouter/test/model',
	reasoning: null,
	branch: 'anton/task-s1',
	baseBranch: 'main',
	baseSha: 'abc',
	status: 'stopped',
	working: false,
	workspace: false,
	planMode: false,
	prUrl: null,
	errorMessage: null,
	checkpointAt: null,
	createdAt: '2026-10-03T00:00:00Z',
	pinnedAt: null,
	pullRequest: null,
	usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
	lastInput: null,
	lastInputAt: null,
	asking: null,
	...patch,
});
