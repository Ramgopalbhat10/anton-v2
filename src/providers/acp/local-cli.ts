// The vendor CLI on this host: its own login flow writes credentials.toml,
// Anton reads the key for per-session _meta.api_key auth — the file is the only
// store, and ACP sidecars never see it (devin acp ignores stored creds by design,
// verified: authenticate alone opens session/new with an empty data dir).

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeSignIn, SubscriptionModel } from '../../core/ports.ts';
import { AcpClient, type AcpTransport } from './client.ts';
import type { AcpAgent, ConfigOption } from './runtime.ts';

const tomlValue = (text: string, key: string): string | null => {
	const match = new RegExp(`${key}\\s*=\\s*["']([^"']+)["']`).exec(text);
	return match?.[1] ?? null;
};

const credentialPath = (agent: AcpAgent) => {
	const file = agent.auth.credentialFile;
	return file.startsWith('~/') ? join(homedir(), file.slice(2)) : file;
};

/** The API key authenticate() takes; null when signed out. Missing file is signed out, other read errors throw. */
export async function localCredential(agent: AcpAgent): Promise<string | null> {
	let text: string;
	try {
		text = await readFile(credentialPath(agent), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	return tomlValue(text, agent.auth.credentialKey);
}

// PTY output carries terminal escapes; strip them so URL matching and error tails stay readable.
const plain = (text: string) =>
	text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
		.replace(/\x1b[\x20-\x7e]/g, '')
		.replace(/\r/g, '');

function childTail(proc: ChildProcess): () => string {
	let tail = '';
	const decoder = new TextDecoder();
	proc.stderr?.on('data', (chunk: Buffer) => {
		tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4096);
	});
	return () => tail.trim();
}

/**
 * The login prompt refuses a piped stdin, so it runs under script(1)'s PTY while
 * our pipes stay attached. Flags differ: util-linux takes -c "cmd", BSD/macOS
 * takes the command as argv after the typescript file.
 */
function loginSpawn(agent: AcpAgent): ReturnType<typeof spawn> {
	const [cmd, ...rest] = agent.auth.loginCommand;
	const argv =
		process.platform === 'darwin'
			? ['-q', '/dev/null', cmd, ...rest]
			: ['-qefc', [cmd, ...rest].join(' '), '/dev/null'];
	return spawn('script', argv, { stdio: 'pipe' });
}

export async function localSignIn(agent: AcpAgent): Promise<RuntimeSignIn> {
	const proc = loginSpawn(agent);
	const tail = childTail(proc);
	const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
	let buf = '';
	const diagnostics = () => plain(buf).slice(-400) || tail().slice(-400);
	// The login command prints its URL on stdout, then waits for the code on stdin.
	const url = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for the ${agent.name} sign-in URL`)), 60_000);
		const decoder = new TextDecoder();
		const scan = (chunk: string) => {
			buf = (buf + plain(chunk)).slice(-64_000);
			const match = agent.auth.loginUrl.exec(buf);
			if (match) {
				clearTimeout(timer);
				resolve(match[0]);
			}
		};
		proc.stdout?.on('data', (chunk: Buffer) => scan(decoder.decode(chunk, { stream: true })));
		proc.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		void exited.then((code) => {
			clearTimeout(timer);
			reject(new Error(`${agent.name} sign-in ended before showing a URL${diagnostics() ? `: ${diagnostics()}` : ''}${code === null ? '' : ` (exit ${code})`}`));
		});
	});
	return {
		url,
		complete: async (code) => {
			// \r is Enter on a PTY; \n would be a literal line-feed in raw mode.
			proc.stdin?.write(`${code}\r`);
			proc.stdin?.end();
			const exit = await exited;
			if (exit !== 0) throw new Error(`${agent.name} sign-in failed${diagnostics() ? `: ${diagnostics()}` : ''}`);
		},
		cancel: () => {
			proc.stdin?.end();
			proc.kill();
		},
	};
}

export async function localSignOut(agent: AcpAgent): Promise<void> {
	const [cmd, ...rest] = agent.auth.logoutCommand ?? [];
	if (cmd) {
		await new Promise<void>((resolve) => {
			const proc = spawn(cmd, rest, { stdio: 'ignore' });
			const timer = setTimeout(() => {
				proc.kill();
				resolve();
			}, 10_000);
			proc.on('exit', () => {
				clearTimeout(timer);
				resolve();
			});
			proc.on('error', () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
	await rm(credentialPath(agent), { force: true }).catch(() => undefined);
}

function localTransport(proc: ChildProcess): { transport: AcpTransport; tail: () => string } {
	const tail = childTail(proc);
	const decoder = new TextDecoder();
	return {
		tail,
		transport: {
			write: (data) => void proc.stdin?.write(data),
			lines: async function* () {
				for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) yield decoder.decode(chunk, { stream: true });
			},
			closeStdin: async () => {
				proc.stdin?.end();
			},
			kill: async () => {
				proc.kill();
			},
		},
	};
}

/** configOptions from a throwaway local `devin acp`; an isolated XDG dir keeps user MCP servers and creds out of the probe. */
async function probeConfigOptions(agent: AcpAgent, token: string): Promise<{ configOptions?: ConfigOption[] }> {
	const dir = await mkdtemp(join(tmpdir(), 'anton-acp-'));
	const proc = spawn(agent.command[0], agent.command.slice(1), {
		stdio: 'pipe',
		env: { ...process.env, XDG_DATA_HOME: dir },
	});
	try {
		const { transport, tail } = localTransport(proc);
		const acp = new AcpClient(transport, {});
		proc.on('error', (error) => {
			console.error(`[acp:${agent.id}] local probe failed to start: ${error.message}`);
			void acp.close();
		});
		acp.start();
		try {
			await acp.request(
				'initialize',
				{
					protocolVersion: 1,
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
					clientInfo: { name: 'anton', version: '1.0.0' },
				},
				90_000,
			);
			await acp.request('authenticate', { methodId: agent.auth.methodId, ...agent.auth.params(token) }, 90_000);
			return (await acp.request('session/new', { cwd: dir, mcpServers: [] }, 90_000)) as { configOptions?: ConfigOption[] };
		} finally {
			await acp.close();
			if (tail()) console.error(`[acp:${agent.id}] probe stderr: ${tail().slice(-300)}`);
		}
	} finally {
		proc.kill();
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function runCatalog(agent: AcpAgent): Promise<Map<string, { contextLength: number; listPrice: SubscriptionModel['listPrice'] }>> {
	if (!agent.catalog) return new Map();
	try {
		const text = await new Promise<string>((resolve, reject) => {
			const proc = spawn(agent.catalog!.command[0], agent.catalog!.command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
			let out = '';
			proc.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
			proc.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
			proc.on('error', reject);
		});
		return agent.catalog.parse(text);
	} catch {
		return new Map();
	}
}

export async function localListModels(agent: AcpAgent): Promise<SubscriptionModel[]> {
	const token = await localCredential(agent);
	if (!token) return [];
	const session = await probeConfigOptions(agent, token);
	const option = session.configOptions?.find((o) => (o.id ?? o.configId) === agent.modelConfigId);
	const choices = (option?.options ?? []).filter((o) => typeof o.value === 'string' && o.value);
	const catalog = await runCatalog(agent);
	return choices.map(
		(o): SubscriptionModel => {
			const entry = catalog.get(String(o.value));
			return {
				id: `${agent.gateway}/${o.value}`,
				name: o.name ?? String(o.value),
				vendor: agent.name,
				description: o.description ?? '',
				createdAt: 0,
				contextLength: entry?.contextLength || 200_000,
				maxOutput: null,
				vision: agent.modelMetaImages ? o._meta?.[agent.modelMetaImages] === true : true,
				reasoning: [],
				defaultReasoning: 'off',
				listPrice: entry?.listPrice ?? null,
			};
		},
	);
}
