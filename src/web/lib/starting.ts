import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { Reasoning, Session } from '@/lib/api';

/**
 * Tasks and threads being made. Starting one opens it at once, by an id the
 * page chose, and lists it everywhere tasks are listed, working; its page
 * shows it as a skeleton until the server has made it (its sandbox, branch
 * and model are the server's to check), or says why it could not.
 */
export type Starting = {
	/** As it will read: the lists show it, and its page's header. */
	session: Session;
	/** What you asked, shown as your first message while it is made. */
	prompt: string;
	/** Why it could not be made; null while it is being made. */
	error: string | null;
	retry: () => void;
	/** Gives up on it: it leaves the lists. */
	discard: () => void;
};

const starting = new Map<string, Starting>();
/** What you asked of each task or thread made in this page, which its page shows until its conversation lists it. */
const opened = new Map<string, string>();
const listeners = new Set<() => void>();

function changed() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

/** The task or thread being made under this id; undefined once it is made, or for any other. */
export function useStarting(id: string): Starting | undefined {
	return useSyncExternalStore(subscribe, () => starting.get(id));
}

/** Whether this task or thread is being made, read once rather than followed. */
export function isStarting(id: string): boolean {
	return starting.has(id);
}

/** What you asked of a task or thread this page made, as its skeleton showed it; undefined for any other. */
export function openingPrompt(id: string): string | undefined {
	return opened.get(id);
}

/** A server's list of tasks with those still being made, which it does not list yet, first. */
export function withStarting(sessions: Session[]): Session[] {
	const listed = new Set(sessions.map((session) => session.id));
	const made = [...starting.values()].filter((entry) => !listed.has(entry.session.id) && !entry.error).map((entry) => entry.session);
	return made.length ? [...made.reverse(), ...sessions] : sessions;
}

/** An id for a new task: random, and made where `crypto.randomUUID` is missing too (a page served over plain http). */
export function newTaskId(): string {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A task's name from what you asked, as the server names it until a fast model gives it a short title. */
export function titleFrom(prompt: string): string {
	const line = prompt.trim().split('\n')[0] ?? '';
	return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/** The task as the lists show it while it is made: working on what you asked. */
export function draftSession(draft: {
	id: string;
	title: string;
	prompt: string;
	projectId?: string | null;
	repo?: string;
	branch?: string;
	model: string;
	reasoning?: Reasoning | null;
	planMode?: boolean;
	spaceId?: string | null;
}): Session {
	const now = new Date().toISOString();
	return {
		id: draft.id,
		projectId: draft.projectId ?? null,
		repo: draft.repo ?? '',
		title: draft.title,
		model: draft.model,
		reasoning: draft.reasoning ?? null,
		route: null,
		branch: '',
		baseBranch: draft.branch ?? '',
		baseSha: '',
		status: 'stopped',
		working: true,
		workspace: false,
		planMode: Boolean(draft.projectId) && Boolean(draft.planMode),
		prUrl: null,
		errorMessage: null,
		checkpointAt: null,
		createdAt: now,
		pinnedAt: null,
		pullRequest: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
		lastInput: draft.prompt,
		lastInputAt: now,
		asking: null,
		plan: null,
		spaceId: draft.spaceId ?? null,
		threadState: 'working',
		resolvedAt: null,
		brief: null,
		lastReply: null,
		review: null,
		automationId: null,
	};
}

type List = { sessions: Session[] };

/**
 * Starts making a task or thread in the background, by `session.id`, and
 * lists it at once; open its page right after. `make` asks the server for
 * it and returns it as made; trying again runs `make` again with the same id.
 */
export function startInBackground(queryClient: QueryClient, session: Session, prompt: string, make: () => Promise<Session>): void {
	const { id } = session;
	const discard = () => {
		starting.delete(id);
		queryClient.setQueryData<List>(['sessions'], (data) => (data ? { ...data, sessions: data.sessions.filter((item) => item.id !== id) } : data));
		changed();
	};
	const attempt = () => {
		starting.set(id, { session, prompt, error: null, retry: attempt, discard });
		changed();
		// The lists take it a frame later: the page you are going to draws first, and the sidebar's row slides in after.
		let listed = false;
		const list = () => {
			if (listed) return;
			listed = true;
			queryClient.setQueryData<List>(['sessions'], (data) => (data ? { ...data, sessions: withStarting(data.sessions.filter((item) => item.id !== id)) } : data));
		};
		afterPaint(list);
		make().then(
			(made) => {
				list();
				// It reads as working while its first message is on its way, unless it waits for a slot.
				const shown: Session = made.threadState === 'queued' ? made : { ...made, working: true, threadState: 'working' };
				queryClient.setQueryData(['session', id], shown);
				queryClient.setQueryData<List>(['sessions'], (data) => (data ? { ...data, sessions: data.sessions.map((item) => (item.id === id ? shown : item)) } : data));
				if (prompt) opened.set(id, prompt);
				starting.delete(id);
				changed();
			},
			(error: unknown) => {
				listed = true;
				starting.set(id, { session, prompt, error: error instanceof Error ? error.message : String(error), retry: attempt, discard });
				changed();
				queryClient.setQueryData<List>(['sessions'], (data) => (data ? { ...data, sessions: data.sessions.filter((item) => item.id !== id) } : data));
			},
		);
	};
	attempt();
}

/** Runs once the next frame is on screen, so work that can wait does not hold up the one you asked for. */
function afterPaint(run: () => void): void {
	if (typeof requestAnimationFrame !== 'function' || document.visibilityState !== 'visible') return void setTimeout(run, 0);
	requestAnimationFrame(() => setTimeout(run, 0));
}

/** Whatever a failed attempt left on the server under this id: made after all, when only its answer was lost. */
export async function madeAlready(id: string, error: unknown, read: (id: string) => Promise<Session>): Promise<Session> {
	const existing = await read(id).catch(() => null);
	if (existing) return existing;
	throw error;
}
