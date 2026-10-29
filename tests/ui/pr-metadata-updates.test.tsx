import { describe, expect, it } from 'vitest';
import { staleFor } from '@/lib/live-updates';

describe('pull request metadata invalidation', () => {
	it('ignores ordinary task updates and invalidates only the changed task on a PR update', () => {
		expect(staleFor({ kind: 'task', id: 's1', what: 'state' })).not.toContainEqual(['pr-metadata', 's1']);
		expect(staleFor({ kind: 'task', id: 's1', what: 'files' })).not.toContainEqual(['pr-metadata', 's1']);
		expect(staleFor({ kind: 'task', id: 's1', what: 'pr-metadata' })).toEqual([['pr-metadata', 's1']]);
	});
});
