import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { renderWithQueries } from './render';

const api = vi.hoisted(() => ({ automations: vi.fn(async () => ({ automations: [] })), addAutomation: vi.fn(async () => ({})), subscriptions: vi.fn(async () => ({ subscriptions: [] })) }));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
const { Automations } = await import('@/components/automations');

it('uses the same routing controls in repository automation drafts and submits only that automation', async () => {
	const gateway = { id: 'openrouter/test/model', name: 'Gateway', vendor: 'Test', description: '', createdAt: 0, contextLength: 128000, maxOutput: null, price: { input: 1, output: 2 }, vision: false, reasoning: ['low', 'high'], defaultReasoning: 'high' };
	renderWithQueries(<Automations projectId="p1" />, [[['models'], { models: [gateway], default: gateway.id }]]);
	await userEvent.click(await screen.findByRole('button', { name: 'Add an automation' }));
	await userEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }));
	await userEvent.click(screen.getByRole('radio', { name: 'Low' }));
	await userEvent.click(screen.getByRole('button', { name: 'Sort providers: default' }));
	await userEvent.click(screen.getByRole('menuitem', { name: /Price/ }));
	await userEvent.keyboard('{Escape}');
	expect(api.addAutomation).not.toHaveBeenCalled();
	await userEvent.click(screen.getByRole('button', { name: 'Add automation' }));
	await waitFor(() => expect(api.addAutomation).toHaveBeenCalledWith('p1', expect.objectContaining({ model: `${gateway.id}#sort=price`, reasoning: 'low' })));
});
