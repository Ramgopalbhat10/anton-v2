import { randomUUID } from 'node:crypto';
import { type App, type Image, ModalClient, type Sandbox } from 'modal';
import type { Acquired, AcquireRequest, ExecOptions, ExecResult, Machine, MachineOrigin, Pty, SandboxProvider, SandboxResources } from '../../core/ports.ts';
import { quote } from '../../core/shell.ts';

export type ModalOptions = {
	app: string;
	baseImage: string;
	/** Installed into every new image so the agent's screenshot tool starts fast. */
	browserPackage: string;
};

type State = { sandboxId: string };

const ROOT = '/workspace';
const TAG = 'anton-task';
/** Toolchain every task gets. The image is cached by Modal after the first build. */
const toolchain = (browserPackage: string) => [
	'RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep python3 python3-pip python3-venv ca-certificates procps less && rm -rf /var/lib/apt/lists/*',
	'RUN command -v corepack >/dev/null && corepack enable || true',
	// Images without Node skip the browser; the screenshot tool then says what is missing.
	`RUN command -v npm >/dev/null && npm install -g ${browserPackage} && playwright install --with-deps chromium || true`,
	`RUN mkdir -p ${ROOT}/outputs`,
];

/**
 * One Modal sandbox per task. A stopped task comes back from the exit
 * snapshot Modal takes when its sandbox ends, so nothing is lost to the
 * idle timeout.
 */
export function modalSandboxProvider(options: ModalOptions): SandboxProvider {
	const client = new ModalClient();
	let app: Promise<App> | undefined;
	const appRef = () => (app ??= client.apps.fromName(options.app, { createIfMissing: true }));
	const nameFor = (key: string) => `task-${key}`;

	async function create(key: string, image: Image, ports: number[], resources: SandboxResources): Promise<Sandbox> {
		return client.sandboxes.create(await appRef(), image, {
			encryptedPorts: ports,
			name: nameFor(key),
			tags: { [TAG]: key },
			workdir: ROOT,
			timeoutMs: resources.lifetimeMs,
			idleTimeoutMs: resources.idleTimeoutMs,
			cpu: resources.cpu,
			memoryMiB: resources.memoryMiB,
			...(resources.regions.length ? { regions: resources.regions } : {}),
			...(resources.allowedDomains.length ? { outboundDomainAllowlist: resources.allowedDomains } : {}),
			experimentalOptions: { enable_exit_snapshot: true },
		});
	}

	async function findRunning(key: string): Promise<Sandbox | null> {
		const sandbox = await client.sandboxes.fromName(options.app, nameFor(key)).catch(() => null);
		return sandbox && (await sandbox.poll()) === null ? sandbox : null;
	}

	async function exitImage(state: State | null): Promise<Image | null> {
		if (!state) return null;
		const previous = await client.sandboxes.fromId(state.sandboxId).catch(() => null);
		return previous?.experimentalGetExitSnapshot({ timeoutMs: 120_000 }).catch(() => null) ?? null;
	}

	/** Where a new sandbox starts from, best first: the task's own last state, a prepared image, the toolchain. */
	async function startingImage(state: State | null, request: AcquireRequest): Promise<[Image, MachineOrigin]> {
		const resumed = await exitImage(state);
		if (resumed) return [resumed, 'resumed'];
		if (request.image) return [await client.images.fromId(request.image), 'image'];
		const base = client.images.fromRegistry(request.baseImage ?? options.baseImage);
		return [base.dockerfileCommands(toolchain(options.browserPackage)), 'base'];
	}

	function acquired(sandbox: Sandbox, origin: MachineOrigin): Acquired {
		return { machine: modalMachine(sandbox), origin, state: JSON.stringify({ sandboxId: sandbox.sandboxId } satisfies State) };
	}

	return {
		name: 'modal',
		async acquire(request) {
			const running = await findRunning(request.key);
			if (running) return acquired(running, 'live');
			const [startImage, origin] = await startingImage(request.state ? (JSON.parse(request.state) as State) : null, request);
			return acquired(await create(request.key, startImage, request.ports, request.resources), origin);
		},
		async find(key) {
			const running = await findRunning(key);
			return running && modalMachine(running);
		},
		async running() {
			const keys = new Set<string>();
			for await (const sandbox of client.sandboxes.list({ appId: (await appRef()).appId })) {
				const tags = await sandbox.getTags().catch(() => ({}) as Record<string, string>);
				if (tags[TAG]) keys.add(tags[TAG]);
			}
			return keys;
		},
		async stop(state) {
			const { sandboxId } = JSON.parse(state) as State;
			const sandbox = await client.sandboxes.fromId(sandboxId).catch(() => null);
			// Wait for shutdown, so a stopped task never reads as running.
			await sandbox?.terminate({ wait: true });
		},
		async snapshot(machine) {
			// A machine's id is its sandbox id, so wrapped machines snapshot too.
			const sandbox = await client.sandboxes.fromId(machine.id);
			const image = await sandbox.snapshotFilesystem({ timeoutMs: 300_000, ttlMs: null });
			return image.imageId;
		},
	};
}

