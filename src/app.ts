import { randomBytes } from 'node:crypto';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Coder } from './agents/coder.ts';
import {
	ensureAccessToken,
	finishGitHubLogin,
	githubClientFromEnv,
	githubProfile,
	markGitHubReconnect,
} from './lib/auth.ts';
import { openSession, sealSession, sealState } from './lib/crypto.ts';
import { appDb, migrateAppDb } from './lib/db-app.ts';
import { env, hasGitHubOAuth, hasOpenRouter } from './lib/env.ts';
import { fetchRepo, fetchUser, githubAuthorizeUrl, GitHubReconnectError, listRepos } from './lib/github.ts';
import { OPENROUTER_MODELS } from './lib/models.ts';
import {
	createGitHubProject,
	createSession,
	ensureDevProject,
	getProject,
	getSession,
	listProjects,
	listSessions,
	stopSession,
	updateSessionModel,
	type Project,
	type Session,
} from './lib/sessions.ts';
import { gitStatus, listPaths, readWorkspaceFile } from './lib/vm-proxy.ts';

const SESSION_COOKIE = 'anton_session';
const STATE_COOKIE = 'anton_oauth_state';
const SESSION_MAX_AGE = 14 * 24 * 60 * 60;

const app = new Hono();

let ready: Promise<void> | null = null;
function ensureReady() {
	ready ??= (async () => {
		await migrateAppDb();
		if (!hasGitHubOAuth()) await ensureDevProject();
	})();
	return ready;
}

app.use(
	'*',
	cors({
		origin: ['http://127.0.0.1:43127', 'http://localhost:43127'],
		allowHeaders: ['Content-Type', 'Authorization'],
		allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
		credentials: true,
	}),
);

app.use('*', async (c, next) => {
	await ensureReady();
	return next();
});

app.route('/api/agents/coder', createAgentRouter(Coder) as never);

function cookieOptions(maxAge: number) {
	return {
		httpOnly: true,
		sameSite: 'Lax' as const,
		path: '/',
		secure: env.githubCallbackUrl.startsWith('https://'),
		maxAge,
	};
}

function userIdFrom(c: Context): string | null {
	if (!hasGitHubOAuth()) return env.devUser ? 'user_dev' : null;
	const raw = getCookie(c, SESSION_COOKIE);
	if (!raw) return null;
	return openSession(raw);
}

function requireUser(c: Context): string | null {
	return userIdFrom(c);
}

app.get('/api/health', (c) =>
	c.json({
		ok: true,
		name: 'anton-v2',
		openRouter: hasOpenRouter(),
		githubOAuth: hasGitHubOAuth(),
	}),
);

app.get('/api/auth/github', (c) => {
	if (!hasGitHubOAuth()) return c.json({ error: 'GitHub OAuth is not configured' }, 400);
	const nonce = randomBytes(16).toString('hex');
	setCookie(c, STATE_COOKIE, nonce, cookieOptions(600));
	return c.redirect(githubAuthorizeUrl(sealState(nonce), githubClientFromEnv()));
});

app.get('/api/auth/github/callback', async (c) => {
	if (!hasGitHubOAuth()) return c.json({ error: 'GitHub OAuth is not configured' }, 400);
	const code = c.req.query('code');
	const state = c.req.query('state');
	if (c.req.query('error') || !code || !state) return c.redirect('/?auth=denied');
	try {
		const user = await finishGitHubLogin({
			code,
			state,
			nonce: getCookie(c, STATE_COOKIE) ?? null,
			db: appDb(),
			client: githubClientFromEnv(),
			fetchImpl: fetch,
		});
		deleteCookie(c, STATE_COOKIE, { path: '/' });
		setCookie(c, SESSION_COOKIE, sealSession(user.userId), cookieOptions(SESSION_MAX_AGE));
		return c.redirect('/');
	} catch {
		return c.redirect('/?auth=denied');
	}
});

app.post('/api/auth/logout', (c) => {
	deleteCookie(c, SESSION_COOKIE, { path: '/' });
	return c.body(null, 204);
});

app.get('/api/auth/me', async (c) => {
	if (!hasGitHubOAuth()) {
		return c.json({
			oauth: false,
			user: { id: 'user_dev', login: 'anton-dev', avatarUrl: null, needsReconnect: false },
		});
	}
	const userId = userIdFrom(c);
	if (!userId) return c.json({ oauth: true, user: null });
	const user = await githubProfile(userId, appDb());
	return c.json({ oauth: true, user });
});

app.get('/api/models', (c) => c.json({ models: OPENROUTER_MODELS }));

app.get('/api/github/repos', async (c) => {
	const userId = requireUser(c);
	if (!userId || !hasGitHubOAuth()) return c.json({ error: 'Sign in required' }, 401);
	try {
		const token = await ensureAccessToken(userId, appDb(), githubClientFromEnv());
		const repos = await listRepos(token);
		return c.json({ repos });
	} catch (error) {
		if (error instanceof GitHubReconnectError) {
			await markGitHubReconnect(userId, appDb());
			return c.json({ error: 'Reconnect GitHub', reconnect: true }, 401);
		}
		const message = error instanceof Error ? error.message : 'Could not list repositories';
		return c.json({ error: message }, 502);
	}
});

