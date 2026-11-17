import type { UseFlueAgentResult } from '@flue/react';
import { Suspense } from 'react';
import { act, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useReplyActivity } from '@/lib/reply-activity';
import { WorkingLogo } from '@/components/marks/working-logo';

it('keeps animating until the deferred final response commits, not merely until the agent becomes idle', async () => {
	let finish!: () => void;
	let blocked = true;
	const ready = new Promise<void>((resolve) => { finish = () => { blocked = false; resolve(); }; });
	function Reply({ agent }: { agent: UseFlueAgentResult }) {
		const { conversation, working } = useReplyActivity(agent);
		const text = conversation[0]?.parts[0];
		const value = text?.type === 'text' ? text.text : '';
		if (value === 'Entire final response' && blocked) throw ready;
		return <><WorkingLogo active={working} /><p>{value}</p></>;
	}
	const agent = (value: string, status: string) => ({ messages: [{ id: 'a', role: 'assistant', display: 'visible', parts: [{ type: 'text', text: value }] }], settlements: [], status }) as unknown as UseFlueAgentResult;
	const ui = (value: string, status: string) => <Suspense fallback="Drawing"><Reply agent={agent(value, status)} /></Suspense>;
	const view = render(ui('Partial response', 'streaming'));
	view.rerender(ui('Entire final response', 'idle'));
	expect(screen.getByText('Partial response')).toBeTruthy();
	expect(screen.getByRole('status', { name: 'Anton is working' })).toBeTruthy();
	expect(screen.queryByText('Drawing')).toBeNull();
	await act(async () => finish());
	expect(screen.getByText('Entire final response')).toBeTruthy();
	expect(screen.queryByRole('status', { name: 'Anton is working' })).toBeNull();
});
