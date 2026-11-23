import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hono } from 'hono';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-mcp-servers-'));
process.env.ANTON_DATA_DIR = dir;

const { ConflictError, InvalidInputError } = await import('../src/core/errors.ts');
const { setMcpSignIn, updateMcpServerRow } = await import('../src/db/mcp-servers.ts');
const { connectorRoutes } = await import('../src/routes/connectors.ts');
const { addMcpServer, enabledMcpServers, mcpServerStates, mcpServersView, removeMcpServer, updateMcpServer } = await import('../src/services/connectors/mcp-servers.ts');
const { resetMcpToolsForTests, serverTools } = await import('../src/services/connectors/mcp-tools.ts');

after(async () => {
	await resetMcpToolsForTests();
	rmSync(dir, { recursive: true, force: true });
});

test('custom MCP servers allow capital letters, long tokens (>4000 chars), and custom headers', async () => {
	const api = new Hono();
	api.onError((err, c) => {
		const status = err instanceof InvalidInputError ? 400 : err instanceof ConflictError ? 409 : 500;
		return c.json({ error: err.message }, status);
	});
	api.route('/', connectorRoutes);

	const longToken = 'A'.repeat(5500);
	const longHeader = 'B'.repeat(5500);

	// Route validation accepts uppercase letters, spaces, 5500-char tokens, and custom headers.
	const created = await api.request('/api/mcp-servers', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			name: 'AWS CLI',
			url: 'https://aws-mcp.us-east-1.api.aws/mcp',
			auth: longToken,
			headers: { 'X-API-Key': 'secret-key', 'X-Amz-Security-Token': longHeader },
			tools: [],
		}),
	});
	assert.equal(created.status, 200);
	const createdBody = (await created.json()) as { mcpServers: Array<{ name: string; hasAuth: boolean; headerNames: string[] }> };
	const awsView = createdBody.mcpServers.find((server) => server.name === 'AWS CLI');
	assert.ok(awsView);
	assert.equal(awsView.hasAuth, true);
	assert.deepEqual(awsView.headerNames, ['X-Amz-Security-Token', 'X-API-Key']);
	assert.ok(!JSON.stringify(createdBody).includes('secret-key'), 'custom header values never appear in the view');
	assert.ok(!JSON.stringify(createdBody).includes(longToken), 'tokens never appear in the view');
	assert.ok(!JSON.stringify(createdBody).includes(longHeader), 'long header values never appear in the view');

	// Rejects new names that collide with or overlap an existing server's full tool prefix (including trailing __, e.g. AWS CLI vs AWS CLI_).
	for (const colliding of ['AWS-CLI', 'AWS_CLI', 'AWS CLI_', 'AWS CLI  extra']) {
		const res = await api.request('/api/mcp-servers', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: colliding, url: 'https://other.example.test/mcp', tools: [] }),
		});
		assert.equal(res.status, 409, `rejects colliding/overlapping normalized name ${colliding}`);
		const errBody = (await res.json()) as { error: string };
		assert.match(errBody.error, /tool namespace/);
	}

	// Both directions of prefix overlap are rejected (short then long, and long then short, including trailing _), while single-_ distinct names coexist.
	await addMcpServer({ name: 'aws', url: 'https://aws.example.test/mcp', tools: [] });
	await assert.rejects(addMcpServer({ name: 'aws_', url: 'https://aws2.example.test/mcp', tools: [] }), /overlapping tool namespace/);
	await assert.rejects(addMcpServer({ name: 'aws  cli', url: 'https://aws2.example.test/mcp', tools: [] }), /overlapping tool namespace/);
	await addMcpServer({ name: 'aws_cli', url: 'https://aws3.example.test/mcp', tools: [] });
	await removeMcpServer('aws');
	await removeMcpServer('aws_cli');
	await addMcpServer({ name: 'aws_', url: 'https://aws2.example.test/mcp', tools: [] });
	await assert.rejects(addMcpServer({ name: 'aws', url: 'https://aws.example.test/mcp', tools: [] }), /overlapping tool namespace/);
	await removeMcpServer('aws_');
	await addMcpServer({ name: 'aws  cli', url: 'https://aws2.example.test/mcp', tools: [] });
	await assert.rejects(addMcpServer({ name: 'aws', url: 'https://aws.example.test/mcp', tools: [] }), /overlapping tool namespace/);
	await removeMcpServer('aws  cli');

	// Edits are update-only: deleting a server and inserting a colliding one never lets an in-flight edit recreate the deleted row.
	await addMcpServer({ name: 'Edit Target', url: 'https://edit.example.test/mcp', tools: [] });
	const beforeEdit = (await mcpServersView()).find((s) => s.name === 'Edit Target')!;
	await removeMcpServer('Edit Target');
	await addMcpServer({ name: 'Edit-Target', url: 'https://edit2.example.test/mcp', tools: [] });
	const recreated = await updateMcpServerRow({ name: 'Edit Target', url: 'https://edit.example.test/mcp/v2', auth: null, headers: {}, tools: [] }, beforeEdit.addedAt);
	assert.equal(recreated, false, 'update-only edit refuses to recreate a deleted server');
	assert.deepEqual(
		(await mcpServersView()).filter((s) => s.name.startsWith('Edit')).map((s) => s.name),
		['Edit-Target'],
	);
	await removeMcpServer('Edit-Target');
	// Deleting and recreating with the same name changes addedAt, so a stale edit fails instead of silently overwriting the replacement.
	await new Promise((resolve) => setTimeout(resolve, 2));
	await addMcpServer({ name: 'Edit Target', url: 'https://edit-new.example.test/mcp', tools: [] });
	const overwrote = await updateMcpServerRow({ name: 'Edit Target', url: 'https://edit-old.example.test/mcp', auth: null, headers: {}, tools: [] }, beforeEdit.addedAt);
	assert.equal(overwrote, false, 'stale edit refuses to overwrite a recreated server');
	await removeMcpServer('Edit Target');

	// Concurrent adds with colliding namespaces are serialized atomically: exactly one succeeds and one is rejected.
	const concurrent = await Promise.allSettled([
		addMcpServer({ name: 'Race CLI', url: 'https://race1.example.test/mcp', tools: [] }),
		addMcpServer({ name: 'Race-CLI', url: 'https://race2.example.test/mcp', tools: [] }),
	]);
	assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one concurrent conflicting add succeeds');
	assert.equal(concurrent.filter((r) => r.status === 'rejected').length, 1, 'the other concurrent conflicting add is rejected');
	const raceWinner = (await mcpServersView()).filter((s) => s.name === 'Race CLI' || s.name === 'Race-CLI');
	assert.equal(raceWinner.length, 1);
	await removeMcpServer(raceWinner[0].name);

	// Verify stored token and headers stay on the same host, retain case-insensitively on null, drop on host change, and update/remove cleanly.
	const stored = async () => (await enabledMcpServers()).find((server) => server.name === 'AWS CLI')!;
	assert.equal((await stored()).auth, longToken);
	assert.deepEqual((await stored()).headers, { 'X-API-Key': 'secret-key', 'X-Amz-Security-Token': longHeader });

	// Keeping stored header via null with different casing ('x-api-key' retains 'X-API-Key'), adding X-Region, removing X-Amz-Security-Token by omitting it.
	const updated = await api.request(`/api/mcp-servers/${encodeURIComponent('AWS CLI')}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			url: 'https://aws-mcp.us-east-1.api.aws/mcp/v2',
			auth: null,
			headers: { 'x-api-key': null, 'X-Region': 'us-east-1' },
			tools: [],
		}),
	});
	assert.equal(updated.status, 200);
	assert.equal((await stored()).auth, longToken);
	assert.deepEqual((await stored()).headers, { 'x-api-key': 'secret-key', 'X-Region': 'us-east-1' });

	// A custom Authorization header takes precedence before OAuth lookup, so a broken/expired OAuth sign-in does not make the connector unusable.
	await setMcpSignIn('AWS CLI', { problem: 'The server no longer accepts the sign-in. Sign in again.' });
	assert.equal((await mcpServerStates()).find((s) => s.name === 'AWS CLI')?.state, 'needs-sign-in');
	await updateMcpServer('AWS CLI', {
		url: 'https://aws-mcp.us-east-1.api.aws/mcp/v2',
		auth: null,
		headers: { 'x-api-key': null, Authorization: 'ApiKey override-token' },
		tools: [],
	});
	const withAuthHeader = (await mcpServerStates()).find((s) => s.name === 'AWS CLI')!;
	assert.equal(withAuthHeader.state, 'on');
	assert.equal(withAuthHeader.problem, null);
	assert.equal(withAuthHeader.server?.headers?.Authorization, 'ApiKey override-token');

	// Moving to another host drops stored token and stored headers unless newly provided.
	await updateMcpServer('AWS CLI', { url: 'https://other-host.example.test/mcp', auth: null, headers: { 'x-api-key': null }, tools: [] });
	assert.equal((await stored()).auth, null);
	assert.equal((await stored()).headers, undefined);

	// Rejects invalid headers (CRLF injection, forbidden HTTP/MCP transport headers, duplicates, whitespace-padded names, smart quotes/control chars) and oversized tokens (>32000), without echoing credentials.
	const badInputs: Array<{ payload: Record<string, unknown>; secret?: string }> = [
		{ payload: { name: 'BadToken', url: 'https://example.test/mcp', auth: 'x'.repeat(32_001), tools: [] } },
		{ payload: { name: 'BadHeader', url: 'https://example.test/mcp', headers: { Host: 'evil.test' }, tools: [] } },
		{ payload: { name: 'BadMcpSession', url: 'https://example.test/mcp', headers: { 'MCP-Session-Id': 'sess-1' }, tools: [] } },
		{ payload: { name: 'BadMcpProto', url: 'https://example.test/mcp', headers: { 'Mcp-Protocol-Version': '2025-03-26' }, tools: [] } },
		{ payload: { name: 'BadMcpMethod', url: 'https://example.test/mcp', headers: { 'Mcp-Method': 'tools/list' }, tools: [] } },
		{ payload: { name: 'BadMcpName', url: 'https://example.test/mcp', headers: { 'Mcp-Name': 'x' }, tools: [] } },
		{ payload: { name: 'BadLastEvent', url: 'https://example.test/mcp', headers: { 'Last-Event-ID': '1' }, tools: [] } },
		{ payload: { name: 'BadContentType', url: 'https://example.test/mcp', headers: { 'Content-Type': 'text/plain' }, tools: [] } },
		{ payload: { name: 'BadAccept', url: 'https://example.test/mcp', headers: { Accept: 'text/plain' }, tools: [] } },
		{ payload: { name: 'BadCrlf', url: 'https://example.test/mcp', headers: { 'X-Test': 'a\r\nb' }, tools: [] } },
		{ payload: { name: 'DupHeader', url: 'https://example.test/mcp', headers: { 'X-Key': '1', 'x-key': '2' }, tools: [] } },
		{ payload: { name: 'PadDup', url: 'https://example.test/mcp', headers: { 'X-Key': '1', ' X-Key ': '2' }, tools: [] } },
		{ payload: { name: 'PadName', url: 'https://example.test/mcp', headers: { ' X-Key ': '1' }, tools: [] } },
		{ payload: { name: 'SmartToken', url: 'https://example.test/mcp', auth: 'my-secret-token-\u201csmart\u201d', tools: [] }, secret: 'my-secret-token' },
		{ payload: { name: 'SmartHeader', url: 'https://example.test/mcp', headers: { 'X-API-Key': 'my-secret-header-\u201csmart\u201d' }, tools: [] }, secret: 'my-secret-header' },
		{ payload: { name: 'CtrlHeader', url: 'https://example.test/mcp', headers: { 'X-API-Key': 'my-secret-ctrl-\x07bell' }, tools: [] }, secret: 'my-secret-ctrl' },
	];
	for (const { payload, secret } of badInputs) {
		const response = await api.request('/api/mcp-servers', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		});
		assert.equal(response.status, 400, `rejects invalid payload ${String(payload.name)}`);
		const text = await response.text();
		if (secret) assert.ok(!text.includes(secret), `error for ${String(payload.name)} must not echo the credential`);
	}

	// Custom Authorization header override remains allowed by route validation.
	const withAuth = await api.request('/api/mcp-servers', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'AuthOverride', url: 'https://auth.example.test/mcp', headers: { Authorization: 'ApiKey k1' }, tools: [] }),
	});
	assert.equal(withAuth.status, 200);
	await removeMcpServer('AuthOverride');

	// Verify custom headers are sent on HTTP MCP requests, custom Authorization overrides Bearer, same-origin redirects work, and off-origin redirects never receive headers.
	const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];
	const attackerRequests: Array<Record<string, string | string[] | undefined>> = [];
	const attacker = createServer((req, res) => {
		attackerRequests.push({ ...req.headers });
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end('{}');
	});
	await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', resolve));
	const attackerUrl = `http://127.0.0.1:${(attacker.address() as AddressInfo).port}/steal`;

	const http = createServer((req, res) => {
		if (req.url === '/redirect-off-origin') {
			res.writeHead(307, { location: attackerUrl });
			return void res.end();
		}
		if (req.url === '/redirect-same-origin') {
			res.writeHead(307, { location: '/mcp' });
			return void res.end();
		}
		seenHeaders.push({ ...req.headers });
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			const msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { id?: number; method?: string };
			const reply = (result: unknown) => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
			};
			if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'aws', version: '1' } });
			if (msg.method === 'tools/list') return reply({ tools: [{ name: 'describe', description: 'Describe resources', inputSchema: { type: 'object', properties: {} } }] });
			res.writeHead(202).end();
		});
	});
	await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
	try {
		const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
		const url = `${origin}/mcp`;
		const tools = await serverTools({
			name: 'AWS',
			url,
			auth: 'bearer-tok',
			headers: { 'X-Custom-Key': 'my-key', 'X-Region': 'us-east-1' },
			tools: [],
		});
		assert.deepEqual(tools.map((t) => t.name), ['describe']);
		assert.ok(seenHeaders.some((h) => h.authorization === 'Bearer bearer-tok' && h['x-custom-key'] === 'my-key' && h['x-region'] === 'us-east-1'));

		seenHeaders.length = 0;
		await serverTools({
			name: 'AWS',
			url,
			auth: 'bearer-tok',
			headers: { Authorization: 'AWS4-HMAC-SHA256 sig' },
			tools: [],
		});
		assert.ok(seenHeaders.some((h) => h.authorization === 'AWS4-HMAC-SHA256 sig'));

		// Same-origin redirect preserves headers on the configured origin.
		seenHeaders.length = 0;
		const redirectedTools = await serverTools({
			name: 'AWS',
			url: `${origin}/redirect-same-origin`,
			auth: null,
			headers: { 'X-Custom-Key': 'same-origin-key' },
			tools: [],
		});
		assert.deepEqual(redirectedTools.map((t) => t.name), ['describe']);
		assert.ok(seenHeaders.some((h) => h['x-custom-key'] === 'same-origin-key'));

		// Off-origin redirect is blocked and the destination never receives the header.
		await assert.rejects(
			serverTools({
				name: 'AWS',
				url: `${origin}/redirect-off-origin`,
				auth: 'secret-bearer',
				headers: { 'X-API-Key': 'secret-api-key' },
				tools: [],
			}),
			/different origin/,
		);
		assert.equal(attackerRequests.length, 0, 'off-origin redirect destination must never receive any request or credential header');
	} finally {
		await removeMcpServer('AWS CLI').catch(() => undefined);
		await resetMcpToolsForTests();
		await new Promise((resolve) => http.close(resolve));
		await new Promise((resolve) => attacker.close(resolve));
	}
});
