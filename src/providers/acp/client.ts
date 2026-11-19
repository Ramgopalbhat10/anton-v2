// ACP (Agent Client Protocol) client: JSON-RPC 2.0, one message per line.
// The transport is a byte pipe — a Modal exec stdio channel or a child
// process — so this file knows nothing about where the agent runs.

export type AcpTransport = {
	/** Raw bytes to the agent's stdin. */
	write(data: string): void;
	/** stdout, split into lines. */
	lines(): AsyncIterable<string>;
	/** stderr for debugging; may be absent. */
	stderr?(): AsyncIterable<string>;
	closeStdin(): Promise<void>;
	/** Kill the process when one exists; otherwise closing stdin ends it. */
	kill(): Promise<void>;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class AcpClient {
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private buffer = '';
	private readonly transport: AcpTransport;
	readonly onNotification: (method: string, params: unknown) => void;
	readonly onRequest: (method: string, params: unknown, id: number | string) => Promise<unknown>;
	private dead: Error | null = null;

	constructor(
		transport: AcpTransport,
		handlers: {
			onNotification?: (method: string, params: unknown) => void;
			onRequest?: (method: string, params: unknown, id: number | string) => Promise<unknown>;
		} = {},
	) {
		this.transport = transport;
		this.onNotification = handlers.onNotification ?? (() => {});
		this.onRequest =
			handlers.onRequest ??
			(async (method: string) => {
				throw new Error(`unhandled agent request ${method}`);
			});
	}

	start(): void {
		void this.read();
	}

	request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
		if (this.dead) return Promise.reject(this.dead);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = timeoutMs
				? setTimeout(() => {
						this.pending.delete(id);
						reject(new Error(`${method} timed out after ${timeoutMs}ms`));
					}, timeoutMs)
				: null;
			this.pending.set(id, {
				resolve: (value) => {
					if (timer) clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					if (timer) clearTimeout(timer);
					reject(error);
				},
			});
			this.transport.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);
		});
	}

	notify(method: string, params?: unknown): void {
		if (this.dead) return;
		this.transport.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
	}

	respond(id: number | string, result: unknown): void {
		this.transport.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
	}

	fail(id: number | string, code: number, message: string): void {
		this.transport.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
	}

	private async read(): Promise<void> {
		try {
			for await (const chunk of this.transport.lines()) {
				this.buffer += chunk;
				let nl: number;
				while ((nl = this.buffer.indexOf('\n')) >= 0) {
					const line = this.buffer.slice(0, nl).trim();
					this.buffer = this.buffer.slice(nl + 1);
					if (line) this.dispatch(line);
				}
			}
		} catch (error) {
			this.dead = error instanceof Error ? error : new Error(String(error));
		}
		this.dead ??= new Error('agent closed its output');
		for (const p of this.pending.values()) p.reject(this.dead);
		this.pending.clear();
	}

	private dispatch(line: string): void {
		let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.id !== undefined && msg.method === undefined) {
			const p = this.pending.get(Number(msg.id));
			if (p) {
				this.pending.delete(Number(msg.id));
				if (msg.error) p.reject(new Error(msg.error.message ?? 'agent error'));
				else p.resolve(msg.result);
			}
			return;
		}
		if (msg.method === undefined) return;
		if (msg.id !== undefined) {
			void this.onRequest(msg.method, msg.params, msg.id).then(
				(result) => this.respond(msg.id as number | string, result ?? null),
				(error) => this.fail(msg.id as number | string, -32603, error instanceof Error ? error.message : String(error)),
			);
			return;
		}
		this.onNotification(msg.method, msg.params);
	}

	async close(): Promise<void> {
		await this.transport.closeStdin().catch(() => {});
		await this.transport.kill().catch(() => {});
	}
}
