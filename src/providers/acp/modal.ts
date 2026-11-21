// Modal compute for ACP agents: at most one warm conversation container (linkd +
// agent execs pre-started, sidecar mode only) and one container per live conversation. Two isolation
// modes: 'sidecar' shares one anchor sandbox (cheap, experimental API); 'sandbox'
// gives each conversation its own Modal sandbox (standard API, billed per sandbox).
// Sign-in is the AcpAccount's (local-cli.ts); a container gets the key only per
// session, through authenticate, and never keeps it.

import { randomUUID } from 'node:crypto';
import { type App, type ContainerProcess, type Image, ModalClient, type Sandbox, type SidecarContainer } from 'modal';
import type { AcpTransport } from './client.ts';
import type { AcpAgent, AcpCompute, AcpIsolation, AcpProcess, AcpRelease } from './runtime.ts';
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
 * here. The anchor is torn down this long after its last conversation and warm slot are gone.
 */
const ANCHOR_GRACE_MS = 5 * 60_000;
/** How often the host expires its warm slot, drops exited containers and reaps the anchor. */
const REAP_EVERY_MS = 60_000;
/** How often a running server re-asks the vendor for a newer agent build. */
const RELEASE_TTL_MS = 6 * 3_600_000;
/** A failed release lookup is retried this soon, not cached for RELEASE_TTL_MS. */
const RELEASE_RETRY_MS = 5 * 60_000;
/** How long a claimed slot's execs get to prove they're still running before a cold spawn. */
const WARM_CHECK_MS = 400;
/** Pre-started agent execs are trusted only this long; older ones may be wedged and go stale. */
const WARM_MAX_AGE_MS = 10 * 60_000;
/** A warm slot is kept only while a conversation started this recently; an unused agent bills nothing. */
const WARM_WINDOW_MS = 10 * 60_000;
/** Tags every container this server starts; the orphan sweep kills only its own server's leftovers. */
const OWNER_TAG = 'anton-acp-owner';
/** When this module loaded — approximately process start; the orphan sweep only kills sandboxes older than this. */
const PROCESS_STARTED = Date.now();
/** Modal sandbox ids are ULIDs: the first 10 Crockford-base32 chars encode the creation time in ms. */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function sandboxCreatedAtMs(id: string): number | null {
	const ulid = id.startsWith('sb-') ? id.slice(3) : id;
	if (ulid.length < 10) return null;
	let ms = 0;
	for (const c of ulid.slice(0, 10)) {
		const v = ULID_ALPHABET.indexOf(c.toUpperCase());
		if (v < 0) return null;
		ms = ms * 32 + v;
	}
	return ms;
}

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

/** A cached promise that forgets itself when it rejects, so one failed Modal call is retried rather than served forever. */
function retrying<T>(make: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () => {
		if (pending) return pending;
		const attempt = make();
		pending = attempt;
		attempt.catch(() => {
			if (pending === attempt) pending = undefined;
		});
		return attempt;
	};
}

export type ModalComputeOptions = {
	isolation?: () => Promise<AcpIsolation>;
	/** This server's stable id (it outlives restarts); the orphan sweep never touches another server's containers. */
	owner?: () => Promise<string>;
	/** Tests pass a fake. */
	client?: ModalClient;
};

