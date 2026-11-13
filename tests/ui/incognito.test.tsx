import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	agent: { messages: [] as unknown[], status: 'idle', sendMessage: vi.fn(async () => undefined) },
	api: { chooseIncognito: vi.fn(async (_id: string, _choice: unknown) => undefined), closeIncognito: vi.fn(async (_id: string) => undefined), stopIncognito: vi.fn(async () => undefined) },
	navigate: vi.fn(),
}));

vi.mock('@flue/react', () => ({ useFlueAgent: () => mocks.agent }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/lib/api', () => ({ api: mocks.api }));
vi.mock('@/lib/flight', () => ({ flyFrom: vi.fn() }));
vi.mock('@/components/model-picker', () => ({
	useModels: () => ({ data: { default: 'test/model', models: [] } }),
	ModelPicker: () => null,
}));
vi.mock('@/components/mascot', () => ({ Mascot: () => null, useMascotMood: () => 'idle' }));
vi.mock('@/components/composer-plus', () => ({ ComposerPlus: () => null }));
vi.mock('@/components/composer-input', () => ({
	ComposerInput: ({ value, onChange }: { value: string; onChange: (text: string) => void }) => (
		<textarea aria-label="Message" value={value} onChange={(event) => onChange(event.target.value)} />
	),
}));
vi.mock('@/components/attachments', () => ({
	AttachmentTray: () => null,
	useAttachments: () => ({ images: [], count: 0, dropZone: {}, take: () => ({ files: [], images: [] }) }),
}));
// Keep Thread's layout contract: its flex-1 needs a constrained flex-column parent.
// The browser check exercises the real Thread's geometry; happy-dom has no layout.
vi.mock('@/components/thread', () => ({
	Thread: () => <div data-testid="thread" className="flex min-h-0 min-w-0 flex-1 flex-col" />,
}));

const { IncognitoPage } = await import('@/components/incognito');

beforeEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	mocks.agent.messages = [];
	mocks.agent.status = 'idle';
	vi.spyOn(HTMLElement.prototype, 'getAnimations').mockReturnValue([]);
});

async function send() {
	fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'A private question' } });
	fireEvent.click(screen.getByRole('button', { name: 'Send' }));
	await waitFor(() => expect(mocks.agent.sendMessage).toHaveBeenCalledOnce());
}

describe('IncognitoPage', () => {
	it('constrains the thread above the non-shrinking composer through streaming and later turns', async () => {
		const view = render(<IncognitoPage />);
		const input = screen.getByRole('textbox', { name: 'Message' });
		const composer = input.closest('form');
		expect(screen.queryByTestId('thread')).toBeNull();
		await send();
		// Do not flash Thread's empty state between sending and the first message.
		expect(screen.queryByTestId('thread')).toBeNull();
		for (const status of ['submitted', 'streaming', 'idle']) {
			mocks.agent.status = status;
			mocks.agent.messages = [{ id: status }];
			view.rerender(<IncognitoPage />);
			const slot = screen.getByTestId('thread').parentElement!;
			for (const token of ['flex', 'flex-col', 'flex-1', 'min-h-0', 'min-w-0']) expect(slot.classList.contains(token)).toBe(true);
			expect(slot.nextElementSibling?.classList.contains('shrink-0')).toBe(true);
			expect(slot.nextElementSibling?.contains(composer)).toBe(true);
			expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
		}
		// The composer is not remounted when docking, or when a reply changes state.
		expect(document.querySelectorAll('form')).toHaveLength(1);
	});

	it('does not prime or delete an unused chat', () => {
		const view = render(<IncognitoPage />);
		act(() => window.dispatchEvent(new Event('pagehide')));
		view.unmount();
		expect(mocks.api.chooseIncognito).not.toHaveBeenCalled();
		expect(mocks.api.closeIncognito).not.toHaveBeenCalled();
	});

	it('keeps cleanup on leaving or closing a used chat, without deleting twice', async () => {
		const view = render(<IncognitoPage />);
		await send();
		const [id] = mocks.api.chooseIncognito.mock.calls[0];
		expect(id).toMatch(/^inco_/);
		act(() => window.dispatchEvent(new Event('pagehide')));
		view.unmount();
		expect(mocks.api.closeIncognito).toHaveBeenCalledExactlyOnceWith(id);
	});

	it('deletes a used chat on route unmount and keeps the close navigation', async () => {
		const view = render(<IncognitoPage />);
		await send();
		fireEvent.click(screen.getByRole('button', { name: 'Close incognito chat' }));
		expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' });
		view.unmount();
		expect(mocks.api.closeIncognito).toHaveBeenCalledOnce();
	});
});
