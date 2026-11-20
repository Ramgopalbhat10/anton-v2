// Modal side of an AcpHost: a small pool of warm conversation containers (linkd +
// agent execs pre-started) and one container per live conversation. Two isolation
// modes: 'sidecar' shares one anchor sandbox (cheap, experimental API); 'sandbox'
// gives each conversation its own Modal sandbox (standard API, billed per sandbox).
// Auth lives on this host — the vendor CLI's credentials.toml stays local and each
// session gets the key via _meta.api_key, so no container ever holds credentials.

import { randomUUID } from 'node:crypto';
import { type App, type ContainerProcess, type Image, ModalClient, type Sandbox, type SidecarContainer } from 'modal';
import type { RuntimeSignIn } from '../../core/ports.ts';
import type { AcpTransport } from './client.ts';
import { canInstallCli, cliInstallGap, ensureCli, localCli, localCredential, localListModels, localSignIn, localSignOut } from './local-cli.ts';
import type { AcpAgent, AcpHost, AcpIsolation, AcpProcess, AcpRelease } from './runtime.ts';
import { LINKD_SCRIPT, LINK_SCRIPT } from './sidecar-scripts.ts';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** The anchor container does nothing but hold the sandbox; agents live in sidecars. */
const MAIN_IMAGE = 'debian:bookworm-slim';
const SANDBOX_CPU = 1;
const SANDBOX_MEMORY_MIB = 1024;
const SANDBOX_TIMEOUT_MS = 24 * 3_600_000;
const SANDBOX_IDLE_MS = 20 * 60_000;
/**
 * Modal's idle timeout only watches the main container's execs/stdin/tunnels;
 * sidecar execs keep a sandbox "active" forever, so idleTimeoutMs never fires
 * here. The host reaps itself after this long without any call instead.
 */
const HOST_IDLE_MS = 20 * 60_000;
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

/** A sidecar of the shared anchor or a standalone sandbox; both expose exec/filesystem/terminate. */
type ConvBox = SidecarContainer | Sandbox;

