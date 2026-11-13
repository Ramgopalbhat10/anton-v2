import { describe, expect, it } from 'vitest';
import { staleFor } from '@/lib/live-updates';

describe('pull request metadata invalidation', () => {
	it('ignores ordinary task updates and invalidates only the changed task on a PR update', () => {
		expect(staleFor({ kind: 'task', id: 's1', what: 'state' })).not.toContainEqual(['pr-metadata', 's1']);
		expect(staleFor({ kind: 'task', id: 's1', what: 'files' })).not.toContainEqual(['pr-metadata', 's1']);
		expect(staleFor({ kind: 'task', id: 's1', what: 'pr-metadata' })).toEqual([['pr-metadata', 's1']]);
	});
});

describe('a model turn', () => {
	it('refetches the context meter and spend, not the task’s files, pull requests or projects', () => {
		const keys = staleFor({ kind: 'task', id: 's1', what: 'usage' });
		expect(keys).toContainEqual(['context', 's1']);
		expect(keys).toContainEqual(['session', 's1']);
		expect(keys).not.toContainEqual(['files', 's1']);
		expect(keys).not.toContainEqual(['pulls', 's1']);
		expect(keys).not.toContainEqual(['spaces']);
	});
});
