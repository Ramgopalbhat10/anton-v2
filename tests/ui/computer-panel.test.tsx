import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerView } from '@/lib/api';
import { renderWithQueries } from './render';

type FakeRfb = EventTarget & { url: string; options: unknown; viewOnly: boolean; scaleViewport: boolean; disconnect: () => void; focus: () => void };

const clients = vi.hoisted(() => [] as FakeRfb[]);
vi.mock('@novnc/novnc', () => ({
	default: class extends EventTarget {
		viewOnly = false;
		scaleViewport = false;
		resizeSession = true;
		background = '';
		disconnect = vi.fn();
		focus = vi.fn();
		constructor(
			_target: HTMLElement,
			public url: string,
			public options: unknown,
		) {
			super();
			clients.push(this as unknown as FakeRfb);
		}
	},
}));

const api = vi.hoisted(() => ({
	computer: vi.fn(),
	startComputer: vi.fn(),
	connectComputer: vi.fn(),
	setComputerControl: vi.fn(),
	computerScreenshot: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { ComputerTab } = await import('@/components/computer-tab');

const view = (patch: Partial<ComputerView> = {}): ComputerView => ({
	live: true,
	running: true,
	screen: { width: 1280, height: 800 },
	agentBusy: false,
	userControl: false,
	...patch,
});

beforeEach(() => {
	clients.length = 0;
	for (const mock of Object.values(api)) mock.mockReset();
	api.connectComputer.mockImplementation(async () => ({ ...view(), url: 'wss://screen.example/?_modal_connect_token=t1' }));
});

describe('The Computer panel', () => {
	it('never starts the sandbox by being looked at, and starts it with Start computer', async () => {
		api.computer.mockResolvedValue(view({ live: false, running: false }));
		api.startComputer.mockResolvedValue({ ...view(), url: 'wss://screen.example/?_modal_connect_token=t0' });
		renderWithQueries(<ComputerTab sessionId="s1" />);
		const start = await screen.findByRole('button', { name: 'Start computer' });
		expect(screen.getByText(/Starting it starts the sandbox/)).toBeTruthy();
		expect(api.startComputer).not.toHaveBeenCalled();
		expect(api.connectComputer).not.toHaveBeenCalled();

		await userEvent.click(start);
		expect(api.startComputer).toHaveBeenCalledWith('s1');
		// Started, the screen connects through a fresh address, watching only.
		await waitFor(() => expect(clients).toHaveLength(1));
		expect(clients[0].url).toBe('wss://screen.example/?_modal_connect_token=t1');
		expect(clients[0].viewOnly).toBe(true);
		expect(clients[0].scaleViewport).toBe(true);
		expect(screen.getByText('Connecting to the computer')).toBeTruthy();
		act(() => void clients[0].dispatchEvent(new CustomEvent('connect')));
		expect(screen.queryByText('Connecting to the computer')).toBeNull();
		expect(screen.getByText('Watching. Take over to use it yourself.')).toBeTruthy();
	});

	it('hands the mouse and keyboard to you on Take over, and back to the agent on Give back', async () => {
		api.computer.mockResolvedValue(view({ agentBusy: true }));
		api.setComputerControl.mockImplementation(async (_id: string, driver: 'user' | 'agent') => view({ userControl: driver === 'user' }));
		renderWithQueries(<ComputerTab sessionId="s1" />);
		expect(await screen.findByText('The agent is using the computer')).toBeTruthy();
		await waitFor(() => expect(clients).toHaveLength(1));

		await userEvent.click(screen.getByRole('button', { name: 'Take over' }));
		expect(api.setComputerControl).toHaveBeenCalledWith('s1', 'user');
		await screen.findByText(/You have the computer/);
		expect(clients[0].viewOnly).toBe(false);
		expect(clients[0].focus).toHaveBeenCalled();

		await userEvent.click(screen.getByRole('button', { name: 'Give back' }));
		expect(api.setComputerControl).toHaveBeenLastCalledWith('s1', 'agent');
		await screen.findByText('Watching. Take over to use it yourself.');
		expect(clients[0].viewOnly).toBe(true);
	});

	it('says when the connection closes, and reconnects with a fresh address', async () => {
		api.computer.mockResolvedValue(view());
		renderWithQueries(<ComputerTab sessionId="s1" />);
		await waitFor(() => expect(clients).toHaveLength(1));
		act(() => void clients[0].dispatchEvent(new CustomEvent('connect')));
		act(() => void clients[0].dispatchEvent(new CustomEvent('disconnect', { detail: { clean: true } })));
		await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
		await waitFor(() => expect(clients).toHaveLength(2));
		expect(api.connectComputer).toHaveBeenCalledTimes(2);
		expect(clients[0].disconnect).toHaveBeenCalled();
	});

	it('shows why the screen could not connect', async () => {
		api.computer.mockResolvedValue(view());
		api.connectComputer.mockRejectedValue(new Error('The sandbox is not running. Start the computer first.'));
		renderWithQueries(<ComputerTab sessionId="s1" />);
		expect(await screen.findByText('The sandbox is not running. Start the computer first.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
	});
});
