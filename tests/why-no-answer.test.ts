import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { whyNoAnswer } from '../src/services/why-no-answer.ts';

test('a service that takes the connection and then says nothing is the slow one, not this server', async () => {
	const server = createServer(() => {});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	try {
		const why = await whyNoAnswer(`http://localhost:${port}/`, 10_000);
		assert.match(why, /^localhost did not answer within 10\.0s\. The lookup took \d+ms and connecting \d+ms, so the service itself was slow/);
	} finally {
		server.close();
	}
});

test('a name that cannot be looked up points at this server’s DNS', async () => {
	const why = await whyNoAnswer('https://nothing-here.invalid/api', 10_000);
	assert.match(why, /^nothing-here\.invalid did not answer within 10\.0s\. Its address could not be looked up .*check this server's DNS\.$/);
});

test('a port nothing listens on cannot be reached', async () => {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	await new Promise<void>((resolve) => server.close(() => resolve()));
	const why = await whyNoAnswer(`http://127.0.0.1:${port}/`, 10_000);
	assert.match(why, /connecting failed \(.*ECONNREFUSED.*\), so this server cannot reach it; check its network\.$/);
});
