import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { ModalClient } from 'modal';
import { devinAgent } from '../src/providers/acp/devin.ts';
import { modalAcpHost } from '../src/providers/acp/modal.ts';
import { acpRuntime, type AcpAgent, type AcpHost, type AcpIsolation, type AcpProcess } from '../src/providers/acp/runtime.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, what: string, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
		await sleep(5);
	}
}

/** Crockford base32 ULID-style id whose first 10 chars encode `ms`, like Modal's sandbox ids. */
function sandboxId(ms: number, suffix: string): string {
	const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
	let head = '';
	for (let i = 0, v = ms; i < 10; i++, v = Math.floor(v / 32)) head = alphabet[v % 32] + head;
	return `sb-${head}${suffix.padEnd(16, '0').slice(0, 16)}`;
}

type FakeBox = {
	kind: 'sandbox' | 'sidecar';
	name: string;
	exited: boolean;
	execs: string[][];
	tags: Record<string, string>;
};

/** Just enough of ModalClient for modalAcpHost: apps, images, sandboxes, sidecars and execs. */
function fakeModal(opts: { failBuilds?: number; listed?: { sandboxId: string; tags: Record<string, string> }[] } = {}) {
	const boxes: FakeBox[] = [];
	const built: string[][] = [];
	const swept: string[] = [];
	let failBuilds = opts.failBuilds ?? 0;
	let seq = 0;

	function proc(box: FakeBox) {
		let release: () => void = () => undefined;
		const done = new Promise<number>((resolve) => (release = () => resolve(137)));
		const watch = setInterval(() => box.exited && release(), 5);
		watch.unref();
		const stream = async function* () {
			await done;
		};
		return {
			stdin: { getWriter: () => ({ write: async () => undefined, close: async () => undefined }) },
			stdout: stream(),
			stderr: stream(),
			wait: () => done,
		};
	}

	function boxApi(box: FakeBox) {
		return {
			sandboxId: sandboxId(Date.now(), `X${++seq}`),
			exec: async (command: string[]) => {
				box.execs.push(command);
				return proc(box);
			},
			filesystem: { writeText: async () => undefined },
			poll: async () => (box.exited ? 137 : null),
			terminate: async () => {
				box.exited = true;
			},
			experimentalSidecars: {
				create: async (name: string) => {
					const sidecar: FakeBox = { kind: 'sidecar', name, exited: false, execs: [], tags: {} };
					boxes.push(sidecar);
					return boxApi(sidecar);
				},
			},
		};
	}

	const client = {
		apps: { fromName: async () => ({ appId: 'ap-test' }) },
		images: {
			fromRegistry: (ref: string) => {
				const image = (commands: string[]) => ({
					dockerfileCommands: (more: string[]) => image([...commands, ...more]),
					build: async () => {
						if (failBuilds > 0) {
							failBuilds -= 1;
							throw new Error('build failed');
						}
						built.push([ref, ...commands]);
						return { imageId: `im-${built.length}` };
					},
				});
				return image([]);
			},
		},
		sandboxes: {
			create: async (_app: unknown, _image: unknown, params: { name: string; tags: Record<string, string> }) => {
				const box: FakeBox = { kind: 'sandbox', name: params.name, exited: false, execs: [], tags: params.tags };
				boxes.push(box);
				return boxApi(box);
			},
			list: async function* () {
				for (const listed of opts.listed ?? []) yield { sandboxId: listed.sandboxId, getTags: async () => listed.tags };
			},
			fromId: async (id: string) => ({
				terminate: async () => {
					swept.push(id);
				},
			}),
		},
	};
	return { client: client as unknown as ModalClient, boxes, built, swept, live: () => boxes.filter((b) => !b.exited) };
}

/** Devin with no network: its manifest is unreachable, so the pinned fallback build stands in. */
const agent: AcpAgent = {
	...devinAgent,
	release: { floor: '1.0.0', latest: async () => null },
	install: { fallback: () => ({ version: '9.9.9', url: 'https://example.test/devin.tgz' }), fetch: async () => undefined },
};

