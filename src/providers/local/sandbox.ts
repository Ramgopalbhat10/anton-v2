import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Acquired, ExecOptions, ExecResult, Machine, MachineOrigin, Pty, SandboxProvider } from '../../core/ports.ts';
import { quote } from '../../core/shell.ts';
import { runProcess } from '../shell-process.ts';

const RUNNING_MARKER = '.anton-running';

/**
 * Commits are pushed by recreating them through the git host's API, which
 * cannot carry a signature, so a signing setup in this computer's git config
 * stays off for tasks.
 */
const UNSIGNED = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'tag.gpgsign', GIT_CONFIG_VALUE_1: 'false' };

/**
 * Only what a shell needs; host secrets never reach a task. Machines share this
 * computer's network, so a task's desktop listens on this computer alone.
 */
function shellEnv(extra: Record<string, string> = {}): Record<string, string> {
	const pick = (name: string) => (process.env[name] ? { [name]: process.env[name] as string } : {});
	return { ...pick('PATH'), ...pick('HOME'), ...pick('LANG'), TERM: 'xterm-256color', ANTON_SCREEN_BIND: '127.0.0.1', ...UNSIGNED, ...extra };
}

/**
 * Runs each task in its own folder on this computer. No isolation: it is
 * for development and tests, where Modal is not wanted.
 */
export function localSandboxProvider(dataDir: string): SandboxProvider {
	const machinesDir = path.join(dataDir, 'machines');
	const imagesDir = path.join(dataDir, 'images');
	const exists = (target: string) => stat(target).then(() => true, () => false);

	async function prepare(key: string, state: string | null, image: string | null): Promise<MachineOrigin> {
		const root = path.join(machinesDir, key);
		if (await exists(path.join(root, RUNNING_MARKER))) return 'live';
		if (state && (await exists(root))) return 'resumed';
		await rm(root, { recursive: true, force: true });
		if (image) {
			await cp(path.join(imagesDir, image), root, { recursive: true, verbatimSymlinks: true });
			return 'image';
		}
		await mkdir(path.join(root, 'outputs'), { recursive: true });
		return 'base';
	}

	return {
		name: 'local',
		async acquire({ key, state, image }): Promise<Acquired> {
			const origin = await prepare(key, state, image);
			const root = path.join(machinesDir, key);
			await writeFile(path.join(root, RUNNING_MARKER), '');
			return { machine: localMachine(root), origin, state: JSON.stringify({ key }) };
		},
		async find(key) {
			const root = path.join(machinesDir, key);
			return (await exists(path.join(root, RUNNING_MARKER))) ? localMachine(root) : null;
		},
		async running() {
			const keys = await readdir(machinesDir).catch(() => [] as string[]);
			const live = await Promise.all(keys.map((key) => exists(path.join(machinesDir, key, RUNNING_MARKER))));
			return new Set(keys.filter((_, index) => live[index]));
		},
		async stop(state) {
			const { key } = JSON.parse(state) as { key: string };
			await rm(path.join(machinesDir, key, RUNNING_MARKER), { force: true });
		},
		async snapshot(machine) {
			const id = randomUUID();
			await cp(machine.root, path.join(imagesDir, id), {
				recursive: true,
				verbatimSymlinks: true,
				filter: (source) => !source.endsWith(RUNNING_MARKER),
			});
			return id;
		},
	};
}

function localMachine(root: string): Machine {
	return {
		id: `local:${path.basename(root)}`,
		root,
		exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
			return runProcess('bash', ['-lc', command], { ...options, cwd: options.cwd ?? root, env: shellEnv(options.env) });
		},
		/** Dev servers in a local task listen on this computer. */
		previewUrl: async (port) => `http://localhost:${port}`,
		// Only the browser on this computer reaches it: the desktop listens on this computer's own address (ANTON_SCREEN_BIND).
		socketUrl: async (port) => `ws://localhost:${port}`,
		async openPty({ cols, rows, cwd, env }): Promise<Pty> {
			const ttyFile = path.join(root, `.anton-tty-${randomUUID()}`);
			const child = spawn('script', ['-qfc', `tty > ${quote(ttyFile)}; cd ${quote(cwd)}; exec bash -l`, '/dev/null'], {
				env: shellEnv(env),
			});
			const resize = async (c: number, r: number) => {
				await this.exec(`test -f ${quote(ttyFile)} && stty -F "$(cat ${quote(ttyFile)})" rows ${r} cols ${c}`);
			};
			child.on('exit', () => void rm(ttyFile, { force: true }));
			setTimeout(() => void resize(cols, rows).catch(() => undefined), 200);
			return {
				write: (data) => void child.stdin.write(data),
				resize,
				onData: (listener) => child.stdout.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk))),
				onExit: (listener) => child.on('exit', listener),
				close: () => child.kill(),
			};
		},
	};
}