/**
 * How long the output may stay quiet after the shell exits before Anton stops
 * waiting for it: a server started in the background holds the stream open
 * forever, while a large file still streaming keeps arriving.
 */
const OUTPUT_GRACE_MS = 1000;

/** Reads a stream as it arrives; `settle` waits briefly for the end, then keeps what came. */
function collect(stream: ReadableStream<Uint8Array>): { settle: () => Promise<Uint8Array> } {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let lastChunkAt = Date.now();
	let finished = false;
	const done = (async () => {
		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			chunks.push(next.value);
			lastChunkAt = Date.now();
		}
	})()
		.catch(() => undefined)
		.finally(() => (finished = true));
	return {
		async settle() {
			const settleFrom = Date.now();
			while (!finished && Date.now() - Math.max(lastChunkAt, settleFrom) < OUTPUT_GRACE_MS) {
				const wait = OUTPUT_GRACE_MS - (Date.now() - Math.max(lastChunkAt, settleFrom));
				await Promise.race([done, new Promise((resolve) => setTimeout(resolve, Math.max(wait, 10)))]);
			}
			if (!finished) void reader.cancel().catch(() => undefined);
			return new Uint8Array(Buffer.concat(chunks));
		},
	};
}

const EXEC_TAG = 'ANTON_EXEC';

/** Modal cannot cancel an exec, so a stopped command's processes are found by their tag and killed. */
async function killTagged(sandbox: Sandbox, tag: string): Promise<void> {
	const script = `for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -qx ${EXEC_TAG}=${tag} && kill -KILL "\${p#/proc/}"; done`;
	await sandbox
		.exec(['bash', '-c', script])
		.then((process) => process.wait())
		.catch(() => undefined);
}

function modalMachine(sandbox: Sandbox): Machine {
	return {
		id: sandbox.sandboxId,
		root: ROOT,
		async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
			// Every process the command starts inherits the tag, so Stop can find and end them all.
			const tag = randomUUID();
			const process = await sandbox.exec(['bash', '-lc', command], {
				mode: 'binary',
				stdout: 'pipe',
				stderr: 'pipe',
				workdir: options.cwd,
				env: { ...options.env, [EXEC_TAG]: tag },
				timeoutMs: options.timeoutMs,
			});
			const stop = () => void killTagged(sandbox, tag);
			if (options.signal?.aborted) stop();
			options.signal?.addEventListener('abort', stop, { once: true });
			try {
				// Closing the stream sends EOF after the bytes written; closeStdin() would send it at offset 0.
				const stdin = process.stdin.getWriter();
				if (options.stdin) await stdin.write(options.stdin);
				await stdin.close();
				const out = collect(process.stdout);
				const err = collect(process.stderr);
				const exitCode = await process.wait();
				const [stdout, stderr] = await Promise.all([out.settle(), err.settle()]);
				return { stdout, stderr: new TextDecoder().decode(stderr), exitCode };
			} finally {
				options.signal?.removeEventListener('abort', stop);
			}
		},
		async previewUrl(port) {
			const tunnels = await sandbox.tunnels(10_000).catch(() => ({}) as Record<number, { url: string }>);
			return tunnels[port]?.url ?? null;
		},
		async openPty({ cols, rows, cwd, env }): Promise<Pty> {
			const ttyFile = `/tmp/anton-tty-${randomUUID()}`;
			const process = await sandbox.exec(['bash', '-c', `tty > ${ttyFile}; cd ${quote(cwd)}; exec bash -l`], {
				env,
				pty: true,
				mode: 'binary',
				stdout: 'pipe',
			});
			const writer = process.stdin.getWriter();
			const exitListeners: Array<() => void> = [];
			const resize = async (c: number, r: number) => {
				await sandbox.exec(['bash', '-c', `test -f ${ttyFile} && stty -F "$(cat ${ttyFile})" rows ${r} cols ${c}`]);
			};
			void process.wait().finally(() => exitListeners.forEach((listener) => listener()));
			await resize(cols, rows).catch(() => undefined);
			return {
				write: (data) => void writer.write(data).catch(() => undefined),
				resize,
				onData(listener) {
					void (async () => {
						for await (const chunk of process.stdout as AsyncIterable<Uint8Array>) listener(chunk);
					})().catch(() => undefined);
				},
				onExit: (listener) => exitListeners.push(listener),
				// A program in the foreground (a dev server, an editor) would swallow `exit`, so hang up everything on the terminal.
				close: () => {
					void writer.write(new TextEncoder().encode('\u0004exit\n')).catch(() => undefined);
					void sandbox
						.exec(['bash', '-c', `t=$(cat ${ttyFile} 2>/dev/null) && for p in /proc/[0-9]*; do [ "$(readlink $p/fd/0 2>/dev/null)" = "$t" ] && kill -HUP "\${p#/proc/}"; done; rm -f ${ttyFile}`])
						.catch(() => undefined);
				},
			};
		},
	};
}