/** The orphan sweep runs once per process; each test that checks it resets the guard. */
const resetSweep = () => {
	(globalThis as Record<symbol, unknown>)[Symbol.for('anton.acp.orphan-sweep')] = true;
};

function host(fake: ReturnType<typeof fakeModal>, isolation: AcpIsolation = 'sidecar') {
	return modalAcpHost(agent, 'anton-acp-test', { client: fake.client, isolation: async () => isolation, owner: async () => 'server-a' });
}

const live = (fake: ReturnType<typeof fakeModal>, kind: FakeBox['kind']) => fake.live().filter((b) => b.kind === kind);

test('sidecar mode keeps one warm slot, and a claim never takes more than it hands out', async () => {
	resetSweep();
	const fake = fakeModal();
	const h = host(fake);
	const first = await h.spawn('swe-2-high');
	await until(() => live(fake, 'sidecar').length === 2, 'one conversation plus one warm slot');
	const second = await h.spawn('swe-2-high');
	await until(() => live(fake, 'sidecar').length === 3, 'the warm slot refilled after its claim');
	await sleep(50);
	// Two conversations and one warm slot; the old pools kept four warm beside each live one.
	assert.equal(live(fake, 'sidecar').length, 3);
	assert.equal(fake.boxes.filter((b) => b.kind === 'sidecar').length, 3, 'the second spawn was served by the warm slot');
	assert.equal(live(fake, 'sandbox').length, 1, 'one anchor');
	await first.close();
	await second.close();
	assert.equal(live(fake, 'sidecar').length, 1, 'only the warm slot is left');
});

test('dedicated-sandbox mode starts no warm slot', async () => {
	resetSweep();
	const fake = fakeModal();
	const h = host(fake, 'sandbox');
	const conv = await h.spawn('swe-2-high');
	await sleep(50);
	assert.equal(fake.live().length, 1, 'just the conversation');
	assert.ok(fake.live()[0]!.tags['anton-acp-owner'] === 'server-a', 'containers carry the owner tag');
	await conv.close();
	assert.equal(fake.live().length, 0);
});

test('the warm slot and the anchor expire on their own while nothing uses the agent', async () => {
	resetSweep();
	mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
	try {
		const fake = fakeModal();
		const h = host(fake);
		const conv = await h.spawn('swe-2-high');
		await until(() => live(fake, 'sidecar').length === 2, 'conversation plus warm slot');
		await conv.close();
		// 11 minutes later the warm window has passed: the slot goes even though nothing closed it.
		mock.timers.tick(11 * 60_000);
		await until(() => live(fake, 'sidecar').length === 0, 'the warm slot to expire');
		// The anchor follows once its grace runs out with no conversation or slot left.
		mock.timers.tick(60_000);
		await until(() => fake.live().length === 0, 'the anchor to be torn down');
	} finally {
		mock.timers.reset();
	}
});

test('an open conversation does not keep a stale warm slot alive', async () => {
	resetSweep();
	mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
	try {
		const fake = fakeModal();
		const h = host(fake);
		await h.spawn('swe-2-high');
		await until(() => live(fake, 'sidecar').length === 2, 'conversation plus warm slot');
		mock.timers.tick(11 * 60_000);
		await until(() => live(fake, 'sidecar').length === 1, 'the warm slot to expire beside the open conversation');
		assert.equal(live(fake, 'sandbox').length, 1, 'the anchor stays while a conversation is open');
	} finally {
		mock.timers.reset();
	}
});

test('a failed image build is retried by the next spawn, not cached', async () => {
	resetSweep();
	const fake = fakeModal({ failBuilds: 1 });
	const h = host(fake, 'sandbox');
	await assert.rejects(h.spawn('swe-2-high'), /build failed/);
	const conv = await h.spawn('swe-2-high');
	assert.equal(fake.live().length, 1);
	await conv.close();
});

