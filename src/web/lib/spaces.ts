import { useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Clock, GitMerge, GitPullRequest, type LucideIcon, MessageCircleQuestion, Moon } from 'lucide-react';
import type { Tone } from '@/components/instrument';
import { api, SAFETY_NET_MS, type Session, THREAD_STATES, type ThreadState } from '@/lib/api';

/** Every project, newest activity first. */
export function useSpaces() {
	return useQuery({ queryKey: ['spaces'], queryFn: api.spaces, refetchInterval: SAFETY_NET_MS });
}

export function useSpace(id: string) {
	return useQuery({ queryKey: ['space', id], queryFn: () => api.space(id), refetchInterval: SAFETY_NET_MS });
}

/** A project's threads, newest first, from the task list every page already keeps current. */
export function useThreads(spaceId: string) {
	const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: SAFETY_NET_MS });
	const threads = (sessions.data?.sessions ?? []).filter((session) => session.spaceId === spaceId);
	return { threads, isPending: sessions.isPending, isError: sessions.isError };
}

export type StateLook = { label: string; short: string; tone: Tone; icon: LucideIcon };

/** How each state shows: amber waits on you, cyan works, emerald is ready, neutral is quiet. */
export const STATE_LOOK: Record<ThreadState, StateLook> = {
	waiting: { label: 'Waiting on you', short: 'Needs you', tone: 'warning', icon: MessageCircleQuestion },
	working: { label: 'Working', short: 'Working', tone: 'accent', icon: CircleCheck },
	queued: { label: 'Queued', short: 'Queued', tone: 'neutral', icon: Clock },
	review: { label: 'Ready for review', short: 'Review', tone: 'success', icon: GitPullRequest },
	landing: { label: 'Landing', short: 'Landing', tone: 'success', icon: GitMerge },
	idle: { label: 'Idle', short: 'Idle', tone: 'neutral', icon: Moon },
	resolved: { label: 'Resolved', short: 'Done', tone: 'neutral', icon: CircleCheck },
};

/** A failed thread waits on you too, but says so in red. */
export const failed = (thread: Session) => thread.status === 'error' || thread.pullRequest?.checks === 'failed';

export const stateOf = (thread: Session): ThreadState => thread.threadState ?? 'idle';

/** Threads in the project's order of states, each group newest first. */
export function groupByState(threads: Session[]): Array<{ state: ThreadState; threads: Session[] }> {
	return THREAD_STATES.map((state) => ({ state, threads: threads.filter((thread) => stateOf(thread) === state) })).filter((group) => group.threads.length > 0);
}

/** When the thread last did something. */
export const threadActiveAt = (thread: Session) => [thread.checkpointAt, thread.lastInputAt, thread.createdAt].filter((at): at is string => Boolean(at)).sort().pop() ?? thread.createdAt;

/** One line about the thread: its question when it waits on you, else its last words, else its brief. */
export function threadLine(thread: Session): string {
	if (thread.status === 'error') return thread.errorMessage ?? 'The thread failed.';
	if (thread.asking) return thread.asking;
	const text = thread.lastReply ?? thread.brief ?? thread.lastInput ?? '';
	// A heading only names what follows, so the first line of prose is preferred.
	const lines = text.split('\n').filter((entry) => entry.trim() && !/^\s*(?:---+|\|)/.test(entry));
	const plain = (entry: string) => entry.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/^#+\s*/, '').replace(/[*_`]+/g, '').trim();
	const prose = lines.find((entry) => !/^\s*#/.test(entry));
	return plain(prose ?? lines[0] ?? '');
}

/** The project's mark: its emoji, or its initial. */
export const spaceMark = (space: { name: string; icon: string | null }) => space.icon || space.name.trim().charAt(0).toUpperCase() || 'P';

/**
 * Each thread keeps its own open panels and the one shown, so switching back
 * to a thread finds them as they were. Kept in the browser.
 */
const panelsKey = (threadId: string) => `anton.thread-panels.${threadId}`;

export type ThreadPanels<Name extends string> = { tabs: Name[]; active: Name | null; open: boolean };

export function readThreadPanels<Name extends string>(threadId: string, fallback: ThreadPanels<Name>): ThreadPanels<Name> {
	try {
		const saved = JSON.parse(localStorage.getItem(panelsKey(threadId)) ?? 'null') as ThreadPanels<Name> | null;
		return saved && Array.isArray(saved.tabs) ? { ...fallback, ...saved } : fallback;
	} catch {
		return fallback;
	}
}

export function saveThreadPanels<Name extends string>(threadId: string, panels: ThreadPanels<Name>): void {
	try {
		localStorage.setItem(panelsKey(threadId), JSON.stringify(panels));
	} catch {
		// Storage is a convenience; panels still work without it.
	}
}

/** Thread reports reach the coordinator as a message; the feed shows them as a quiet row, not a bubble. */
export type Report = { id: string; title: string; state: ThreadState; text: string };

export function parseReports(text: string): Report[] | null {
	const match = /^\s*<thread-reports>([\s\S]*)<\/thread-reports>\s*$/.exec(text);
	if (!match) return null;
	const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
	const reports: Report[] = [];
	for (const line of match[1].matchAll(/<thread ([^>]*?)(?:\/>|>([\s\S]*?)<\/thread>)/g)) {
		const attrs = Object.fromEntries([...line[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]));
		const state = (THREAD_STATES as readonly string[]).includes(attrs.state) ? (attrs.state as ThreadState) : 'idle';
		reports.push({ id: attrs.id ?? '', title: attrs.title ?? 'A thread', state, text: unescape(line[2] ?? attrs.asks ?? '').trim() });
	}
	return reports;
}
