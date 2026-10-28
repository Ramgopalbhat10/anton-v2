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

test("a schedule's runs from before tasks kept their routine are found by title, and those left idle are done", async () => {
	const db = createClient({ url: `file:${path.join(dir, 'routines.db')}` });
	const kept = migrations.findIndex((statements) => statements.some((sql) => sql.includes('ADD COLUMN automation_id')));
	await migrate(db, kept);
	const prompt = 'Go through the internet and capture the latest news on tech and AI from yesterday, with every source linked\nKeep it short.';
	await db.execute({
		sql: `INSERT INTO automations (id, project_id, kind, every_hours, prompt, created_at, space_id) VALUES ('auto_1', '', 'schedule', 24, ?, '2026-10-01', 'space_1')`,
		args: [prompt],
	});
	// As runs were titled: the first line, cut at 80.
	const title = prompt.split('\n')[0].slice(0, 80);
	const add = (id: string, columns: Record<string, string | null>) =>
		db.execute({
			sql: `INSERT INTO sessions (id, project_id, flue_conversation_id, status, model, title, created_at, space_id, ${Object.keys(columns).join(', ')}) VALUES (?, '', ?, 'stopped', 'm', ?, '2026-10-02', 'space_1', ${Object.keys(columns).map(() => '?').join(', ')})`,
			args: [id, id, columns.title ?? title, ...Object.values(columns)],
		});
	await add('replied', { last_reply: 'Here is the briefing.' });
	await add('asks', { last_reply: 'Broad or narrow?', asking: 'Broad or narrow?' });
	await add('other', { title: 'Fix the login page', last_reply: 'Fixed.' });
	await migrate(db);
	const rows = Object.fromEntries((await db.execute('SELECT id, automation_id, resolved_at FROM sessions')).rows.map((row) => [row.id, { routine: row.automation_id, done: row.resolved_at !== null }]));
	assert.deepEqual(rows, {
		replied: { routine: 'auto_1', done: true },
		asks: { routine: 'auto_1', done: false },
		other: { routine: null, done: false },
	});
	db.close();
});

test('routines that ran every few hours move to schedules on the UTC clock, at the time they last ran', async () => {
	const db = createClient({ url: `file:${path.join(dir, 'schedules.db')}` });
	const scheduled = migrations.findIndex((statements) => statements.some((sql) => sql.includes('ADD COLUMN schedule_json')));
	await migrate(db, scheduled);
	const add = (id: string, hours: number, lastRun: string | null) =>
		db.execute({
			sql: `INSERT INTO automations (id, project_id, kind, every_hours, prompt, created_at, last_run_at) VALUES (?, '', 'schedule', ?, 'x', '2026-10-01T03:30:00.000Z', ?)`,
			args: [id, hours, lastRun],
		});
	await add('daily', 24, '2026-10-20T13:45:12.345Z');
	await add('six', 6, null);
	await add('five', 5, null);
	await add('two-days', 48, null);
	await add('weekly', 168, null);
	await db.execute(`INSERT INTO automations (id, project_id, kind, label, prompt, created_at) VALUES ('issues', 'p', 'issues', 'anton', '', '2026-10-01')`);
	await migrate(db);
	const rows = Object.fromEntries(
		(await db.execute('SELECT id, schedule_json FROM automations')).rows.map((row) => {
			const schedule = row.schedule_json == null ? null : JSON.parse(String(row.schedule_json));
			return [row.id, schedule && { frequency: schedule.frequency, time: schedule.time, everyHours: schedule.everyHours, days: schedule.days, cron: schedule.cron, timeZone: schedule.timeZone }];
		}),
	);
	assert.deepEqual(rows, {
		daily: { frequency: 'daily', time: '13:45', everyHours: 12, days: [2], cron: '', timeZone: 'UTC' },
		six: { frequency: 'hourly', time: '03:30', everyHours: 6, days: [4], cron: '', timeZone: 'UTC' },
		five: { frequency: 'hourly', time: '03:30', everyHours: 4, days: [4], cron: '', timeZone: 'UTC' },
		'two-days': { frequency: 'cron', time: '03:30', everyHours: 12, days: [4], cron: '30 3 */2 * *', timeZone: 'UTC' },
		weekly: { frequency: 'weekly', time: '03:30', everyHours: 12, days: [4], cron: '', timeZone: 'UTC' },
		issues: null,
	});
	db.close();
});

test("each task's pull request starts its list of pull requests, in the state last read", async () => {
	const db = createClient({ url: `file:${path.join(dir, 'pulls.db')}` });
	const listed = migrations.findIndex((statements) => statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS pull_requests')));
	await migrate(db, listed);
	await db.execute(`INSERT INTO projects (id, user_id, repo_full_name, default_branch, workspace_path, updated_at) VALUES ('p1', 'me', 'acme/demo', 'main', '', '2026-10-01')`);
	const add = (id: string, prUrl: string | null, prJson: string | null) =>
		db.execute({
			sql: `INSERT INTO sessions (id, project_id, flue_conversation_id, status, model, title, created_at, branch, base_branch, pr_url, pr_json) VALUES (?, 'p1', ?, 'stopped', 'm', ?, '2026-10-02', 'anton/x', 'main', ?, ?)`,
			args: [id, id, `Task ${id}`, prUrl, prJson],
		});
	await add('merged', 'https://github.com/acme/demo/pull/12', JSON.stringify({ url: 'https://github.com/acme/demo/pull/12', state: 'merged', checks: null, runs: [] }));
	await add('stale', 'https://github.com/acme/demo/pull/13', JSON.stringify({ url: 'https://github.com/acme/demo/pull/7', state: 'open', checks: null, runs: [] }));
	await add('none', null, null);
	await migrate(db);
	const rows = (await db.execute('SELECT session_id, repo, number, title, head, base, state FROM pull_requests ORDER BY number')).rows.map((row) => ({ ...row }));
	assert.deepEqual(rows, [
		{ session_id: 'merged', repo: 'acme/demo', number: 12, title: 'Task merged', head: 'anton/x', base: 'main', state: 'merged' },
		{ session_id: 'stale', repo: 'acme/demo', number: 13, title: 'Task stale', head: 'anton/x', base: 'main', state: null },
	]);
	db.close();
});