export function modalAcpHost(agent: AcpAgent, appName: string, opts?: { isolation?: () => Promise<AcpIsolation> }): AcpHost {
	const client = new ModalClient();
	let app: Promise<App> | undefined;
	let sandbox: Promise<Sandbox> | null = null;
	let imageFor: { key: string; promise: Promise<Image> } | null = null;
	let mainImage: Promise<Image> | null = null;
	let releaseCache: { at: number; value: Promise<AcpRelease | null> } | null = null;
	let sidecarSeq = 0;
	// Sandbox names must be unique per app; a reload or second server would collide with a live one.
	const sandboxName = `acp-${agent.id}-${randomUUID().slice(0, 8)}`;
	let statusCache: { at: number; result: Promise<{ signedIn: boolean; problem: string | null }> } | null = null;
	/** Stamped on every host call; the reaper tears the sandbox down after HOST_IDLE_MS of silence. */
	let lastActivity = Date.now();
	/** Containers serving open conversations; the reaper never fires while one is alive. */
	const liveConvs = new Set<ConvBox>();
	/** The isolation mode warm slots and spawns currently use; a setting flip drains the pools. */
	let activeMode: AcpIsolation | undefined;

	const appRef = () => (app ??= client.apps.fromName(appName, { createIfMissing: true }));
	const unique = (prefix: string) => `${prefix}-${++sidecarSeq}-${randomUUID().slice(0, 8)}`;

	/** The agent's newest release, re-asked every RELEASE_TTL_MS; null keeps the descriptor's pinned build. Sidecar images are always linux/x64. */
	async function release(): Promise<AcpRelease | null> {
		if (!agent.release) return null;
		if (!releaseCache || Date.now() - releaseCache.at > RELEASE_TTL_MS) {
			releaseCache = { at: Date.now(), value: agent.release.latest('linux/x64').catch(() => null) };
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

	// Sidecar create needs a built image; sandboxes.create resolves a registry ref itself.
	function anchorImage(): Promise<Image> {
		return (mainImage ??= (async () => client.images.fromRegistry(MAIN_IMAGE).build(await appRef()))());
	}

	async function mainSandbox(): Promise<Sandbox> {
		if (sandbox) {
			const live = await sandbox.then((s) => s.poll().then((code) => (code === null ? s : null))).catch(() => null);
			if (live) return live;
			sandbox = null;
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

	/**
	 * One jailed container for linkd + the agent execs. 'sidecar' hangs it off the
	 * shared anchor sandbox; 'sandbox' is a standalone Modal sandbox billed on its
	 * own. Either way it gets the vendor's domains only — no container holds credentials.
	 */
	async function convFor(name: string, image: Image, workdir: string, egress: string[] | null, isolation: AcpIsolation): Promise<ConvBox> {
		const net = egress ? { outboundDomainAllowlist: egress } : { outboundCidrAllowlist: [] };
		if (isolation === 'sandbox') {
			return client.sandboxes.create(await appRef(), image, {
				name: `${agent.id}-${name}`,
				command: ['sleep', 'infinity'],
				workdir,
				cpu: SANDBOX_CPU,
				memoryMiB: SANDBOX_MEMORY_MIB,
				timeoutMs: SANDBOX_TIMEOUT_MS,
				idleTimeoutMs: SANDBOX_IDLE_MS,
				...net,
				tags: { 'anton-acp': agent.id },
			});
		}
		const sb = await mainSandbox();
		return sb.experimentalSidecars.create(name, image, { command: ['sleep', 'infinity'], workdir, ...net });
	}

	// ---- warm conversation pool -----------------------------------------
	// A warm slot is a sidecar with linkd and the agent already exec'd and idling.
	// One slot still serves exactly one conversation — claiming never shares it —
	// so per-conversation isolation is unchanged; only the startup is moved earlier.
	// Slots are pooled per model when the agent can preset one (devin acp --model):
	// that process defaults every session to it, so session/new skips set_config_option.
	// The '' pool holds model-agnostic slots — the fallback for models without a warm one.
	type WarmSlot = { box: ConvBox; mode: AcpIsolation; linkd: ContainerProcess<Uint8Array>; acp: ContainerProcess<Uint8Array>; createdAt: number };
	const pools = new Map<string, Promise<WarmSlot | null>[]>();
	/** The pool key of the most recent spawn; prepare() warm-up refills it. */
	let lastPoolKey = '';
	const MAX_WARM = POOL_SIZE * 2;

	const poolKey = (model?: string) => (model && agent.modelArgs ? model : '');
	const warmCount = () => [...pools.values()].reduce((n, pool) => n + pool.length, 0);

	/** Terminates every pending warm slot; used on sign-out, teardown, and an isolation flip. */
	function drainWarm(): void {
		for (const pool of pools.values()) {
			for (const pending of pool.splice(0)) void pending.then((slot) => slot?.box.terminate().catch(() => undefined));
		}
		pools.clear();
	}

	/** The configured isolation; a flip drains warm slots built for the old mode. */
	async function mode(): Promise<AcpIsolation> {
		const m = (await opts?.isolation?.().catch(() => undefined)) ?? 'sidecar';
		if (activeMode !== undefined && m !== activeMode) drainWarm();
		activeMode = m;
		return m;
	}

	async function warmSlot(model: string | undefined, isolation: AcpIsolation): Promise<WarmSlot | null> {
		try {
			const box = await convFor(unique('warm'), await agentImage(), agent.workdir, agent.egress, isolation);
			// Same pair spawn() starts; the agent only reaches linkd on its first MCP call.
			const argv = model && agent.modelArgs ? [...agent.command, ...agent.modelArgs(model)] : agent.command;
			const [linkd, acp] = await Promise.all([
				execOn(box, ['node', `${agent.linkDir}/linkd.mjs`, String(agent.linkPort)]),
				execOn(box, argv),
			]);
			return { box, mode: isolation, linkd, acp, createdAt: Date.now() };
		} catch {
			return null;
		}
	}

	function refillWarm(key: string, isolation: AcpIsolation): void {
		let pool = pools.get(key);
		if (!pool) pools.set(key, (pool = []));
		while (pool.length < POOL_SIZE && warmCount() < MAX_WARM) pool.push(warmSlot(key || undefined, isolation));
	}

	const alive = (proc: ContainerProcess<Uint8Array>) =>
		Promise.race([
			proc.wait().then(
				() => false,
				() => false,
			),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(true), WARM_CHECK_MS)),
		]);

	/** The oldest live warm slot for the model in this mode, or null — dead or wrong-mode slots are terminated and the caller spawns cold. */
	async function claimWarm(key: string, isolation: AcpIsolation): Promise<WarmSlot | null> {
		// Exact-model slots first; an agnostic one still works, it just pays set_config_option.
		for (const k of key === '' ? [''] : [key, '']) {
			const pool = pools.get(k);
			if (!pool) continue;
			for (const pending of pool.splice(0)) {
				const slot = await pending;
				if (!slot) continue;
				const fresh = Date.now() - slot.createdAt <= WARM_MAX_AGE_MS;
				if (slot.mode !== isolation) {
					await slot.box.terminate().catch(() => undefined);
					continue;
				}
				if (fresh && (await Promise.all([alive(slot.linkd), alive(slot.acp)])).every(Boolean)) return slot;
				await slot.box.terminate().catch(() => undefined);
			}
		}
		return null;
	}

	// The file only changes through our own sign-in/out, so one read serves a while.
	let credCache: string | null | undefined;
	const credential = async () => {
		lastActivity = Date.now();
		if (credCache === undefined) credCache = await localCredential(agent);
		return credCache;
	};

	async function execOn(box: ConvBox, command: string[], params: Record<string, unknown> = {}) {
		return box.exec(command, { mode: 'binary', stdout: 'pipe', stderr: 'pipe', workdir: agent.workdir, ...params });
	}

	/**
	 * Ends every sidecar and the anchor sandbox, then forgets them so the next
	 * call rebuilds cold. Fires only after HOST_IDLE_MS without a host call and
	 * no open conversation; sign-in attempts are safe because LOGIN_TTL_MS is
	 * shorter than the idle window.
	 */
	async function teardown(): Promise<void> {
		lastActivity = Date.now();
		const sb = sandbox;
		sandbox = null;
		const warm = [...pools.values()].flatMap((pool) => pool.splice(0));
		pools.clear();
		void sb?.then((s) => s.terminate()).catch(() => undefined);
		await Promise.allSettled([...warm.map((pending) => pending.then((slot) => slot?.box.terminate()))]);
	}

	const reaper = setInterval(() => {
		if (liveConvs.size > 0 || Date.now() - lastActivity < HOST_IDLE_MS) return;
		void teardown();
	}, 60_000);
	reaper.unref();

	return {
		signedIn: () => {
			lastActivity = Date.now();
			if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.result;
			const result = (async () => {
				// Status checks must not create warm infrastructure; only spawn/prepare refill the pool.
				// Auth lives on this host now, so a status check never touches Modal at all.
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
				return cred ? { signedIn: true, problem } : { signedIn: false, problem };
			})().catch((error) => ({
				signedIn: false,
				problem: `Could not check ${agent.name} sign-in: ${error instanceof Error ? error.message : String(error)}`,
			}));
			statusCache = { at: Date.now(), result };
			return result;
		},

		credential,

		prepare: async () => {
			lastActivity = Date.now();
			const isolation = await mode();
			await agentImage();
			refillWarm(lastPoolKey, isolation);
		},

		isolation: () => mode(),

		signIn: async (): Promise<RuntimeSignIn> => {
			lastActivity = Date.now();
			const signIn = await localSignIn(agent);
			return {
				url: signIn.url,
				complete: async (code) => {
					lastActivity = Date.now();
					await signIn.complete(code);
					statusCache = null;
					credCache = undefined;
				},
				cancel: () => {
					lastActivity = Date.now();
					signIn.cancel();
				},
			};
		},

		signOut: async () => {
			lastActivity = Date.now();
			await localSignOut(agent);
			statusCache = null;
			credCache = undefined;
			// Warm slots are useless without credentials; don't leave them billing.
			drainWarm();
		},

		listModels: async () => {
			lastActivity = Date.now();
			return localListModels(agent);
		},

		...(agent.windows ? { windows: () => agent.windows!() } : {}),

		spawn: async (model?: string): Promise<AcpProcess> => {
			lastActivity = Date.now();
			const t0 = Date.now();
			const isolation = await mode();
			const key = poolKey(model);
			lastPoolKey = key;
			const slot = await claimWarm(key, isolation);
			const tClaim = Date.now();
			let box: ConvBox;
			let linkd: ContainerProcess<Uint8Array>;
			let acpProc: ContainerProcess<Uint8Array>;
			let execMs = 0;
			if (slot) {
				({ box, linkd, acp: acpProc } = slot);
			} else {
				box = await convFor(unique('conv'), await agentImage(), agent.workdir, agent.egress, isolation);
				const tExec = Date.now();
				const argv = key ? [...agent.command, ...agent.modelArgs!(key)] : agent.command;
				try {
					[linkd, acpProc] = await Promise.all([
						execOn(box, ['node', `${agent.linkDir}/linkd.mjs`, String(agent.linkPort)]),
						execOn(box, argv),
					]);
				} catch (error) {
					await box.terminate().catch(() => undefined);
					throw error;
				}
				execMs = Date.now() - tExec;
			}
			refillWarm(key, isolation);
			if (key !== '') refillWarm('', isolation);
			console.error(`[acp:${agent.id}] spawn: ${slot ? 'warm' : 'cold'} ${isolation} box=${tClaim - t0}ms execs=${execMs}ms`);
			liveConvs.add(box);
			const link = execTransport(linkd);
			const acpT = execTransport(acpProc);
			return {
				acp: acpT.transport,
				mcp: link.transport,
				writeFile: (path, content) => box.filesystem.writeText(content, path),
				close: async () => {
					liveConvs.delete(box);
					await box.terminate({ wait: true }).catch(() => box.terminate().then(() => undefined));
				},
				stderrTail: () => [link.tail(), acpT.tail()].filter(Boolean).join(' | '),
			};
		},
	};
}
