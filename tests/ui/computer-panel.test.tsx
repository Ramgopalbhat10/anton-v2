import { act, fireEvent, screen, waitFor } from '@testing-library/react';
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

/** The live view's socket, as the panel opens it. */
class FakeSocket extends EventTarget {
	static OPEN = 1;
	readyState = 0;
	binaryType = '';
	sent: Array<Record<string, unknown>> = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { wasClean: boolean }) => void) | null = null;
	close = vi.fn();
	constructor(public url: string) {
		super();
		sockets.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
}
const sockets: FakeSocket[] = [];
vi.stubGlobal('WebSocket', FakeSocket);

const api = vi.hoisted(() => ({
	computer: vi.fn(),
	startComputer: vi.fn(),
	connectComputer: vi.fn(),
	connectSandboxBrowser: vi.fn(),
	stopComputer: vi.fn(),
	setComputerControl: vi.fn(),
	computerScreenshot: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api }));

const { ComputerTab } = await import('@/components/computer-tab');

const view = (patch: Partial<ComputerView> = {}): ComputerView => ({
	live: true,
	running: true,
	browser: false,
	screen: { width: 1280, height: 800 },
	agentBusy: false,
	userControl: false,
	...patch,
});

beforeEach(() => {
	clients.length = 0;
	sockets.length = 0;
	for (const mock of Object.values(api)) mock.mockReset();
	api.connectComputer.mockImplementation(async () => ({ ...view(), url: 'wss://screen.example/?_modal_connect_token=t1' }));
	api.connectSandboxBrowser.mockImplementation(async () => ({ ...view({ running: false, browser: true }), url: 'wss://browser.example/?_modal_connect_token=b1' }));
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

	it('turns the computer off, back to Start computer, but not while the agent uses it', async () => {
		api.computer.mockResolvedValue(view());
		api.stopComputer.mockResolvedValue(view({ running: false }));
		renderWithQueries(<ComputerTab sessionId="s1" />);
		await waitFor(() => expect(clients).toHaveLength(1));
		await userEvent.click(screen.getByRole('button', { name: 'Turn off the computer' }));
		expect(api.stopComputer).toHaveBeenCalledWith('s1');
		expect(await screen.findByRole('button', { name: 'Start computer' })).toBeTruthy();
		expect(screen.getByText(/the sandbox stops itself after a quiet spell/)).toBeTruthy();
		expect(clients[0].disconnect).toHaveBeenCalled();
	});

	it('keeps Turn off disabled while the agent uses the computer', async () => {
		api.computer.mockResolvedValue(view({ agentBusy: true }));
		renderWithQueries(<ComputerTab sessionId="s1" />);
		const off = await screen.findByRole('button', { name: 'The agent is using the computer' });
		expect((off as HTMLButtonElement).disabled).toBe(true);
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

	it('shows the sandbox browser from its live view, without a desktop, and sends your input only once you take over', async () => {
		api.computer.mockResolvedValue(view({ running: false, browser: true }));
		api.setComputerControl.mockImplementation(async (_id: string, driver: 'user' | 'agent') => view({ running: false, browser: true, userControl: driver === 'user' }));
		renderWithQueries(<ComputerTab sessionId="s1" />);
		await waitFor(() => expect(sockets).toHaveLength(1));
		expect(sockets[0].url).toBe('wss://browser.example/?_modal_connect_token=b1');
		expect(api.connectComputer).not.toHaveBeenCalled();
		expect(clients).toHaveLength(0);
		act(() => sockets[0].open());
		expect(screen.queryByText('Connecting to the computer')).toBeNull();
		const canvas = screen.getByTestId('browser-screen') as HTMLCanvasElement;
		act(() => sockets[0].onmessage?.({ data: JSON.stringify({ type: 'size', width: 1024, height: 640 }) }));
		expect([canvas.width, canvas.height]).toEqual([1024, 640]);

		fireEvent.keyDown(canvas, { key: 'a' });
		expect(sockets[0].sent).toEqual([]);
		await userEvent.click(screen.getByRole('button', { name: 'Take over' }));
		await screen.findByText(/You have the computer/);
		fireEvent.keyDown(canvas, { key: 'a' });
		fireEvent.keyUp(canvas, { key: 'a' });
		expect(sockets[0].sent).toEqual([{ type: 'keydown', key: 'a' }, { type: 'keyup', key: 'a' }]);
	});

	it('switches between the sandbox browser and the desktop when both run', async () => {
		api.computer.mockResolvedValue(view({ running: true, browser: true }));
		renderWithQueries(<ComputerTab sessionId="s1" />);
		await waitFor(() => expect(sockets).toHaveLength(1));
		await userEvent.click(screen.getByRole('button', { name: 'Show the desktop' }));
		await waitFor(() => expect(clients).toHaveLength(1));
		expect(sockets[0].close).toHaveBeenCalled();
		await userEvent.click(screen.getByRole('button', { name: 'Show the sandbox browser' }));
		await waitFor(() => expect(sockets).toHaveLength(2));
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
