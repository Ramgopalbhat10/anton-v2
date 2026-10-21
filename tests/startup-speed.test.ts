import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createClient } from '@libsql/client';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-startup-'));
process.env.ANTON_DATA_DIR = dir;

const { unsettledTasks } = await import('../src/services/agent-runner.ts');
const { knownServerTools, resetMcpToolsForTests, warmServerTools } = await import('../src/services/mcp-tools.ts');

after(async () => {
	await resetMcpToolsForTests();
	rmSync(dir, { recursive: true, force: true });
});

test('startup waits only for the tasks whose replies the runtime will resume', async () => {
	const file = path.join(dir, 'flue.db');
	assert.deepEqual(await unsettledTasks(file), new Set(), 'no runtime record yet: nothing to resume');
	const flue = createClient({ url: `file:${file}` });
	await flue.execute('CREATE TABLE flue_agent_submissions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, status TEXT NOT NULL)');
	const key = (agent: string, id: string) => `agent-session:${JSON.stringify([agent, id, 'default', 'default'])}`;
	for (const [agent, id, status] of [
		['Coder', 'task-done', 'settled'],
		['Coder', 'task-cut-off', 'running'],
		['Coder', 'task-queued', 'queued'],
		['Reviewer', 'task-reviewed', 'running'],
	]) {
		await flue.execute({ sql: 'INSERT INTO flue_agent_submissions (session_key, status) VALUES (?, ?)', args: [key(agent, id), status] });
	}
	flue.close();
	assert.deepEqual([...((await unsettledTasks(file)) ?? [])].sort(), ['task-cut-off', 'task-queued', 'task-reviewed']);
	const other = path.join(dir, 'other.db');
	const empty = createClient({ url: `file:${other}` });
	await empty.execute('CREATE TABLE something_else (id TEXT)');
	empty.close();
	assert.equal(await unsettledTasks(other), null, 'a record it cannot read primes every task, as before');
});

test('a message waits for an MCP server never read, but not for one read before while it is read again', async () => {
	const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
	const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
	let delayMs = 0;
	const http = createServer(async (request, response) => {
		if (request.method !== 'POST') return void response.writeHead(405).end();
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		if (body.method === 'tools/list') await new Promise((resolve) => setTimeout(resolve, delayMs));
		const server = new McpServer({ name: 'tracker', version: '1' });
		server.registerTool('find_issues', { description: 'Find issues.' }, async () => ({ content: [{ type: 'text', text: 'none' }] }));
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		response.on('close', () => void transport.close());
		await server.connect(transport);
		await transport.handleRequest(request, response, body);
	});
	await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
	const server = { name: 'tracker', url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, auth: null, tools: [] };
	const realNow = Date.now;
	try {
		await warmServerTools([server], 5000);
		assert.deepEqual(knownServerTools(server)?.map((tool) => tool.name), ['find_issues'], 'read before the first message');

		// Its list is old now, and the server has become slow.
		delayMs = 2000;
		Date.now = () => realNow() + 11 * 60_000;
		const started = realNow();
		await warmServerTools([server], 5000);
		assert.ok(realNow() - started < 500, 'the next message does not wait for it');
		assert.deepEqual(knownServerTools(server)?.map((tool) => tool.name), ['find_issues'], 'the list read before stays meanwhile');
	} finally {
		Date.now = realNow;
		await resetMcpToolsForTests();
		await new Promise((resolve) => http.close(resolve));
	}
});
