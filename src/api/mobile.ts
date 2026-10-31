import { Hono } from 'hono';
import type { Session } from '../core/types.ts';
import { getSession, listSessions } from '../services/sessions.ts';
import { waitingMessages } from '../services/waiting.ts';
import { subagentRuns } from '../services/subagent-runs.ts';
import { agentNow } from '../services/agent-now.ts';
import { pullRequestView } from '../services/pull-requests.ts';
import { spacesView, spaceView } from '../services/spaces.ts';
import { listModels, pinnedModels } from '../services/models.ts';
import { defaultModel } from '../services/general.ts';
import { NotFoundError } from '../core/errors.ts';

/**
 * The flue agent router's request surface, used internally (the same way
 * `setAgentAbort` reaches `/abort`): the app asks it for a task's conversation
 * instead of speaking flue's wire protocol itself.
 */
export type AgentRouter = { request: (input: string, init?: RequestInit) => Promise<Response> };

/** What a row in the app's task list needs of a session — the rest stays server-side. */
function trimSession(session: Session) {
	return {
		id: session.id,
		title: session.title,
		projectId: session.projectId,
		repo: session.repo,
		branch: session.branch,
		baseBranch: session.baseBranch,
		model: session.model,
		status: session.status,
		working: session.working,
		workspace: session.workspace,
		threadState: session.threadState,
		planMode: session.planMode,
		prUrl: session.prUrl,
		pullRequest: session.pullRequest,
		errorMessage: session.errorMessage,
		asking: session.asking,
		plan: session.plan,
		lastReply: session.lastReply,
		spaceId: session.spaceId,
		automationId: session.automationId,
		review: session.review,
		usage: session.usage,
		createdAt: session.createdAt,
		pinnedAt: session.pinnedAt,
		resolvedAt: session.resolvedAt,
	};
}

type FluePart = Record<string, unknown> & { type?: string };

/**
 * One message in the transcript, normalized off flue's conversation shape.
 * Parts the client knows are flattened; anything new keeps its original kind
 * under `raw` so an older app still renders the text around it.
 */
function partOf(part: FluePart) {
	const type = String(part.type ?? '');
	const data = (part.input ?? part.data ?? part) as Record<string, unknown>;
	if (type === 'text') return { type: 'text', text: String(part.text ?? '') };
	if (type === 'reasoning') return { type: 'reasoning', text: String(part.text ?? '') };
	if (type === 'dynamic-tool' || type.startsWith('tool-'))
		return {
			type: 'tool',
			name: String(part.toolName ?? type.replace(/^tool-/, '')),
			state: String(part.state ?? ''),
			title: typeof part.title === 'string' ? part.title : undefined,
			input: data,
			output: part.output,
		};
	if (type === 'file' || type === 'data-file')
		return { type: 'file', path: String(part.filename ?? part.path ?? part.url ?? ''), mediaType: part.mediaType };
	if (type === 'data-ask' || type === 'ask' || 'question' in data)
		return {
			type: 'ask',
			question: String(data.question ?? ''),
			options: data.options ?? [],
			recommended: data.recommended,
			answer: part.output ?? data.answer ?? null,
		};
	return { type: 'raw', hint: type || 'unknown', text: typeof part.text === 'string' ? part.text : undefined };
}

function messageOf(message: Record<string, unknown>) {
	const parts = Array.isArray(message.parts) ? (message.parts as FluePart[]).map(partOf) : [];
	return {
		id: String(message.id ?? ''),
		role: String(message.role ?? 'assistant'),
		at: message.createdAt ?? message.sentAt ?? null,
		joined: message.joined === true,
		submissionId: message.submissionId ?? null,
		parts,
	};
}

async function transcript(agents: AgentRouter, id: string) {
	const res = await agents.request(`/${encodeURIComponent(id)}`);
	if (res.status === 404) throw new NotFoundError('Session not found');
	if (!res.ok) throw new NotFoundError(`Transcript unavailable (${res.status})`);
	const body = (await res.json()) as Record<string, unknown>;
	const list = (body.messages ?? body.conversation ?? body.state ?? body) as unknown;
	const messages = Array.isArray(list)
		? list
		: Array.isArray((list as Record<string, unknown>)?.messages)
			? ((list as Record<string, unknown>).messages as unknown[])
			: [];
	return messages.map((m) => messageOf(m as Record<string, unknown>));
}

/**
 * `/api/mobile`: the read surface the Android app uses, a stable shape over
 * what the web speaks internally. Sending a message stays on
 * `POST /api/agents/coder/:id` so budget checks and priming still run;
 * live changes ride the same `/api/events` stream.
 */
export function mobileApi(agents: AgentRouter, coordinators?: AgentRouter) {
	const app = new Hono();

	app.get('/sessions', async (c) => c.json({ sessions: (await listSessions()).map(trimSession) }));

	app.get('/sessions/:id', async (c) => {
		const id = c.req.param('id');
		const session = await getSession(id);
		const [waiting, runs, pullRequest, now] = await Promise.all([
			waitingMessages(id),
			subagentRuns(id).catch(() => []),
			pullRequestView(id).catch(() => null),
			Promise.resolve(agentNow(id)),
		]);
		return c.json({ session: trimSession(session), waiting, runs, pullRequest, now });
	});

	app.get('/sessions/:id/messages', async (c) => c.json({ messages: await transcript(agents, c.req.param('id')) }));

	app.get('/spaces', async (c) => c.json({ spaces: await spacesView() }));
	app.get('/spaces/:id', async (c) => c.json(await spaceView(c.req.param('id'))));

	// The project's coordinator conversation, normalized like a task transcript.
	// Sending stays on POST /api/agents/coordinator/:id, same as a prompt on a task.
	app.get('/spaces/:id/messages', async (c) => {
		if (!coordinators) return c.json({ messages: [] });
		return c.json({ messages: await transcript(coordinators, c.req.param('id')) });
	});

	app.get('/models', async (c) =>
		c.json({ models: await listModels(), default: await defaultModel(), pinned: await pinnedModels() }),
	);

	return app;
}
