import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createClient } from '@libsql/client';
import { migrate, migrations } from '../src/db/migrations.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'anton-migrations-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test("each repository's MCP servers move to the servers every task gets, the first of a name kept", async () => {
	const db = createClient({ url: `file:${path.join(dir, 'anton.db')}` });
	const global = migrations.findIndex((statements) => statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS mcp_servers')));
	await migrate(db, global);
	const add = (id: string, at: string, servers: unknown) =>
		db.execute({
			sql: `INSERT INTO projects (id, user_id, repo_full_name, default_branch, workspace_path, updated_at, mcp_json) VALUES (?, 'me', ?, 'main', '', ?, ?)`,
			args: [id, `acme/${id}`, at, servers === null ? null : JSON.stringify(servers)],
		});
	await add('older', '2026-01-01', [
		{ name: 'tracker', url: 'https://tracker.example.test/mcp', auth: 'token-1', tools: ['find'] },
		{ name: 'docs', url: 'https://docs.example.test/mcp', auth: null, tools: [], codeMode: false },
	]);
	await add('newer', '2026-02-01', [{ name: 'tracker', url: 'https://other.example.test/mcp', auth: 'token-2', tools: [] }]);
	await add('none', '2026-03-01', null);
	await migrate(db);
	const rows = (await db.execute('SELECT name, url, auth, tools_json, code_mode, enabled FROM mcp_servers ORDER BY name')).rows.map((row) => ({ ...row }));
	assert.deepEqual(rows, [
		{ name: 'docs', url: 'https://docs.example.test/mcp', auth: null, tools_json: '[]', code_mode: 0, enabled: 1 },
		{ name: 'tracker', url: 'https://tracker.example.test/mcp', auth: 'token-1', tools_json: '["find"]', code_mode: 1, enabled: 1 },
	]);
	db.close();
});
