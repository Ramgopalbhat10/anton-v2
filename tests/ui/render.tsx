import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect } from 'vitest';
import type { Session } from '@/lib/api/sessions';

/** Source rendered through `@pierre/diffs` lives in a Shadow DOM beyond `screen`'s reach; its `pre` carries the code text. */
export async function shadowCodeText(host: ParentNode = document): Promise<string> {
	let text = '';
	await waitFor(() => {
		const pre = host.querySelector('diffs-container')?.shadowRoot?.querySelector('pre');
		expect(pre?.textContent?.trim().length).toBeGreaterThan(0);
		text = pre?.textContent ?? '';
	});
	return text;
}

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
	plan: null,
	...patch,
});
