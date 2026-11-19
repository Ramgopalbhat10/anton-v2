// Modal side of an AcpHost: one shared sandbox holds a lightweight
// credential sidecar (status, sign-out), an agent-image auth sidecar
// (sign-in, model probes), a small pool of warm conversation sidecars
// (container + linkd + agent execs pre-started) and one sidecar per
// live conversation.

import { randomUUID } from 'node:crypto';
import { type App, type ContainerProcess, type Image, ModalClient, type Sandbox, SandboxFilesystemNotFoundError, type SidecarContainer, type Volume } from 'modal';
import type { RuntimeSignIn, SubscriptionModel } from '../../core/ports.ts';
import { AcpClient, type AcpTransport } from './client.ts';
import type { AcpAgent, AcpHost, AcpProcess, AcpRelease } from './runtime.ts';
import { LINKD_SCRIPT, LINK_SCRIPT } from './sidecar-scripts.ts';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

// PTY output carries terminal escapes (OSC-8 hyperlinks wrap the sign-in URL, CSI
// cursor queries, bracketed paste); strip them so URL matching and error tails stay readable.
const plain = (text: string) =>
	text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
		.replace(/\x1b[\x20-\x7e]/g, '')
		.replace(/\r/g, '');

/** The anchor container does nothing but hold the sandbox; agents live in sidecars. */
const MAIN_IMAGE = 'debian:bookworm-slim';
const SANDBOX_CPU = 1;
const SANDBOX_MEMORY_MIB = 1024;
const SANDBOX_TIMEOUT_MS = 24 * 3_600_000;
const SANDBOX_IDLE_MS = 20 * 60_000;
const STATUS_TTL_MS = 30_000;
/** How often a running server re-asks the vendor for a newer agent build. */
const RELEASE_TTL_MS = 6 * 3_600_000;
/** Warm conversation slots kept ready; each is one sidecar plus its two long-lived execs. */
const POOL_SIZE = 2;
/** How long a claimed slot's execs get to prove they're still running before a cold spawn. */
const WARM_CHECK_MS = 400;
/** Pre-started agent execs are trusted only this long; older ones may be wedged and go stale. */
const WARM_MAX_AGE_MS = 10 * 60_000;

function stderrTail(proc: ContainerProcess<Uint8Array>): () => string {
	let tail = '';
	void (async () => {
		try {
			const decoder = new TextDecoder();
			for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
				tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4096);
			}
		} catch {
			// stderr is diagnostic only.
		}
	})();
	return () => tail.trim();
}

function execTransport(proc: ContainerProcess<Uint8Array>): { transport: AcpTransport; tail: () => string } {
	const writer = proc.stdin.getWriter();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const tail = stderrTail(proc);
	return {
		tail,
		transport: {
			write: (data) => void writer.write(encoder.encode(data)).catch(() => undefined),
			lines: async function* () {
				for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) yield decoder.decode(chunk, { stream: true });
			},
			closeStdin: async () => {
				try {
					await writer.close();
				} catch {
					// already closed
				}
			},
			// Modal has no per-process kill; the sidecar's terminate() ends every exec at once.
			kill: async () => undefined,
		},
	};
}

const tomlValue = (text: string, key: string): string | null => {
	const match = new RegExp(`${key}\\s*=\\s*["']([^"']+)["']`).exec(text);
	return match?.[1] ?? null;
};

