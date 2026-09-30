import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { ensureAccessToken, githubClientFromEnv, markGitHubReconnect } from './auth.ts';
import { appDb, migrateAppDb } from './db-app.ts';
import { env } from './env.ts';
import { GitHubReconnectError } from './github.ts';
import { publishPullRequest } from './vm-proxy.ts';
import { DEFAULT_MODEL, isOpenRouterModel } from './models.ts';
import {
	attachLocalSandbox,
	cloneRepo,
	ensureLocalWorkspace,
	getWarmSandbox,
	releaseSandbox,
} from './sandbox.ts';

export type SessionStatus = 'starting' | 'running' | 'error' | 'stopped';

export type Session = {
	id: string;
	projectId: string;
	flueConversationId: string;
	sandboxId: string | null;
	status: SessionStatus;
	model: string;
	prUrl: string | null;
	errorMessage: string | null;
	createdAt: string;
	title: string;
};

export type Project = {
	id: string;
	userId: string;
	repoFullName: string;
	defaultBranch: string;
	snapshotImageId: string | null;
	workspacePath: string;
};

const conversationWorkspace = new Map<string, string>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const IDLE_MS = 15 * 60 * 1000;

function rowToSession(row: Record<string, unknown>): Session {
	return {
		id: String(row.id),
		projectId: String(row.project_id),
		flueConversationId: String(row.flue_conversation_id),
		sandboxId: row.sandbox_id ? String(row.sandbox_id) : null,
		status: String(row.status) as SessionStatus,
		model: String(row.model),
		prUrl: row.pr_url ? String(row.pr_url) : null,
		errorMessage: row.error_message ? String(row.error_message) : null,
		createdAt: String(row.created_at),
		title: String(row.title ?? 'New chat'),
	};
}

