// The vendor CLI on this host: its own login flow writes credentials.toml,
// Anton reads the key for per-session _meta.api_key auth — the file is the only
// store, and ACP sidecars never see it (devin acp ignores stored creds by design,
// verified: authenticate alone opens session/new with an empty data dir).

import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../config.ts';
import type { RuntimeSignIn, SubscriptionModel } from '../../core/ports.ts';
import { AcpClient, INITIALIZE, type AcpTransport } from './client.ts';
import { authParams, type AcpAccount, type AcpAgent, type ConfigOption, type SessionInfo } from './runtime.ts';

const tomlValue = (text: string, key: string): string | null => {
	const match = new RegExp(`${key}\\s*=\\s*["']([^"']+)["']`).exec(text);
	return match?.[1] ?? null;
};

const credentialPath = (agent: AcpAgent) => {
	const file = agent.auth.credentialFile;
	return file.startsWith('~/') ? join(homedir(), file.slice(2)) : file;
};

const cliProbes = new Map<string, Promise<boolean>>();
/** Whether the agent's CLI answers `--version` on this host; a miss is retried next call since the CLI may have been installed since. */
export function localCli(agent: AcpAgent): Promise<boolean> {
	const bin = agent.command[0];
	let probe = cliProbes.get(bin);
	if (!probe) {
		probe = new Promise<boolean>((resolve) => {
			const proc = spawn(bin, ['--version'], { stdio: 'ignore' });
			const timer = setTimeout(() => {
				proc.kill();
				resolve(false);
			}, 10_000);
			proc.on('error', () => {
				clearTimeout(timer);
				resolve(false);
			});
			proc.on('exit', (code) => {
				clearTimeout(timer);
				resolve(code === 0);
			});
		});
		cliProbes.set(bin, probe);
	}
	return probe.then((ok) => {
		if (!ok) cliProbes.delete(bin);
		return ok;
	});
}

const INSTALL_RETRY_MS = 5 * 60_000;
const installs = new Map<string, Promise<boolean>>();
const installAttempts = new Map<string, { at: number; ok: boolean; error?: string }>();

/** This host in vendor platform terms ('linux/arm64', 'darwin/x64'…), or null where no CLI build exists. */
export function hostPlatform(): string | null {
	return (hostPlatformCache ??= computeHostPlatform());
}
let hostPlatformCache: string | null | undefined;
function computeHostPlatform(): string | null {
	const platform = `${process.platform}/${process.arch}`;
	if (!['linux/x64', 'linux/arm64', 'darwin/x64', 'darwin/arm64'].includes(platform)) return null;
	// The vendors' linux builds are gnu-linked; musl hosts (Alpine) cannot run them.
	if (process.platform === 'linux') {
		const glibc = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
		if (!glibc) return null;
	}
	return platform;
}

/** Why a missing CLI cannot be auto-installed on this host, for status and error messages. */
export function cliInstallGap(agent: AcpAgent): string | null {
	if (hostPlatform() || !agent.install) return null;
	return 'auto-install covers linux/x64, linux/arm64 and macOS; install the CLI manually on this host';
}

/** Whether this host can fetch the agent's CLI itself — the vendors publish builds for the POSIX desktop/server arches. */
export const canInstallCli = (agent: AcpAgent) => Boolean(agent.install) && hostPlatform() !== null;

const installError = (agent: AcpAgent) => installAttempts.get(agent.id)?.error;

/**
 * Make the agent's CLI runnable here: already on PATH, installed under the data
 * dir by a previous run, or fetched now from the vendor's own release. Never
 * throws; the failure reason lands in installError() for the caller's message.
 */
