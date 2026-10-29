import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { renderWithQueries, session } from './render';

const api = vi.hoisted(() => ({ previews: vi.fn(), session: vi.fn() }));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
const { PreviewTab } = await import('@/components/preview-tab');

it('opens the Computer panel to watch a test without changing the Preview iframe', async () => {
	api.session.mockResolvedValue(session({ status: 'running' }));
	api.previews.mockResolvedValue({ live: true, previews: [{ port: 3000, url: 'https://preview.example', listening: true }] });
	const watch = vi.fn();
	renderWithQueries(<PreviewTab sessionId="s1" onWatchTest={watch} />);
	const button = await screen.findByRole('button', { name: "Watch the agent's test in Computer" });
	expect(screen.getByTitle('Preview of port 3000').getAttribute('src')).toBe('https://preview.example');
	await userEvent.click(button);
	expect(watch).toHaveBeenCalledOnce();
});
