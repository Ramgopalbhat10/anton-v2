import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { dockerSandboxProvider } from '../src/providers/docker/sandbox.ts';

const IMAGE = 'debian:bookworm-slim';
const noDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0 && 'Docker is not running here';
const resources = { runtime: 'container' as const, cpu: 1, memoryMiB: 512, idleTimeoutMs: 60_000, lifetimeMs: 60_000, regions: [], allowedDomains: [] };
const keys: string[] = [];
const keyFor = (name: string) => {
	const key = `test-${name}-${process.pid}`;
	keys.push(key);
	return key;
};
const out = (result: { stdout: Uint8Array }) => new TextDecoder().decode(result.stdout).trim();
after(() => {
	for (const key of keys) spawnSync('docker', ['rm', '-f', `anton-${key}`], { stdio: 'ignore' });
});

test('a task runs in a container from its base image, in /workspace, with the env it is given', { skip: noDocker }, async () => {
	const provider = dockerSandboxProvider({ baseImage: 'node:22-bookworm' });
	const key = keyFor('run');
	const { machine, origin } = await provider.acquire({ key, state: null, image: null, baseImage: IMAGE, ports: [], resources });
	assert.equal(origin, 'base');
	assert.equal(out(await machine.exec('pwd; . /etc/os-release; echo $ID; echo $GREETING', { env: { GREETING: 'hi' } })), '/workspace\ndebian\nhi');
	assert.equal(out(await machine.exec('cat', { stdin: new TextEncoder().encode('piped') })), 'piped');
	assert.equal((await machine.exec('exit 3')).exitCode, 3);
	assert.deepEqual([...(await provider.running())].filter((running) => running === key), [key]);
});

test('a stopped task resumes with its files, and a snapshot starts a new task from them', { skip: noDocker }, async () => {
	const provider = dockerSandboxProvider({ baseImage: IMAGE });
	const key = keyFor('resume');
	const first = await provider.acquire({ key, state: null, image: null, baseImage: null, ports: [], resources });
	await first.machine.exec('echo kept > /workspace/note.txt');
	await provider.stop(first.state);
	assert.equal(await provider.find(key), null);
	const again = await provider.acquire({ key, state: first.state, image: null, baseImage: null, ports: [], resources });
	assert.equal(again.origin, 'resumed');
	assert.equal(out(await again.machine.exec('cat note.txt')), 'kept');

	const image = await provider.snapshot(again.machine);
	const copy = await provider.acquire({ key: keyFor('copy'), state: null, image, baseImage: null, ports: [], resources });
	assert.equal(copy.origin, 'image');
	assert.equal(out(await copy.machine.exec('cat note.txt')), 'kept');
	spawnSync('docker', ['rmi', '-f', image], { stdio: 'ignore' });
});

test('a command returns when it leaves a process running in the background', { skip: noDocker }, async () => {
	const { machine } = await dockerSandboxProvider({ baseImage: IMAGE }).acquire({ key: keyFor('bg'), state: null, image: null, baseImage: null, ports: [], resources });
	const started = Date.now();
	const result = await machine.exec('sleep 20 & echo started');
	assert.equal(out(result), 'started');
	assert.ok(Date.now() - started < 5000, 'did not wait for the background job');
});

test('a task on the none network is offline', { skip: noDocker }, async () => {
	const { machine } = await dockerSandboxProvider({ baseImage: IMAGE, network: 'none' }).acquire({ key: keyFor('offline'), state: null, image: null, baseImage: null, ports: [], resources });
	assert.equal(out(await machine.exec('ls /sys/class/net')), 'lo');
});