export async function ensureCli(agent: AcpAgent, dir = join(config.dataDir, 'bin'), platform = hostPlatform()): Promise<boolean> {
	const [bin] = agent.command;
	if (bin.includes('/')) return localCli(agent);
	if (await localCli(agent)) return true;
	const install = agent.install;
	if (!install || !platform) return false;
	const last = installAttempts.get(agent.id);
	if (last && Date.now() - last.at < INSTALL_RETRY_MS) return last.ok;
	let pending = installs.get(agent.id);
	if (!pending) {
		pending = (async () => {
			let error: string | undefined;
			try {
				await mkdir(dir, { recursive: true });
				const have = await access(join(dir, bin), constants.X_OK).then(
					() => true,
					() => false,
				);
				if (!have) {
					const release = (await agent.release?.latest(platform).catch(() => null)) ?? install.fallback(platform);
					if (!release) throw new Error(`the vendor ships no ${agent.name} build for ${platform}`);
					await install.fetch(release, dir);
				}
				// Every spawn site resolves the bare command name through PATH: the login
				// PTY's shell string, the ACP probe, `models list`, sign-out.
				if (!process.env.PATH?.split(':').includes(dir)) process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			const ok = error ? false : await localCli(agent);
			installAttempts.set(agent.id, { at: Date.now(), ok, error: error ?? (ok ? undefined : 'the installed binary does not run') });
			return ok;
		})().finally(() => installs.delete(agent.id));
		installs.set(agent.id, pending);
	}
	return pending;
}

const cliMissing = (agent: AcpAgent) => {
	const why = installError(agent) ?? cliInstallGap(agent) ?? undefined;
	return new Error(`${agent.name} CLI is not installed on this server${why ? ` (${why})` : ''}`);
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
	if (agent.auth.kind === 'token-file') return text.trim() || null;
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
function loginSpawn(loginCommand: string[]): ReturnType<typeof spawn> {
	const [cmd, ...rest] = loginCommand;
	const argv =
		process.platform === 'darwin'
			? ['-q', '/dev/null', cmd, ...rest]
			: ['-qefc', [cmd, ...rest].join(' '), '/dev/null'];
	return spawn('script', argv, { stdio: 'pipe' });
}

export async function localSignIn(agent: AcpAgent): Promise<RuntimeSignIn> {
	const auth = agent.auth;
	if (auth.kind === 'token-file') return auth.login();
	if (!(await ensureCli(agent))) throw cliMissing(agent);
	const proc = loginSpawn(auth.loginCommand);
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
			const match = auth.loginUrl.exec(buf);
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
	const [cmd, ...rest] = (agent.auth.kind === 'cli' && agent.auth.logoutCommand) || [];
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
	if (agent.auth.kind === 'token-file') await agent.auth.logout();
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
async function probeConfigOptions(agent: AcpAgent, token: string): Promise<SessionInfo> {
	const dir = await mkdtemp(join(tmpdir(), 'anton-acp-'));
	const argv = agent.probeCommand ? agent.probeCommand(dir) : agent.command;
	const proc = spawn(argv[0], argv.slice(1), {
		stdio: 'pipe',
		env: { ...process.env, XDG_DATA_HOME: dir, ...agent.probeEnv?.(dir) },
	});
	try {
		await agent.probeSeed?.(token, dir);
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
				INITIALIZE,
				90_000,
			);
			await acp.request('authenticate', authParams(agent.auth, token), 90_000);
			return (await acp.request('session/new', { cwd: dir, mcpServers: [] }, 90_000)) as SessionInfo;
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
	if (!(await ensureCli(agent))) throw cliMissing(agent);
	const session = await probeConfigOptions(agent, token);
	const option = session.configOptions?.find((o) => (o.id ?? o.configId) === agent.modelConfigId);
	const choices = (option?.options ?? []).filter((o) => typeof o.value === 'string' && o.value);
	const catalog = await runCatalog(agent);
	return choices.map(
		(o): SubscriptionModel => {
			const value = String(o.value);
			const entry = catalog.get(value);
			const extra = agent.modelInfo?.(value, session) ?? {};
			return {
				id: `${agent.gateway}/${o.value}`,
				name: o.name ?? value,
				vendor: agent.name,
				description: o.description ?? '',
				createdAt: 0,
				contextLength: entry?.contextLength || 200_000,
				maxOutput: null,
				vision: agent.modelMetaImages ? o._meta?.[agent.modelMetaImages] === true : true,
				reasoning: [],
				defaultReasoning: 'off',
				...extra,
				listPrice: entry?.listPrice ?? null,
			};
		},
	);
}

/** How long a sign-in status answer is reused; Settings polls it. */
const STATUS_TTL_MS = 30_000;

/**
 * The account side of an ACP agent, all on this host: the vendor CLI's sign-in, the credential file, model probing
 * and plan windows. Nothing here touches compute, so Settings never starts or keeps alive a container.
 */
export function localAccount(agent: AcpAgent): AcpAccount {
	let statusCache: { at: number; result: Promise<{ signedIn: boolean; problem: string | null }> } | null = null;
	// The file only changes through our own sign-in/out, so one read serves until then.
	let credCache: string | null | undefined;
	const forget = () => {
		statusCache = null;
		credCache = undefined;
	};
	return {
		signedIn: () => {
			if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.result;
			const result = (async () => {
				const [cred, cli] = await Promise.all([localCredential(agent), localCli(agent)]);
				// Status stays cheap: the CLI fetches itself lazily inside sign-in/model
				// listing; warming it here keeps that wait short. ensureCli never throws.
				if (!cli && canInstallCli(agent)) void ensureCli(agent).catch(() => undefined);
				const gap = cliInstallGap(agent);
				const problem = cli
					? null
					: canInstallCli(agent)
						? `${agent.name} CLI is not installed on this server — it will be fetched on first use`
						: gap
							? `${agent.name} CLI is not installed on this server (${gap})`
							: `${agent.name} CLI is not installed on this server${cred ? '; model lists cannot refresh' : ''}`;
				return { signedIn: Boolean(cred), problem };
			})().catch((error) => ({
				signedIn: false,
				problem: `Could not check ${agent.name} sign-in: ${error instanceof Error ? error.message : String(error)}`,
			}));
			statusCache = { at: Date.now(), result };
			return result;
		},
		credential: async () => {
			if (credCache === undefined) credCache = await localCredential(agent);
			return credCache;
		},
		signIn: async () => {
			const signIn = await localSignIn(agent);
			return {
				url: signIn.url,
				complete: async (code) => {
					await signIn.complete(code);
					forget();
				},
				cancel: () => signIn.cancel(),
			};
		},
		signOut: async () => {
			await localSignOut(agent);
			forget();
		},
		listModels: () => localListModels(agent),
		...(agent.windows ? { windows: () => agent.windows!() } : {}),
	};
}
