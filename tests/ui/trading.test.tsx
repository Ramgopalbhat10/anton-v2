import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerView, OrderApproval } from '@/lib/api';
import { renderWithQueries } from './render';

const { api } = vi.hoisted(() => ({
	api: { orderApprovals: vi.fn(), decideOrder: vi.fn(), trading: vi.fn(), saveBroker: vi.fn(), checkBroker: vi.fn() },
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { OrderCard, isOrderTool, orderOf } = await import('@/components/order-card');
const { TradingPage } = await import('@/components/settings/trading');
const { ReplyActions } = await import('@/components/reply-cards');
const { describeTool } = await import('@/components/tool-describe');

beforeEach(() => vi.clearAllMocks());

describe('An order the agent asks for', () => {
	const order: OrderApproval = {
		id: 'order_1',
		broker: 'indstocks',
		brokerName: 'INDstocks',
		action: {
			kind: 'place',
			order: { side: 'BUY', exchange: 'NSE', segment: 'EQUITY', product: 'CNC', orderType: 'LIMIT', securityId: '2885', quantity: 10, limitPrice: 240, afterMarket: false, tag: null },
			symbol: 'RELIANCE',
		},
		value: 2400,
		state: 'pending',
		createdAt: '2026-11-03T05:00:00Z',
		expiresAt: '2026-11-03T05:30:00Z',
		decidedAt: null,
		orderId: null,
		problem: null,
	};

	it('is found from its tool and result', () => {
		expect(isOrderTool('indstocks_place_order')).toBe(true);
		expect(isOrderTool('indstocks_cancel_order')).toBe(true);
		expect(isOrderTool('indstocks_orders')).toBe(false);
		expect(orderOf({ output: 'The user now sees it. [order:order_1]' })).toBe('order_1');
		expect(describeTool({ toolName: 'indstocks_place_order', input: { side: 'SELL', quantity: 5, symbol: 'TCS' } }).body).toBeTruthy();
	});

	it('shows the order as it will go, and places it only on Place, telling the agent', async () => {
		api.orderApprovals.mockResolvedValue({ orders: [order] });
		const placed: OrderApproval = { ...order, state: 'done', decidedAt: '2026-11-03T05:02:00Z', orderId: 'EQ-93586788' };
		api.decideOrder.mockImplementation(async () => {
			api.orderApprovals.mockResolvedValue({ orders: [placed] });
			return placed;
		});
		const reply = vi.fn();
		renderWithQueries(
			<ReplyActions.Provider value={{ send: reply, busy: false }}>
				<OrderCard sessionId="s1" approvalId="order_1" place={{ latest: true, answer: null }} />
			</ReplyActions.Provider>,
		);
		const card = await screen.findByRole('region', { name: 'Order to place' });
		expect(within(card).getByText('Buy 10 RELIANCE')).toBeTruthy();
		expect(within(card).getByText(/worth about ₹2,400/)).toBeTruthy();
		expect(within(card).getByText('₹240')).toBeTruthy();
		expect(within(card).getByText('NSE · EQUITY · CNC')).toBeTruthy();
		expect(api.decideOrder).not.toHaveBeenCalled();
		fireEvent.click(within(card).getByRole('button', { name: 'Place' }));
		await waitFor(() => expect(api.decideOrder).toHaveBeenCalledWith('s1', 'order_1', true));
		await waitFor(() => expect(reply).toHaveBeenCalledWith('Done on INDstocks: "Buy 10 RELIANCE", order EQ-93586788.'));
		expect(await within(card).findByText(/Placed/)).toBeTruthy();
	});

	it('says when no answer came, so it is not placed again', async () => {
		api.orderApprovals.mockResolvedValue({ orders: [{ ...order, state: 'unknown', problem: 'socket hang up' }] });
		renderWithQueries(<OrderCard sessionId="s1" approvalId="order_1" place={{ latest: false, answer: null }} />);
		expect(await screen.findByText(/no answer came\. Check the order book/)).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Place' })).toBeNull();
	});
});

describe('Settings › Trading', () => {
	const broker: BrokerView = {
		id: 'indstocks',
		name: 'INDstocks',
		ready: true,
		enabled: true,
		trading: true,
		fields: [
			{ key: 'clientId', label: 'Client ID', secret: true, optional: true, help: 'From the Access Tokens page', set: true },
			{ key: 'mpin', label: 'MPIN', secret: true, optional: true, help: 'Your MPIN', set: true },
			{ key: 'totpSecret', label: 'TOTP secret', secret: true, optional: true, help: 'The setup key', set: false },
			{ key: 'accessToken', label: 'Access token', secret: true, optional: true, help: 'Or a token', set: false },
		],
		proxy: 'https://13-233-10-20.sslip.io',
		maxOrderValue: 10_000,
		maxOrdersPerDay: 20,
		timeZone: 'Asia/Kolkata',
		hosts: ['api.indstocks.com'],
		sessionEndsAt: null,
	};

	it('never shows saved values, sends only what changed, and checks the address calls leave from', async () => {
		api.trading.mockResolvedValue({ brokers: [broker] });
		api.saveBroker.mockResolvedValue({ ...broker, fields: broker.fields.map((field) => ({ ...field, set: field.key !== 'mpin' })) });
		api.checkBroker.mockResolvedValue({ name: 'Subbu', address: '13.233.10.20', problem: null });
		renderWithQueries(<TradingPage />);
		const clientId = (await screen.findByLabelText('Client ID')) as HTMLInputElement;
		expect(clientId.value).toBe('');
		expect(clientId.placeholder).toBe('Saved; type to replace');
		expect(screen.getByText('Calls go through https://13-233-10-20.sslip.io.')).toBeTruthy();
		fireEvent.change(screen.getByLabelText('TOTP secret'), { target: { value: 'JBSWY3DPEHPK3PXP' } });
		fireEvent.click(screen.getByRole('button', { name: 'Remove MPIN' }));
		fireEvent.change(screen.getByLabelText("Most an order may be worth (₹)"), { target: { value: '5000' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await waitFor(() =>
			expect(api.saveBroker).toHaveBeenCalledWith('indstocks', {
				enabled: true,
				trading: true,
				credentials: { clientId: null, mpin: '', totpSecret: 'JBSWY3DPEHPK3PXP', accessToken: null },
				maxOrderValue: 5000,
				maxOrdersPerDay: 20,
			}),
		);
		fireEvent.click(screen.getByRole('button', { name: 'Check' }));
		expect(await screen.findByText(/Signed in as Subbu\. INDstocks sees calls from 13\.233\.10\.20/)).toBeTruthy();
	});
});