test('an unreachable release manifest builds the pinned fallback', async () => {
	resetSweep();
	const fake = fakeModal();
	const h = host(fake, 'sandbox');
	const conv = await h.spawn('swe-2-high');
	const devinImage = fake.built.find((commands) => commands.some((c) => c.includes('devin.tgz')));
	assert.ok(devinImage?.some((c) => c.includes('https://example.test/devin.tgz')), 'the fallback URL is installed');
	await conv.close();
});

test('the orphan sweep kills only this server\'s leftovers that predate the process', async () => {
	(globalThis as Record<symbol, unknown>)[Symbol.for('anton.acp.orphan-sweep')] = undefined;
	const old = Date.now() - 3_600_000;
	const fake = fakeModal({
		listed: [
			{ sandboxId: sandboxId(old, 'MINE'), tags: { 'anton-acp': 'devin', 'anton-acp-owner': 'server-a' } },
			{ sandboxId: sandboxId(old, 'OTHER'), tags: { 'anton-acp': 'devin', 'anton-acp-owner': 'server-b' } },
			{ sandboxId: sandboxId(old, 'LEGACY'), tags: { 'anton-acp': 'devin' } },
			{ sandboxId: sandboxId(Date.now() + 60_000, 'NEW'), tags: { 'anton-acp': 'devin', 'anton-acp-owner': 'server-a' } },
			{ sandboxId: sandboxId(old, 'TASK'), tags: {} },
		],
	});
	host(fake);
	await until(() => fake.swept.length === 2, 'the sweep');
	await sleep(20);
	assert.deepEqual(fake.swept, [sandboxId(old, 'MINE'), sandboxId(old, 'LEGACY')]);
});

test('a conversation closed while its container is still starting ends that container', async () => {
	let finish: (proc: AcpProcess) => void = () => undefined;
	let closed = 0;
	const h: AcpHost = {
		signedIn: async () => ({ signedIn: true, problem: null }),
		credential: async () => 'token',
		signIn: () => Promise.reject(new Error('unused')),
		signOut: async () => undefined,
		listModels: async () => [],
		spawn: () => new Promise((resolve) => (finish = resolve)),
	};
	const conv = acpRuntime(agent, h).open({ model: 'swe-2-high', instructions: '', tools: [], effort: null, callTool: async () => ({ content: [], isError: false }) });
	conv.send([{ type: 'text', text: 'hi' }]);
	await sleep(10);
	conv.close();
	const idle = { write: () => undefined, lines: async function* () {}, closeStdin: async () => undefined, kill: async () => undefined };
	finish({ acp: idle, mcp: idle, writeFile: async () => undefined, close: async () => void (closed += 1), stderrTail: () => '' });
	await until(() => closed === 1, 'the late container to be closed');
});

test('a session whose setup fails closes its container', async () => {
	let closed = 0;
	const failing = {
		write: () => undefined,
		lines: async function* () {},
		closeStdin: async () => undefined,
		kill: async () => undefined,
	};
	const h: AcpHost = {
		signedIn: async () => ({ signedIn: true, problem: null }),
		credential: async () => 'token',
		signIn: () => Promise.reject(new Error('unused')),
		signOut: async () => undefined,
		listModels: async () => [],
		spawn: async () => ({ acp: failing, mcp: failing, writeFile: async () => undefined, close: async () => void (closed += 1), stderrTail: () => '' }),
	};
	const conv = acpRuntime({ ...agent }, h).open({ model: 'swe-2-high', instructions: '', tools: [], effort: null, callTool: async () => ({ content: [], isError: false }) });
	conv.send([{ type: 'text', text: 'hi' }]);
	// The agent's output ends at once, so initialize fails right after the spawn.
	await sleep(10);
	const events: string[] = [];
	const reading = (async () => {
		for await (const event of conv.events) events.push(event.type);
	})();
	await until(() => closed === 1 || events.includes('error'), 'setup to fail or close');
	await reading.catch(() => undefined);
	assert.equal(closed, 1);
});
