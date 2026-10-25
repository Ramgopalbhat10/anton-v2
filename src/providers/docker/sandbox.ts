import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Acquired, ExecOptions, ExecResult, Machine, Pty, SandboxProvider, SandboxResources } from '../../core/ports.ts';
import { quote } from '../../core/shell.ts';
import { runProcess } from '../shell-process.ts';

export type DockerOptions = { baseImage: string; docker?: string };

type State = { key: string };

const ROOT = '/workspace';
const LABEL = 'anton.task';
/** Commits are pushed by recreating them through the git host's API, which cannot carry a signature. */
const UNSIGNED = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'tag.gpgsign', GIT_CONFIG_VALUE_1: 'false' };
/** What a fresh machine gets on top of its image: nothing is installed, so a task runs on the image as it is (search falls back to grep without ripgrep). */
const TOOLCHAIN = `mkdir -p ${ROOT}/outputs`;

/**
 * One Docker container per task on this computer, from the task's base image
 * (Settings › Sandboxes, or the project's own), so a task runs in the image
 * a repository needs, isolated from this computer's files. A stopped task's
 * container is kept and started again; a snapshot is a committed image.
 * Previews are published on this computer's own address.
 */
export function dockerSandboxProvider(options: DockerOptions): SandboxProvider {
	const bin = options.docker ?? 'docker';
	const docker = (args: string[], stdin?: Uint8Array) => runProcess(bin, args, { env: process.env as Record<string, string>, stdin });
	const text = (result: ExecResult) => new TextDecoder().decode(result.stdout).trim();
	const nameFor = (key: string) => `anton-${key}`;

	async function must(args: string[]): Promise<string> {
		const result = await docker(args);
		if (result.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
		return text(result);
	}

	/** Whether the task's container is running, stopped, or not there. */
	async function status(key: string): Promise<'running' | 'stopped' | null> {
		const result = await docker(['inspect', '-f', '{{.State.Running}}', nameFor(key)]);
		if (result.exitCode !== 0) return null;
		return text(result) === 'true' ? 'running' : 'stopped';
	}

	async function create(key: string, image: string, ports: number[], resources: SandboxResources): Promise<void> {
		await docker(['rm', '-f', nameFor(key)]);
		if ((await docker(['image', 'inspect', image])).exitCode !== 0) await must(['pull', '-q', image]);
		await must([
			// Docker makes the working directory when the image has none.
			'run', '-d', '--name', nameFor(key), '--label', `${LABEL}=${key}`, '-w', ROOT,
			'--cpus', String(resources.cpu), '--memory', `${resources.memoryMiB}m`,
			...ports.flatMap((port) => ['-p', `127.0.0.1::${port}`]),
			'--entrypoint', 'sleep', image, 'infinity',
		]);
	}

	const acquired = (key: string, origin: Acquired['origin']): Acquired => ({ machine: dockerMachine(bin, nameFor(key)), origin, state: JSON.stringify({ key } satisfies State) });

	return {
		name: 'docker',
		async acquire({ key, state, image, baseImage, ports, resources }) {
			const now = await status(key);
			if (now === 'running') return acquired(key, 'live');
			if (now === 'stopped' && state) {
				await must(['start', nameFor(key)]);
				return acquired(key, 'resumed');
			}
			await create(key, image ?? baseImage ?? options.baseImage, ports, resources);
			const ready = acquired(key, image ? 'image' : 'base');
			if (!image) await ready.machine.exec(TOOLCHAIN, { timeoutMs: 300_000 });
			return ready;
		},
		async find(key) {
			return (await status(key)) === 'running' ? dockerMachine(bin, nameFor(key)) : null;
		},
		async running() {
			const listed = await docker(['ps', '--filter', `label=${LABEL}`, '--format', `{{.Label "${LABEL}"}}`]);
			return new Set(text(listed).split('\n').filter(Boolean));
		},
		async stop(state) {
			const { key } = JSON.parse(state) as State;
			// Kept, not removed, so the task resumes with its files.
			await docker(['stop', '-t', '2', nameFor(key)]);
		},
		async snapshot(machine) {
			const tag = `anton-image:${randomUUID()}`;
			await must(['commit', machine.id.replace(/^docker:/, ''), tag]);
			return tag;
		},
	};
}

function dockerMachine(bin: string, container: string): Machine {
	const envArgs = (env: Record<string, string>) => Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
	const published = async (port: number) => {
		const result = await runProcess(bin, ['port', container, `${port}/tcp`], { env: process.env as Record<string, string> });
		const address = new TextDecoder().decode(result.stdout).split('\n')[0]?.trim();
		return result.exitCode === 0 && address ? address.slice(address.lastIndexOf(':') + 1) : null;
	};
	return {
		id: `docker:${container}`,
		root: ROOT,
		exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
			const env = { TERM: 'xterm-256color', ...UNSIGNED, ...options.env };
			const args = ['exec', '-i', '-w', options.cwd ?? ROOT, ...envArgs(env), container, 'bash', '-lc', command];
			return runProcess(bin, args, { env: process.env as Record<string, string>, stdin: options.stdin, signal: options.signal, timeoutMs: options.timeoutMs });
		},
		previewUrl: async (port) => {
			const host = await published(port);
			return host && `http://localhost:${host}`;
		},
		socketUrl: async (port) => {
			const host = await published(port);
			return host && `ws://localhost:${host}`;
		},
		async openPty({ cols, rows, cwd, env }): Promise<Pty> {
			// `docker exec -t` passes the size of the terminal it runs in on to the container's.
			const dir = await mkdtemp(path.join(os.tmpdir(), 'anton-pty-'));
			const ttyFile = path.join(dir, 'tty');
			const inner = [bin, 'exec', '-it', '-w', cwd, ...envArgs({ TERM: 'xterm-256color', ...UNSIGNED, ...env }), container, 'bash', '-l'].map(quote).join(' ');
			const child = spawn('script', ['-qfc', `tty > ${quote(ttyFile)}; exec ${inner}`, '/dev/null'], { env: process.env });
			const resize = async (c: number, r: number) => {
				await runProcess('bash', ['-c', `test -f ${quote(ttyFile)} && stty -F "$(cat ${quote(ttyFile)})" rows ${r} cols ${c}`], { env: process.env as Record<string, string> });
			};
			child.on('exit', () => void rm(dir, { recursive: true, force: true }));
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
