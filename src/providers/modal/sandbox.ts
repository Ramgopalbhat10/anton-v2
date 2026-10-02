import { randomUUID } from 'node:crypto';
import { type App, type Image, ModalClient, type Sandbox } from 'modal';
import type { Acquired, ExecOptions, ExecResult, Machine, MachineOrigin, Pty, SandboxProvider } from '../../core/ports.ts';
import { quote } from '../../core/shell.ts';

export type ModalOptions = {
	app: string;
	baseImage: string;
	idleTimeoutMs: number;
	cpu: number;
	memoryMiB: number;
};

type State = { sandboxId: string };

const ROOT = '/workspace';
const TAG = 'anton-task';
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Toolchain every task gets. The image is cached by Modal after the first build. */
const TOOLCHAIN = [
	'RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep python3 python3-pip python3-venv ca-certificates procps less && rm -rf /var/lib/apt/lists/*',
	'RUN corepack enable',
	`RUN mkdir -p ${ROOT}/outputs`,
];

/**
 * One Modal sandbox per task. A stopped task comes back from the exit
 * snapshot Modal takes when its sandbox ends, so nothing is lost to the
 * idle timeout.
 */
export function modalSandboxProvider(options: ModalOptions): SandboxProvider {
	const client = new ModalClient();
	const sandboxes = new WeakMap<Machine, Sandbox>();
	let app: Promise<App> | undefined;
	const appRef = () => (app ??= client.apps.fromName(options.app, { createIfMissing: true }));
	const nameFor = (key: string) => `task-${key}`;

	async function create(key: string, image: Image): Promise<Sandbox> {
		return client.sandboxes.create(await appRef(), image, {
			name: nameFor(key),
			tags: { [TAG]: key },
			workdir: ROOT,
			timeoutMs: MAX_LIFETIME_MS,
			idleTimeoutMs: options.idleTimeoutMs,
			cpu: options.cpu,
			memoryMiB: options.memoryMiB,
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
	async function startingImage(state: State | null, image: string | null): Promise<[Image, MachineOrigin]> {
		const resumed = await exitImage(state);
		if (resumed) return [resumed, 'resumed'];
		if (image) return [await client.images.fromId(image), 'image'];
		return [client.images.fromRegistry(options.baseImage).dockerfileCommands(TOOLCHAIN), 'base'];
	}

	function remember(sandbox: Sandbox): Machine {
		const machine = modalMachine(sandbox);
		sandboxes.set(machine, sandbox);
		return machine;
	}

	function acquired(sandbox: Sandbox, origin: MachineOrigin): Acquired {
		return { machine: remember(sandbox), origin, state: JSON.stringify({ sandboxId: sandbox.sandboxId } satisfies State) };
	}

	return {
		name: 'modal',
		async acquire({ key, state, image }) {
			const running = await findRunning(key);
			if (running) return acquired(running, 'live');
			const [startImage, origin] = await startingImage(state ? (JSON.parse(state) as State) : null, image);
			return acquired(await create(key, startImage), origin);
		},
		async find(key) {
			const running = await findRunning(key);
			return running && remember(running);
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
			const sandbox = sandboxes.get(machine);
			if (!sandbox) throw new Error('Unknown machine');
			const image = await sandbox.snapshotFilesystem({ timeoutMs: 300_000, ttlMs: null });
			return image.imageId;
		},
	};
}

function modalMachine(sandbox: Sandbox): Machine {
	return {
		id: sandbox.sandboxId,
		root: ROOT,
		async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
			const process = await sandbox.exec(['bash', '-lc', command], {
				mode: 'binary',
				stdout: 'pipe',
				stderr: 'pipe',
				workdir: options.cwd,
				env: options.env,
				timeoutMs: options.timeoutMs,
			});
			// Closing the stream sends EOF after the bytes written; closeStdin() would send it at offset 0.
			const stdin = process.stdin.getWriter();
			if (options.stdin) await stdin.write(options.stdin);
			await stdin.close();
			const [stdout, stderr, exitCode] = await Promise.all([
				process.stdout.readBytes(),
				process.stderr.readBytes(),
				process.wait(),
			]);
			return { stdout, stderr: new TextDecoder().decode(stderr), exitCode };
		},
		async openPty({ cols, rows, cwd }): Promise<Pty> {
			const ttyFile = `/tmp/anton-tty-${randomUUID()}`;
			const process = await sandbox.exec(['bash', '-c', `tty > ${ttyFile}; cd ${quote(cwd)}; exec bash -l`], {
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
