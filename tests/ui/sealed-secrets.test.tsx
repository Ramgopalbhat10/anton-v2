import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SealedSecret } from '@/lib/api';
import { renderWithQueries } from './render';

const api = vi.hoisted(() => ({ secrets: vi.fn(), sealedSecrets: vi.fn(), saveSealedSecret: vi.fn(), deleteSealedSecret: vi.fn(), saveSharedEnv: vi.fn() }));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));
const { SecretsPage } = await import('@/components/settings/secrets');

const token: SealedSecret = { name: 'BROKER_TOKEN', hosts: ['api.indstocks.com'], proxy: 'https://3-104-97-252.sslip.io', readsDirect: false, source: { by: 'task', taskId: 't1' }, updatedAt: new Date().toISOString() };
const key: SealedSecret = { name: 'BROKER_MPIN', hosts: ['api.indstocks.com'], proxy: 'https://3-104-97-252.sslip.io', readsDirect: false, source: { by: 'you' }, updatedAt: new Date().toISOString() };

beforeEach(() => {
	vi.clearAllMocks();
	api.secrets.mockResolvedValue({ shared: [], repos: [] });
});

describe('Settings › Secrets › Sealed', () => {
	it('lists sealed secrets by name and where they go, never a value, and adds one', async () => {
		api.sealedSecrets.mockResolvedValue({ secrets: [key, token] });
		api.saveSealedSecret.mockResolvedValue({ secrets: [key, token, { ...key, name: 'BROKER_TOTP' }] });
		renderWithQueries(<SecretsPage />);
		const block = await screen.findByRole('region', { name: 'Sealed' });
		expect(await within(block).findByText('BROKER_MPIN')).toBeTruthy();
		expect(within(block).getAllByText(/To api\.indstocks\.com · through https:\/\/3-104-97-252\.sslip\.io/)).toHaveLength(2);
		expect(within(block).getByText(/Kept by a task from an answer/)).toBeTruthy();
		// What a task kept can be deleted, not edited.
		expect(within(block).queryByRole('button', { name: 'Change BROKER_TOKEN' })).toBeNull();
		await userEvent.click(within(block).getByRole('button', { name: 'Add sealed secret' }));
		const form = within(block).getByRole('form', { name: 'Add a sealed secret' });
		await userEvent.type(within(form).getByPlaceholderText('BROKER_API_KEY'), 'broker_totp');
		await userEvent.type(within(form).getByPlaceholderText('Never shown again'), 'JBSWY3DPEHPK3PXP');
		await userEvent.type(within(form).getByPlaceholderText('api.example.com, *.example.com'), 'api.indstocks.com');
		await userEvent.click(within(form).getByRole('button', { name: 'Add secret' }));
		await waitFor(() => expect(api.saveSealedSecret).toHaveBeenCalledWith('BROKER_TOTP', { value: 'JBSWY3DPEHPK3PXP', hosts: ['api.indstocks.com'], proxy: null, readsDirect: false }));
		expect(await within(block).findByText('BROKER_TOTP')).toBeTruthy();
	});

	it('changes one without its value, keeping the stored one, and can remove its proxy', async () => {
		api.sealedSecrets.mockResolvedValue({ secrets: [key] });
		api.saveSealedSecret.mockResolvedValue({ secrets: [{ ...key, proxy: null }] });
		renderWithQueries(<SecretsPage />);
		await userEvent.click(await screen.findByRole('button', { name: 'Change BROKER_MPIN' }));
		const form = screen.getByRole('form', { name: 'Change BROKER_MPIN' });
		expect((within(form).getByPlaceholderText('Saved; type to replace') as HTMLInputElement).value).toBe('');
		await userEvent.click(within(form).getByRole('button', { name: 'Remove the proxy' }));
		await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
		await waitFor(() => expect(api.saveSealedSecret).toHaveBeenCalledWith('BROKER_MPIN', { value: null, hosts: ['api.indstocks.com'], proxy: '', readsDirect: false }));
	});
});
