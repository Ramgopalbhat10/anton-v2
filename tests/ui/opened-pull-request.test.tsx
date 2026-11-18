import { describe, expect, it } from 'vitest';
import { openedPullRequest } from '@/components/thread/blocks';

const opened = (url: string) => ({ type: 'dynamic-tool', toolName: 'open_pull_request', toolCallId: 't1', state: 'output-available', input: { title: 'Old' }, output: { url } });

describe('openedPullRequest', () => {
	it('reads the pull request Anton pushed when the reply ended from its metadata', () => {
		const queued = { type: 'dynamic-tool', toolName: 'open_pull_request', toolCallId: 't1', state: 'output-available', input: { title: 'Fix' }, output: 'Committed in the sandbox.' };
		expect(openedPullRequest([queued] as never, { pullRequest: { url: 'https://github.com/acme/demo/pull/9', title: 'Fix' } })).toEqual({ url: 'https://github.com/acme/demo/pull/9', title: 'Fix' });
		expect(openedPullRequest([queued] as never, {})).toBeNull();
	});

	it("still reads an older reply's pull request from its tool call", () => {
		expect(openedPullRequest([opened('https://github.com/acme/demo/pull/7')] as never)).toEqual({ url: 'https://github.com/acme/demo/pull/7', title: 'Old' });
	});
});