export async function ensureDevProject(db: Client = appDb()): Promise<Project> {
	await migrateAppDb(db);
	const now = new Date().toISOString();
	const userId = 'user_dev';
	const projectId = 'proj_dev';
	await db.execute({
		sql: `INSERT OR IGNORE INTO users (id, github_id, login, avatar_url, created_at)
			VALUES (?, ?, ?, ?, ?)`,
		args: [userId, null, 'anton-dev', null, now],
	});
	const workspacePath = await ensureLocalWorkspace(projectId, 'local/anton-v2');
	await db.execute({
		sql: `INSERT OR IGNORE INTO projects (id, user_id, repo_full_name, default_branch, snapshot_image_id, workspace_path, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
		args: [projectId, userId, 'local/anton-v2', 'main', null, workspacePath, now],
	});
	const result = await db.execute({
		sql: 'SELECT * FROM projects WHERE id = ?',
		args: [projectId],
	});
	const row = result.rows[0] as Record<string, unknown>;
	return rowToProject(row);
}

export async function getProject(id: string, db: Client = appDb()): Promise<Project | null> {
	const result = await db.execute({ sql: 'SELECT * FROM projects WHERE id = ?', args: [id] });
	const row = result.rows[0] as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToProject(row);
}

export function cwdForConversation(conversationId: string): string | undefined {
	return conversationWorkspace.get(conversationId);
}

export async function createSession(input: {
	projectId?: string;
	model?: string;
	title?: string;
}, db: Client = appDb()): Promise<Session> {
	await migrateAppDb(db);
	const project = input.projectId
		? await getProject(input.projectId, db)
		: await ensureDevProject(db);
	if (!project) throw new Error('Project not found');

	const warm = getWarmSandbox(project.id);
	if (!warm) {
		attachLocalSandbox(project.id, project.workspacePath);
	}
	const sandbox = getWarmSandbox(project.id);
	if (!sandbox) throw new Error('Failed to attach sandbox');

	const model = input.model && isOpenRouterModel(input.model) ? input.model : env.defaultModel || DEFAULT_MODEL;
	const id = randomUUID();
	const now = new Date().toISOString();
	const title = input.title?.trim() || 'New chat';

	await db.execute({
		sql: `INSERT INTO sessions (id, project_id, flue_conversation_id, sandbox_id, status, model, pr_url, error_message, title, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [id, project.id, id, sandbox.id, 'running', model, null, null, title, now],
	});

	conversationWorkspace.set(id, project.workspacePath);
	bumpIdle(id, db);

	return {
		id,
		projectId: project.id,
		flueConversationId: id,
		sandboxId: sandbox.id,
		status: 'running',
		model,
		prUrl: null,
		errorMessage: null,
		createdAt: now,
		title,
	};
}

export async function createGitHubProject(
	input: {
		userId: string;
		repoFullName: string;
		defaultBranch: string;
		token: string | null;
		userName: string;
		userEmail: string;
		cloneUrl?: string;
		workspacesRoot?: string;
	},
	db: Client = appDb(),
): Promise<Project> {
	await migrateAppDb(db);
	const existing = await db.execute({
		sql: 'SELECT * FROM projects WHERE user_id = ? AND repo_full_name = ?',
		args: [input.userId, input.repoFullName],
	});
	const existingRow = existing.rows[0] as Record<string, unknown> | undefined;
	if (existingRow) return rowToProject(existingRow);

	const id = randomUUID();
	const workspacePath = await cloneRepo({
		projectId: id,
		cloneUrl: input.cloneUrl ?? `https://github.com/${input.repoFullName}.git`,
		token: input.token,
		defaultBranch: input.defaultBranch,
		userName: input.userName,
		userEmail: input.userEmail,
		workspacesRoot: input.workspacesRoot,
	});
	const now = new Date().toISOString();
	await db.execute({
		sql: `INSERT INTO projects (id, user_id, repo_full_name, default_branch, snapshot_image_id, workspace_path, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
		args: [id, input.userId, input.repoFullName, input.defaultBranch, null, workspacePath, now],
	});
	const project = await getProject(id, db);
	if (!project) throw new Error('Project not found');
	return project;
}

export async function listProjects(userId: string, db: Client = appDb()): Promise<Project[]> {
	const result = await db.execute({
		sql: 'SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC',
		args: [userId],
	});
	return result.rows.map((row) => rowToProject(row as Record<string, unknown>));
}

export async function projectByWorkspace(cwd: string, db: Client = appDb()): Promise<Project | null> {
	const result = await db.execute({ sql: 'SELECT * FROM projects WHERE workspace_path = ?', args: [cwd] });
	const row = result.rows[0] as Record<string, unknown> | undefined;
	return row ? rowToProject(row) : null;
}

function rowToProject(row: Record<string, unknown>): Project {
	return {
		id: String(row.id),
		userId: String(row.user_id),
		repoFullName: String(row.repo_full_name),
		defaultBranch: String(row.default_branch),
		snapshotImageId: row.snapshot_image_id ? String(row.snapshot_image_id) : null,
		workspacePath: String(row.workspace_path),
	};
}

export async function listSessions(db: Client = appDb(), userId?: string): Promise<Session[]> {
	await migrateAppDb(db);
	if (!userId) await ensureDevProject(db);
	const result = userId
		? await db.execute({
				sql: `SELECT sessions.* FROM sessions
					JOIN projects ON projects.id = sessions.project_id
					WHERE projects.user_id = ?
					ORDER BY sessions.created_at DESC`,
				args: [userId],
			})
		: await db.execute('SELECT * FROM sessions ORDER BY created_at DESC');
	return result.rows.map((row) => rowToSession(row as Record<string, unknown>));
}

export async function getSession(id: string, db: Client = appDb()): Promise<Session | null> {
	const result = await db.execute({ sql: 'SELECT * FROM sessions WHERE id = ?', args: [id] });
	const row = result.rows[0] as Record<string, unknown> | undefined;
	if (!row) return null;
	const session = rowToSession(row);
	const project = await getProject(session.projectId, db);
	if (project && session.status === 'running' && session.sandboxId) {
		conversationWorkspace.set(session.flueConversationId, project.workspacePath);
		attachLocalSandbox(project.id, project.workspacePath);
	}
	return session;
}

export async function updateSessionModel(id: string, model: string, db: Client = appDb()): Promise<Session> {
	if (!isOpenRouterModel(model)) throw new Error('Unknown model');
	await db.execute({ sql: 'UPDATE sessions SET model = ? WHERE id = ?', args: [model, id] });
	const session = await getSession(id, db);
	if (!session) throw new Error('Session not found');
	return session;
}

export async function setSessionPrUrl(id: string, prUrl: string, db: Client = appDb()): Promise<void> {
	await db.execute({ sql: 'UPDATE sessions SET pr_url = ? WHERE id = ?', args: [prUrl, id] });
}

export async function openWorkspacePullRequest(
	cwd: string,
	title = 'feat: anton agent changes',
	db: Client = appDb(),
): Promise<string> {
	const project = await projectByWorkspace(cwd, db);
	const local = async () => {
		const url = await publishPullRequest({
			cwd,
			title,
			token: null,
			repoFullName: null,
			defaultBranch: project?.defaultBranch ?? 'main',
		});
		if (project) await attachPullRequest(cwd, url, db);
		return url;
	};
	if (!project) return local();
	const tokenRow = await db.execute({
		sql: 'SELECT user_id FROM oauth_tokens WHERE user_id = ?',
		args: [project.userId],
	});
	if (!tokenRow.rows[0]) return local();
	try {
		const token = await ensureAccessToken(project.userId, db, githubClientFromEnv());
		const url = await publishPullRequest({
			cwd,
			title,
			token,
			repoFullName: project.repoFullName,
			defaultBranch: project.defaultBranch,
		});
		await attachPullRequest(cwd, url, db);
		return url;
	} catch (error) {
		if (error instanceof GitHubReconnectError) await markGitHubReconnect(project.userId, db);
		throw error;
	}
}

export async function attachPullRequest(cwd: string, prUrl: string, db: Client = appDb()): Promise<void> {
	const result = await db.execute({
		sql: `SELECT sessions.id FROM sessions
			JOIN projects ON projects.id = sessions.project_id
			WHERE projects.workspace_path = ? AND sessions.status = 'running'`,
		args: [cwd],
	});
	for (const row of result.rows) {
		await setSessionPrUrl(String(row.id), prUrl, db);
	}
}

export async function stopSession(id: string, db: Client = appDb()): Promise<Session> {
	const session = await getSession(id, db);
	if (!session) throw new Error('Session not found');
	const project = await getProject(session.projectId, db);
	clearIdle(id);
	if (project) {
		const others = await db.execute({
			sql: `SELECT id FROM sessions WHERE project_id = ? AND status = 'running' AND id != ?`,
			args: [project.id, id],
		});
		if (others.rows.length === 0) {
			releaseSandbox(project.id);
		}
	}
	await db.execute({
		sql: `UPDATE sessions SET status = 'stopped', sandbox_id = NULL WHERE id = ?`,
		args: [id],
	});
	conversationWorkspace.delete(session.flueConversationId);
	const stopped = await getSession(id, db);
	if (!stopped) throw new Error('Session not found after stop');
	return { ...stopped, status: 'stopped', sandboxId: null };
}

function clearIdle(id: string): void {
	const timer = idleTimers.get(id);
	if (timer) clearTimeout(timer);
	idleTimers.delete(id);
}

export function bumpIdle(id: string, db: Client = appDb()): void {
	clearIdle(id);
	const timer = setTimeout(() => {
			void stopSession(id, db);
		}, IDLE_MS);
	timer.unref?.();
	idleTimers.set(id, timer);
}

export function runningSandboxCount(projectId: string): number {
	return getWarmSandbox(projectId) ? 1 : 0;
}