app.get('/api/projects', async (c) => {
	if (!hasGitHubOAuth()) {
		const project = await ensureDevProject();
		return c.json({ projects: [project] });
	}
	const userId = requireUser(c);
	if (!userId) return c.json({ error: 'Sign in required' }, 401);
	return c.json({ projects: await listProjects(userId) });
});

app.post('/api/projects', async (c) => {
	const userId = requireUser(c);
	if (!userId || !hasGitHubOAuth()) return c.json({ error: 'Sign in required' }, 401);
	const body = await c.req.json().catch(() => ({}));
	if (typeof body.fullName !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(body.fullName)) {
		return c.json({ error: 'Repository name is invalid' }, 400);
	}
	try {
		const token = await ensureAccessToken(userId, appDb(), githubClientFromEnv());
		const repo = await fetchRepo(token, body.fullName);
		const profile = await fetchUser(token);
		const project = await createGitHubProject({
			userId,
			repoFullName: repo.fullName,
			defaultBranch: repo.defaultBranch,
			token,
			userName: profile.name || profile.login,
			userEmail: profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`,
		});
		return c.json(project);
	} catch (error) {
		if (error instanceof GitHubReconnectError) {
			await markGitHubReconnect(userId, appDb());
			return c.json({ error: 'Reconnect GitHub', reconnect: true }, 401);
		}
		const message = error instanceof Error ? error.message : 'Could not clone repository';
		return c.json({ error: message }, 502);
	}
});

app.get('/api/sessions', async (c) => {
	if (!hasGitHubOAuth()) {
		const sessions = await listSessions();
		const project = await ensureDevProject();
		return c.json({ sessions, project, projects: [project] });
	}
	const userId = requireUser(c);
	if (!userId) return c.json({ error: 'Sign in required' }, 401);
	const sessions = await listSessions(appDb(), userId);
	const projects = await listProjects(userId);
	return c.json({ sessions, project: projects[0] ?? null, projects });
});

app.post('/api/sessions', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	if (hasGitHubOAuth()) {
		const userId = requireUser(c);
		if (!userId) return c.json({ error: 'Sign in required' }, 401);
		if (typeof body.projectId !== 'string') return c.json({ error: 'Choose a repository' }, 400);
		const project = await getProject(body.projectId);
		if (!project || project.userId !== userId) return c.json({ error: 'Project not found' }, 404);
	}
	const session = await createSession({
		projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
		model: typeof body.model === 'string' ? body.model : undefined,
		title: typeof body.title === 'string' ? body.title : undefined,
	});
	return c.json(session);
});

async function owned(c: Context, id: string): Promise<{ session: Session; project: Project } | Response> {
	const session = await getSession(id);
	if (!session) return c.json({ error: 'Session not found' }, 404);
	const project = await getProject(session.projectId);
	if (!project) return c.json({ error: 'Project not found' }, 404);
	if (hasGitHubOAuth()) {
		const userId = requireUser(c);
		if (!userId || project.userId !== userId) return c.json({ error: 'Sign in required' }, 401);
	}
	return { session, project };
}

app.get('/api/sessions/:id', async (c) => {
	const found = await owned(c, c.req.param('id'));
	if (found instanceof Response) return found;
	return c.json({ session: found.session, project: found.project });
});

app.patch('/api/sessions/:id', async (c) => {
	const found = await owned(c, c.req.param('id'));
	if (found instanceof Response) return found;
	const body = await c.req.json().catch(() => ({}));
	if (typeof body.model === 'string') {
		const session = await updateSessionModel(found.session.id, body.model);
		return c.json(session);
	}
	return c.json({ error: 'Nothing to update' }, 400);
});

app.post('/api/sessions/:id/stop', async (c) => {
	const found = await owned(c, c.req.param('id'));
	if (found instanceof Response) return found;
	const session = await stopSession(found.session.id);
	return c.json(session);
});

app.get('/api/vm/:id/git', async (c) => {
	const found = await owned(c, c.req.param('id'));
	if (found instanceof Response) return found;
	if (found.session.status !== 'running') return c.json({ error: 'VM unavailable' }, 409);
	const git = await gitStatus(found.project.workspacePath);
	return c.json({ repo: found.project.repoFullName, ...git });
});

app.get('/api/vm/:id/fs', async (c) => {
	const found = await owned(c, c.req.param('id'));
	if (found instanceof Response) return found;
	if (found.session.status !== 'running') return c.json({ error: 'VM unavailable' }, 409);
	const paths = await listPaths(found.project.workspacePath);
	return c.json({ cwd: found.project.workspacePath, paths });
});

app.get('/api/vm/:id/file', async (c) => {
	const found = await owned(c, c.req.param('id'));
	if (found instanceof Response) return found;
	const rel = c.req.query('path');
	if (!rel) return c.json({ error: 'path required' }, 400);
	const contents = await readWorkspaceFile(found.project.workspacePath, rel);
	return c.json({ path: rel, contents });
});

export default app;