export function modalCompute(agent: AcpAgent, appName: string, opts?: ModalComputeOptions): AcpCompute {
	const client = opts?.client ?? new ModalClient();
	let sandbox: Promise<Sandbox> | null = null;
	let imageFor: { key: string; promise: Promise<Image> } | null = null;
	let releaseCache: { at: number; ttl: number; value: Promise<AcpRelease | null> } | null = null;
	let sidecarSeq = 0;
	// Sandbox names must be unique per app; a reload or second server would collide with a live one.
	const sandboxName = `acp-${agent.id}-${randomUUID().slice(0, 8)}`;
	/** Containers serving open conversations; the anchor is never torn down while one is alive. */
	const liveConvs = new Set<ConvBox>();
	/** When compute was last used (a spawn, a close); the anchor outlives its last container by ANCHOR_GRACE_MS. */
	let computeUsedAt = Date.now();
	/** When the last conversation started; warm slots exist only within WARM_WINDOW_MS of it. */
	let lastSpawnAt = 0;
	/** The isolation mode warm slots and spawns currently use; a setting flip drains the warm slot. */
	let activeMode: AcpIsolation | undefined;

	const appRef = retrying(() => client.apps.fromName(appName, { createIfMissing: true }));
	const owner = retrying(async () => (await opts?.owner?.()) ?? '');
	const unique = (prefix: string) => `${prefix}-${++sidecarSeq}-${randomUUID().slice(0, 8)}`;
	const tags = async (): Promise<Record<string, string>> => {
		const id = await owner().catch(() => '');
		return id ? { 'anton-acp': agent.id, [OWNER_TAG]: id } : { 'anton-acp': agent.id };
	};

	/**
	 * ACP sandboxes bill while they run and nothing outside their process can stop
	 * them: a restart loses every handle, while the agent process inside keeps the
	 * sandbox "active" so Modal's idle timeout never fires. The first host built in
	 * a process sweeps the leftovers of dead ones — once per process, since a vite
	 * reload rebuilds hosts while live conversations still use their sidecars.
	 * Dev and prod servers can share one app, so only this server's own leftovers
	 * (its owner tag) are killed; untagged ones predate owner tags.
	 */
	const bootKey = Symbol.for('anton.acp.orphan-sweep');
	const bootState = globalThis as typeof globalThis & { [bootKey]?: true };
	if (!bootState[bootKey]) {
		bootState[bootKey] = true;
		void (async () => {
			try {
				const me = await owner().catch(() => '');
				for await (const sb of client.sandboxes.list({ appId: (await appRef()).appId })) {
					const found = await sb.getTags().catch(() => ({}) as Record<string, string>);
					if (!found['anton-acp']) continue;
					if (found[OWNER_TAG] && found[OWNER_TAG] !== me) continue;
					// Only predating sandboxes are orphans; anything newer could be a fresh spawn of this process.
					const created = sandboxCreatedAtMs(sb.sandboxId);
					if (created !== null && created > PROCESS_STARTED - 10_000) continue;
					await client.sandboxes.fromId(sb.sandboxId).then((s) => s.terminate()).catch(() => undefined);
				}
			} catch {
				// Best-effort: leftovers also die at the sandbox's own timeout.
			}
		})();
	}

	/**
	 * The agent's newest release, re-asked every RELEASE_TTL_MS; when the vendor's
	 * manifest is unreachable the descriptor's pinned build stands in and the lookup
	 * is retried soon. Sidecar images are always linux/x64.
	 */
	async function release(): Promise<AcpRelease | null> {
		if (!agent.release) return null;
		if (!releaseCache || Date.now() - releaseCache.at > releaseCache.ttl) {
			const at = Date.now();
			const value = agent.release.latest('linux/x64').catch(() => null);
			releaseCache = { at, ttl: RELEASE_TTL_MS, value };
			void value.then((rel) => {
				if (!rel && releaseCache?.value === value) releaseCache.ttl = RELEASE_RETRY_MS;
			});
		}
		return (await releaseCache.value) ?? agent.install?.fallback('linux/x64') ?? null;
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
		// A failed build is retried by the next spawn, not served until the next release.
		promise.catch(() => {
			if (imageFor?.promise === promise) imageFor = null;
		});
		return promise;
	}

	// Sidecar create needs a built image; sandboxes.create resolves a registry ref itself.
	const anchorImage = retrying(async () => client.images.fromRegistry(MAIN_IMAGE).build(await appRef()));

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
			tags: await tags(),
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
				tags: await tags(),
			});
		}
		const sb = await mainSandbox();
		return sb.experimentalSidecars.create(name, image, { command: ['sleep', 'infinity'], workdir, ...net });
	}

	// ---- warm conversation slot -----------------------------------------
	// A warm slot is a sidecar with linkd and the agent already exec'd and idling.
	// It still serves exactly one conversation, so isolation is unchanged; only the
	// startup moves earlier. There is at most one, only in sidecar mode (a dedicated
	// sandbox starts cold in seconds and bills per box), and only while the agent was
	// used in the last WARM_WINDOW_MS. A slot presets the last model where the agent
	// allows it (devin acp --model); any other model still works through set_config_option.
	type WarmSlot = { box: ConvBox; mode: AcpIsolation; linkd: ContainerProcess<Uint8Array>; acp: ContainerProcess<Uint8Array>; createdAt: number };
	let warm: { key: string; mode: AcpIsolation; slot: Promise<WarmSlot | null> } | null = null;

	const poolKey = (model?: string) => (model && agent.modelArgs ? model : '');
	const terminateSlot = (pending: Promise<WarmSlot | null>) => void pending.then((slot) => slot?.box.terminate()).catch(() => undefined);

	/** Terminates the warm slot; used on sign-out, teardown, expiry and an isolation flip. */
	function drainWarm(): void {
		if (warm) terminateSlot(warm.slot);
		warm = null;
	}

	/** The configured isolation; a flip drains a warm slot built for the old mode. */
	async function mode(): Promise<AcpIsolation> {
		const m = (await opts?.isolation?.().catch(() => undefined)) ?? 'sidecar';
		if (activeMode !== undefined && m !== activeMode) drainWarm();
		activeMode = m;
		return m;
	}

	async function warmSlot(model: string | undefined, isolation: AcpIsolation): Promise<WarmSlot | null> {
		let box: ConvBox | undefined;
		try {
			box = await convFor(unique('warm'), await agentImage(), agent.workdir, agent.egress, isolation);
			// Same pair spawn() starts; the agent only reaches linkd on its first MCP call.
			const argv = model && agent.modelArgs ? [...agent.command, ...agent.modelArgs(model)] : agent.command;
			const [linkd, acp] = await Promise.all([
				execOn(box, ['node', `${agent.linkDir}/linkd.mjs`, String(agent.linkPort)]),
				execOn(box, argv),
			]);
			return { box, mode: isolation, linkd, acp, createdAt: Date.now() };
		} catch {
			await box?.terminate().catch(() => undefined);
			return null;
		}
	}

	const wantWarm = (isolation: AcpIsolation) => isolation === 'sidecar' && Date.now() - lastSpawnAt < WARM_WINDOW_MS;

	/** Keeps one slot ready for `key` while warm slots are wanted; a slot for another model or mode is replaced. */
	function refillWarm(key: string, isolation: AcpIsolation): void {
		if (!wantWarm(isolation)) return drainWarm();
		if (warm && warm.mode === isolation && warm.key === key) return;
		drainWarm();
		warm = { key, mode: isolation, slot: warmSlot(key || undefined, isolation) };
	}

	const alive = (proc: ContainerProcess<Uint8Array>) =>
		Promise.race([
			proc.wait().then(
				() => false,
				() => false,
			),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(true), WARM_CHECK_MS)),
		]);

	/** Takes the warm slot if it is live, fresh and in this mode; anything else is terminated and the caller spawns cold. */
	async function claimWarm(isolation: AcpIsolation): Promise<WarmSlot | null> {
		const taken = warm;
		warm = null;
		if (!taken) return null;
		const slot = await taken.slot;
		if (!slot) return null;
		const fresh = Date.now() - slot.createdAt <= WARM_MAX_AGE_MS;
		if (slot.mode === isolation && fresh && (await Promise.all([alive(slot.linkd), alive(slot.acp)])).every(Boolean)) return slot;
		await slot.box.terminate().catch(() => undefined);
		return null;
	}

	async function execOn(box: ConvBox, command: string[], params: Record<string, unknown> = {}) {
		return box.exec(command, { mode: 'binary', stdout: 'pipe', stderr: 'pipe', workdir: agent.workdir, ...params });
	}

	/** Ends the warm slot and the anchor sandbox (and with it every sidecar); the next spawn rebuilds cold. */
	function teardown(): void {
		const sb = sandbox;
		sandbox = null;
		drainWarm();
		void sb?.then((s) => s.terminate()).catch(() => undefined);
	}

	/**
	 * One clock for every container this host owns: the warm slot expires at its age
	 * limit or when the agent goes unused, conversations whose container already
	 * exited stop counting as live, and the anchor goes ANCHOR_GRACE_MS after its
	 * last container. Open conversations never keep a warm slot alive.
	 */
	async function reap(now = Date.now()): Promise<void> {
		if (warm) {
			const slot = await warm.slot.catch(() => null);
			if (warm && (!slot || now - slot.createdAt > WARM_MAX_AGE_MS || !wantWarm(warm.mode))) drainWarm();
		}
		for (const box of [...liveConvs]) {
			const exited = await box.poll().catch(() => null);
			if (exited !== null) liveConvs.delete(box);
		}
		if (sandbox && !warm && liveConvs.size === 0 && now - computeUsedAt > ANCHOR_GRACE_MS) teardown();
	}

	const reaper = setInterval(() => void reap().catch(() => undefined), REAP_EVERY_MS);
	reaper.unref();

	return {
		// Builds the image off the reply path; no container starts until a conversation does.
		prepare: async () => {
			await mode();
			await agentImage();
		},

		isolation: () => mode(),

		drain: () => drainWarm(),

		spawn: async (model?: string): Promise<AcpProcess> => {
			const t0 = Date.now();
			computeUsedAt = t0;
			lastSpawnAt = t0;
			const isolation = await mode();
			const key = poolKey(model);
			const slot = await claimWarm(isolation);
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
					computeUsedAt = Date.now();
					await box.terminate({ wait: true }).catch(() => box.terminate().then(() => undefined));
				},
				stderrTail: () => [link.tail(), acpT.tail()].filter(Boolean).join(' | '),
			};
		},
	};
}
