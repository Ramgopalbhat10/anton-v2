import WebSocket from 'ws';

/** An event the browser sent: a method name, its parameters, and the page session it came from, if any. */
export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * One WebSocket to a browser's Chrome DevTools Protocol endpoint. Commands
 * get replies by id; page commands carry the session id of the page they
 * target (flattened sessions). Every command times out rather than hang.
 */
export class CdpConnection {
	private next = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Set<(event: CdpEvent) => void>();
	private readonly closers = new Set<() => void>();
	private closed = false;
	private readonly socket: WebSocket;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.on('message', (data) => this.receive(String(data)));
		socket.on('close', () => this.shutdown(new Error('The browser connection closed')));
		socket.on('error', (error) => this.shutdown(error instanceof Error ? error : new Error(String(error))));
	}

	static connect(url: string, timeoutMs = 15_000): Promise<CdpConnection> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
			const timer = setTimeout(() => {
				socket.terminate();
				reject(new Error('Timed out connecting to the browser'));
			}, timeoutMs);
			socket.once('open', () => {
				clearTimeout(timer);
				resolve(new CdpConnection(socket));
			});
			socket.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	get isOpen(): boolean {
		return !this.closed;
	}

	send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 20_000): Promise<T> {
		if (this.closed) return Promise.reject(new Error('The browser connection is closed'));
		const id = this.next++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The browser did not answer ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	/** Calls `listener` for every event until the returned function is called. */
	on(listener: (event: CdpEvent) => void): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	onClose(listener: () => void): void {
		if (this.closed) listener();
		else this.closers.add(listener);
	}

	close(): void {
		this.socket.close();
		this.shutdown(new Error('The browser connection closed'));
	}

	private receive(raw: string) {
		let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (message.id !== undefined) {
			const waiting = this.pending.get(message.id);
			if (!waiting) return;
			this.pending.delete(message.id);
			clearTimeout(waiting.timer);
			if (message.error) waiting.reject(new Error(message.error.message ?? 'The browser refused the command'));
			else waiting.resolve(message.result ?? {});
			return;
		}
		if (message.method) {
			const event: CdpEvent = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
			for (const listener of this.listeners) listener(event);
		}
	}

	private shutdown(error: Error) {
		if (this.closed) return;
		this.closed = true;
		for (const waiting of this.pending.values()) {
			clearTimeout(waiting.timer);
			waiting.reject(error);
		}
		this.pending.clear();
		for (const closer of this.closers) closer();
		this.closers.clear();
	}
}