export function modalAcpHost(agent: AcpAgent, appName: string): AcpHost {
	const client = new ModalClient();
	let app: Promise<App> | undefined;
	let volume: Promise<Volume> | undefined;
	let sandbox: Promise<Sandbox> | null = null;
	let imageFor: { key: string; promise: Promise<Image> } | null = null;
	let mainImage: Promise<Image> | null = null;
	let releaseCache: { at: number; value: Promise<AcpRelease | null> } | null = null;
	const sidecars = new Map<string, Promise<SidecarContainer>>();
	let sidecarSeq = 0;
	// Sandbox names must be unique per app; a reload or second server would collide with a live one.
	const sandboxName = `acp-${agent.id}-${randomUUID().slice(0, 8)}`;
	let statusCache: { at: number; result: Promise<{ signedIn: boolean; problem: string | null }> } | null = null;
	const credentialDir = agent.auth.credentialFile.slice(0, agent.auth.credentialFile.lastIndexOf('/'));

	const appRef = () => (app ??= client.apps.fromName(appName, { createIfMissing: true }));
	const unique = (prefix: string) => `${prefix}-${++sidecarSeq}-${randomUUID().slice(0, 8)}`;

	/** The agent's newest release, re-asked every RELEASE_TTL_MS; null keeps the descriptor's pinned build. */
	async function release(): Promise<AcpRelease | null> {
		if (!agent.release) return null;
		if (!releaseCache || Date.now() - releaseCache.at > RELEASE_TTL_MS) {
			releaseCache = { at: Date.now(), value: agent.release.latest().catch(() => null) };
		}
		return releaseCache.value;
	}

	/** The agent image for one release; a newer release rebuilds once and only new sidecars get it. */
	async function agentImage(): Promise<Image> {
		const rel = await release();
		const key = rel?.version ?? 'pinned';
		if (imageFor?.key === key) return imageFor.promise;
		const promise = (async () =>
			client.images
				.fromRegistry(agent.image.base)
				.dockerfileCommands([
					`RUN mkdir -p ${agent.workdir} ${agent.linkDir}`,
					`RUN echo ${b64(LINK_SCRIPT)} | base64 -d > ${agent.linkDir}/link.mjs`,
					`RUN echo ${b64(LINKD_SCRIPT)} | base64 -d > ${agent.linkDir}/linkd.mjs`,
					...agent.image.commands(rel),
					`WORKDIR ${agent.workdir}`,
				])
				.build(await appRef()))();
		imageFor = { key, promise };
		return promise;
	}

	function authVolume() {
		return (volume ??= client.volumes.fromName(`anton-acp-${agent.id}-auth`, { createIfMissing: true }));
	}

	// Sidecar create needs a built image; sandboxes.create resolves a registry ref itself.
	function anchorImage(): Promise<Image> {
		return (mainImage ??= (async () => client.images.fromRegistry(MAIN_IMAGE).build(await appRef()))());
	}

	async function mainSandbox(): Promise<Sandbox> {
		if (sandbox) {
			const live = await sandbox.then((s) => s.poll().then((code) => (code === null ? s : null))).catch(() => null);
			if (live) return live;
			sandbox = null;
			sidecars.clear();
		}
		sandbox = client.sandboxes.create(await appRef(), await anchorImage(), {
			name: sandboxName,
			command: ['sleep', 'infinity'],
			workdir: '/',
			cpu: SANDBOX_CPU,
			memoryMiB: SANDBOX_MEMORY_MIB,
			timeoutMs: SANDBOX_TIMEOUT_MS,
			idleTimeoutMs: SANDBOX_IDLE_MS,
			// The anchor container needs no network at all; sidecars get their own policy.
			outboundCidrAllowlist: [],
			tags: { 'anton-acp': agent.id },
		});
		return sandbox;
	}

	async function sidecarFor(name: string, image: Image, workdir: string, egress: string[] | null): Promise<SidecarContainer> {
		const sb = await mainSandbox();
		return sb.experimentalSidecars.create(name, image, {
			command: ['sleep', 'infinity'],
			workdir,
			// Credential reads need no network at all; agent sidecars get the vendor's domains only.
			...(egress ? { outboundDomainAllowlist: egress } : { outboundCidrAllowlist: [] }),
			volumes: { [credentialDir]: await authVolume() },
		});
	}

	/** A cached sidecar slot that rebuilds when its container died or its create failed. */
	function slot(key: string, make: () => Promise<SidecarContainer>): () => Promise<SidecarContainer> {
		return async () => {
			const current = sidecars.get(key);
			if (current) {
				try {
					const s = await current;
					if ((await s.poll()) === null) return s;
				} catch {
					// create failed; fall through to a fresh one
				}
			}
			const next = make();
			sidecars.set(key, next);
			return next;
		};
	}

	// debian-slim + the auth volume: reads credentials.toml, nothing else. No agent image, no egress.
	const cred = slot('cred', async () => sidecarFor(unique('cred'), await anchorImage(), '/', null));
	// The agent image: `devin auth login` and the `devin acp` model probe need the real binary.
	const agentAuth = slot('agent-auth', async () => sidecarFor(unique('agent-auth'), await agentImage(), agent.workdir, agent.egress));

	// ---- warm conversation pool -----------------------------------------
	// A warm slot is a sidecar with linkd and the agent already exec'd and idling.
	// One slot still serves exactly one conversation — claiming never shares it —
	// so per-conversation isolation is unchanged; only the startup is moved earlier.
	// Slots are pooled per model when the agent can preset one (devin acp --model):
	// that process defaults every session to it, so session/new skips set_config_option.
	// The '' pool holds model-agnostic slots — the fallback for models without a warm one.
	type WarmSlot = { sidecar: SidecarContainer; linkd: ContainerProcess<Uint8Array>; acp: ContainerProcess<Uint8Array>; createdAt: number };
	const pools = new Map<string, Promise<WarmSlot | null>[]>();
	/** The pool key of the most recent spawn; sign-in/status warm-up refills it. */
	let lastPoolKey = '';
	const MAX_WARM = POOL_SIZE * 2;

	const poolKey = (model?: string) => (model && agent.modelArgs ? model : '');
	const warmCount = () => [...pools.values()].reduce((n, pool) => n + pool.length, 0);

	async function warmSlot(model?: string): Promise<WarmSlot | null> {
		try {
			const sidecar = await sidecarFor(unique('warm'), await agentImage(), agent.workdir, agent.egress);
			// Same pair spawn() starts; the agent only reaches linkd on its first MCP call.
			const argv = model && agent.modelArgs ? [...agent.command, ...agent.modelArgs(model)] : agent.command;
			const [linkd, acp] = await Promise.all([
				execOn(sidecar, ['node', `${agent.linkDir}/linkd.mjs`, String(agent.linkPort)]),
				execOn(sidecar, argv),
			]);
			return { sidecar, linkd, acp, createdAt: Date.now() };
		} catch {
			return null;
		}
	}

	function refillWarm(key: string): void {
		let pool = pools.get(key);
		if (!pool) pools.set(key, (pool = []));
		while (pool.length < POOL_SIZE && warmCount() < MAX_WARM) pool.push(warmSlot(key || undefined));
	}

	const alive = (proc: ContainerProcess<Uint8Array>) =>
		Promise.race([
			proc.wait().then(
				() => false,
				() => false,
			),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(true), WARM_CHECK_MS)),
		]);

	/** The oldest live warm slot for the model, or null — dead slots are terminated and the caller spawns cold. */
	async function claimWarm(key: string): Promise<WarmSlot | null> {
		// Exact-model slots first; an agnostic one still works, it just pays set_config_option.
		for (const k of key === '' ? [''] : [key, '']) {
			const pool = pools.get(k);
			if (!pool) continue;
			for (const pending of pool.splice(0)) {
				const slot = await pending;
				if (!slot) continue;
				const fresh = Date.now() - slot.createdAt <= WARM_MAX_AGE_MS;
				if (fresh && (await Promise.all([alive(slot.linkd), alive(slot.acp)])).every(Boolean)) return slot;
				await slot.sidecar.terminate().catch(() => undefined);
			}
		}
		return null;
	}

	/** The vendor's own model catalog (context, list price) keyed by model id; empty when absent or failing. */
	async function modelCatalog(sidecar: SidecarContainer) {
		if (!agent.catalog) return new Map<string, { contextLength: number; listPrice: SubscriptionModel['listPrice'] }>();
		try {
			const proc = await execOn(sidecar, agent.catalog.command, { timeoutMs: 90_000 });
			const decoder = new TextDecoder();
			let text = '';
			for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
			await proc.wait();
			return agent.catalog.parse(text);
		} catch {
			return new Map<string, { contextLength: number; listPrice: SubscriptionModel['listPrice'] }>();
		}
	}

	async function readCredentialFile(): Promise<string | null> {
		try {
			const text = await (await cred()).filesystem.readText(agent.auth.credentialFile);
			return tomlValue(text, agent.auth.credentialKey);
		} catch (error) {
			// A missing file means signed out; anything else is an infrastructure problem worth surfacing.
			if (error instanceof SandboxFilesystemNotFoundError) return null;
			throw error;
		}
	}

	// The volume read costs ~1s per session setup; the file only changes through our own sign-in/out.
	let credCache: string | null | undefined;
	const credential = async () => {
		if (credCache === undefined) credCache = await readCredentialFile();
		return credCache;
	};

	async function execOn(sidecar: SidecarContainer, command: string[], params: Record<string, unknown> = {}) {
		return sidecar.exec(command, { mode: 'binary', stdout: 'pipe', stderr: 'pipe', workdir: agent.workdir, ...params });
	}

	return {
		signedIn: () => {
			if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.result;
			const result = (async () => {
				if (!(await readCredentialFile())) return { signedIn: false, problem: null };
				// Signed in means Devin may be used; keep warm slots ready for the next conversation.
				refillWarm(lastPoolKey);
				return { signedIn: true, problem: null };
			})().catch((error) => ({
				signedIn: false,
				problem: `Could not reach the ${agent.name} sandbox: ${error instanceof Error ? error.message : String(error)}`,
			}));
			statusCache = { at: Date.now(), result };
			return result;
		},

		credential,

		prepare: async () => {
			await agentImage();
			refillWarm(lastPoolKey);
		},

		signIn: async (): Promise<RuntimeSignIn> => {
			const sidecar = await agentAuth();
			// pty: the login command is an interactive prompt that aborts on a piped stdin.
			const proc = await execOn(sidecar, agent.auth.loginCommand, { pty: true });
			const tail = stderrTail(proc);
			const writer = proc.stdin.getWriter();
			const encoder = new TextEncoder();
			let buf = '';
			const diagnostics = () => plain(buf).slice(-400) || tail().slice(-400);
			// The login command prints its URL on stdout, then waits for the code on stdin.
			const url = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Timed out waiting for the ${agent.name} sign-in URL`)), 60_000);
				const scan = (chunk: string) => {
					buf = (buf + plain(chunk)).slice(-64_000);
					const match = agent.auth.loginUrl.exec(buf);
					if (match) {
						clearTimeout(timer);
						resolve(match[0]);
					}
				};
				void (async () => {
					const decoder = new TextDecoder();
					for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) scan(decoder.decode(chunk, { stream: true }));
				})();
				void proc.wait().then(() => {
					clearTimeout(timer);
					reject(new Error(`${agent.name} sign-in ended before showing a URL${diagnostics() ? `: ${diagnostics()}` : ''}`));
				});
			});
			return {
				url,
				complete: async (code) => {
					// \r is Enter on a PTY; \n would be a literal line-feed in raw mode.
					await writer.write(encoder.encode(`${code}\r`));
					await writer.close();
					const exit = await proc.wait();
					if (exit !== 0) throw new Error(`${agent.name} sign-in failed${diagnostics() ? `: ${diagnostics()}` : ''}`);
					statusCache = null;
					credCache = undefined;
				},
				cancel: () => void writer.close().catch(() => undefined),
			};
		},

		signOut: async () => {
			const sidecar = await cred();
			await sidecar.exec(['rm', '-f', agent.auth.credentialFile], { mode: 'binary' });
			statusCache = null;
			credCache = undefined;
			// Warm slots are useless without credentials; don't leave them billing.
			for (const pool of pools.values()) {
				for (const pending of pool.splice(0)) void pending.then((slot) => slot?.sidecar.terminate().catch(() => undefined));
			}
			pools.clear();
		},

		listModels: async () => {
			const token = await credential();
			if (!token) return [];
			const sidecar = await agentAuth();
			const proc = await execOn(sidecar, agent.command, { timeoutMs: 90_000 });
			const { transport, tail } = execTransport(proc);
			const acp = new AcpClient(transport, {});
			acp.start();
			try {
				await acp.request('initialize', {
					protocolVersion: 1,
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
					clientInfo: { name: 'anton', version: '1.0.0' },
				});
				await acp.request('authenticate', { methodId: agent.auth.methodId, ...agent.auth.params(token) });
				const session = (await acp.request('session/new', { cwd: agent.workdir, mcpServers: [] })) as {
					configOptions?: {
						id?: string;
						configId?: string;
						options?: { value?: string; name?: string; description?: string; _meta?: Record<string, unknown> }[];
					}[];
				};
				const option = session.configOptions?.find((o) => (o.id ?? o.configId) === agent.modelConfigId);
				const choices = (option?.options ?? []).filter((o) => typeof o.value === 'string' && o.value);
				const catalog = await modelCatalog(sidecar);
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
			} finally {
				await acp.close();
				if (tail()) console.error(`[acp:${agent.id}] probe stderr: ${tail().slice(-300)}`);
			}
		},

		spawn: async (model?: string): Promise<AcpProcess> => {
			const t0 = Date.now();
			const key = poolKey(model);
			lastPoolKey = key;
			const slot = await claimWarm(key);
			const tClaim = Date.now();
			let sidecar: SidecarContainer;
			let linkd: ContainerProcess<Uint8Array>;
			let acpProc: ContainerProcess<Uint8Array>;
			let execMs = 0;
			if (slot) {
				({ sidecar, linkd, acp: acpProc } = slot);
			} else {
				sidecar = await sidecarFor(unique('conv'), await agentImage(), agent.workdir, agent.egress);
				const tExec = Date.now();
				const argv = key ? [...agent.command, ...agent.modelArgs!(key)] : agent.command;
				try {
					[linkd, acpProc] = await Promise.all([
						execOn(sidecar, ['node', `${agent.linkDir}/linkd.mjs`, String(agent.linkPort)]),
						execOn(sidecar, argv),
					]);
				} catch (error) {
					await sidecar.terminate().catch(() => undefined);
					throw error;
				}
				execMs = Date.now() - tExec;
			}
			refillWarm(key);
			if (key !== '') refillWarm('');
			console.error(`[acp:${agent.id}] spawn: ${slot ? 'warm' : 'cold'} sidecar=${tClaim - t0}ms execs=${execMs}ms`);
			const link = execTransport(linkd);
			const acpT = execTransport(acpProc);
			return {
				acp: acpT.transport,
				mcp: link.transport,
				writeFile: (path, content) => sidecar.filesystem.writeText(content, path),
				close: async () => {
					await sidecar.terminate({ wait: true }).catch(() => sidecar.terminate().then(() => undefined));
				},
				stderrTail: () => [link.tail(), acpT.tail()].filter(Boolean).join(' | '),
			};
		},
	};
}
