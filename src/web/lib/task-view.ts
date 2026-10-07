import { isLive } from '@/components/task-status';
import type { Session } from '@/lib/api';

/**
 * How the sidebar lists tasks: which ones (filters), in what order, grouped
 * how, and what each row says under its title. Kept in the browser.
 */
export type TaskView = {
	sort: SortKey;
	group: 'none' | 'repo';
	filters: Record<FacetKey, string[]>;
	show: { repo: boolean; time: boolean; spend: boolean };
	/** Shows only each task's title, without the line under it. */
	compact: boolean;
	/** Sections folded away: pinned, running or recent. */
	collapsed: string[];
};

export type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'muted';

/** What a task is waiting on or what happened to it, in a few words; `attention` when it waits on you. */
export type TaskNote = { text: string; tone: Tone; attention: boolean; pullRequest?: boolean };

export const prNumber = (session: Session) => (session.prUrl ? (/\/pull\/(\d+)/.exec(session.prUrl)?.[1] ?? null) : null);

/** The agent proposed a plan and changes nothing until it is approved. */
export const planReady = (session: Session) => session.planMode && !session.working && session.usage.outputTokens > 0;

function prNote(session: Session): TaskNote | null {
	if (!session.prUrl) return null;
	const pr = session.pullRequest;
	const name = prNumber(session) ? `#${prNumber(session)}` : 'Pull request';
	if (!pr) return { text: `${name} opened`, tone: 'muted', attention: false, pullRequest: true };
	if (pr.state === 'merged') return { text: `${name} merged`, tone: 'accent', attention: false, pullRequest: true };
	if (pr.state === 'closed') return { text: `${name} closed`, tone: 'muted', attention: false, pullRequest: true };
	if (pr.checks === 'failed') return { text: `Checks failing on ${name}`, tone: 'danger', attention: true, pullRequest: true };
	if (pr.state === 'draft') return { text: `${name} draft`, tone: 'muted', attention: false, pullRequest: true };
	if (pr.checks === 'pending') return { text: `${name} checks running`, tone: 'muted', attention: false, pullRequest: true };
	return { text: pr.checks === 'passed' ? `${name} open, checks pass` : `${name} open`, tone: 'success', attention: false, pullRequest: true };
}

/** The line under a task's title: what it is doing, what it waits on, or how its pull request stands. */
export function taskNote(session: Session): TaskNote | null {
	if (session.status === 'starting') return { text: 'Starting sandbox', tone: 'accent', attention: false };
	if (session.working) return { text: 'Working', tone: 'accent', attention: false };
	if (session.status === 'error') return { text: 'Failed', tone: 'danger', attention: true };
	if (planReady(session)) return { text: 'Plan ready for review', tone: 'warning', attention: true };
	return prNote(session) ?? (isLive(session) ? { text: 'Idle', tone: 'muted', attention: false } : null);
}

/** When the task last did something: its last checkpoint, or when it started. */
export const activeAt = (session: Session) => session.checkpointAt ?? session.createdAt;

export const repoName = (repo: string) => repo.split('/').pop() ?? repo;
export const modelName = (model: string) => model.split('/').pop() ?? model;

export const SORTS = {
	active: { label: 'Recently active', compare: (a: Session, b: Session) => activeAt(b).localeCompare(activeAt(a)) },
	newest: { label: 'Newest first', compare: (a: Session, b: Session) => b.createdAt.localeCompare(a.createdAt) },
	spend: { label: 'Highest spend', compare: (a: Session, b: Session) => b.usage.cost - a.usage.cost },
	title: { label: 'Title, A to Z', compare: (a: Session, b: Session) => a.title.localeCompare(b.title) },
} satisfies Record<string, { label: string; compare: (a: Session, b: Session) => number }>;
export type SortKey = keyof typeof SORTS;

type Option = { value: string; label: string };
const DAY_MS = 24 * 60 * 60_000;
const within = (days: number) => (session: Session) => Date.now() - new Date(session.createdAt).getTime() < days * DAY_MS;
const distinct = (values: string[], label: (value: string) => string): Option[] =>
	[...new Set(values)].sort((a, b) => label(a).localeCompare(label(b))).map((value) => ({ value, label: label(value) }));

const STATUS: Record<string, { label: string; test: (session: Session) => boolean }> = {
	attention: { label: 'Needs you', test: (session) => taskNote(session)?.attention === true },
	working: { label: 'Working', test: (session) => session.working || session.status === 'starting' },
	idle: { label: 'Idle', test: (session) => isLive(session) && !session.working && session.status !== 'starting' },
	stopped: { label: 'Stopped', test: (session) => !isLive(session) && session.status !== 'error' },
	failed: { label: 'Failed', test: (session) => session.status === 'error' },
};

const PULL_REQUEST: Record<string, { label: string; test: (session: Session) => boolean }> = {
	open: { label: 'Open', test: (session) => Boolean(session.prUrl) && (!session.pullRequest || session.pullRequest.state === 'open') },
	draft: { label: 'Draft', test: (session) => session.pullRequest?.state === 'draft' },
	failing: { label: 'Checks failing', test: (session) => session.pullRequest?.checks === 'failed' },
	merged: { label: 'Merged', test: (session) => session.pullRequest?.state === 'merged' },
	closed: { label: 'Closed', test: (session) => session.pullRequest?.state === 'closed' },
	none: { label: 'No pull request', test: (session) => !session.prUrl },
};

const CREATED: Record<string, { label: string; test: (session: Session) => boolean }> = {
	day: { label: 'Past day', test: within(1) },
	week: { label: 'Past 7 days', test: within(7) },
	month: { label: 'Past 30 days', test: within(30) },
};

const fixed = (choices: typeof STATUS) => () => Object.entries(choices).map(([value, { label }]) => ({ value, label }));

/**
 * What tasks can be narrowed by. Options in one facet widen (any of them);
 * facets narrow each other (all of them). `single` facets take one option.
 */
export const FACETS = {
	status: { label: 'Status', options: fixed(STATUS), test: (session: Session, value: string) => STATUS[value]?.test(session) ?? true },
	pr: { label: 'Pull request', options: fixed(PULL_REQUEST), test: (session: Session, value: string) => PULL_REQUEST[value]?.test(session) ?? true },
	repo: { label: 'Repository', options: (tasks: Session[]) => distinct(tasks.map((task) => task.repo), repoName), test: (session: Session, value: string) => session.repo === value },
	model: { label: 'Model', options: (tasks: Session[]) => distinct(tasks.map((task) => task.model), modelName), test: (session: Session, value: string) => session.model === value },
	created: { label: 'Created', single: true, options: fixed(CREATED), test: (session: Session, value: string) => CREATED[value]?.test(session) ?? true },
} satisfies Record<string, { label: string; single?: boolean; options: (tasks: Session[]) => Option[]; test: (session: Session, value: string) => boolean }>;
export type FacetKey = keyof typeof FACETS;
export const FACET_KEYS = Object.keys(FACETS) as FacetKey[];

export const DEFAULT_VIEW: TaskView = {
	sort: 'active',
	group: 'none',
	filters: { status: [], pr: [], repo: [], model: [], created: [] },
	show: { repo: true, time: true, spend: false },
	compact: false,
	collapsed: [],
};

export const matches = (session: Session, filters: TaskView['filters']) =>
	FACET_KEYS.every((key) => filters[key].length === 0 || filters[key].some((value) => FACETS[key].test(session, value)));

export const filterCount = (filters: TaskView['filters']) => FACET_KEYS.reduce((count, key) => count + filters[key].length, 0);

/** The option's label, for a chip. */
export const optionLabel = (key: FacetKey, value: string, tasks: Session[]) => FACETS[key].options(tasks).find((option) => option.value === value)?.label ?? value;

/** Toggles one option; a single-choice facet keeps only the new one. */
export function toggleFilter(view: TaskView, key: FacetKey, value: string): TaskView {
	const current = view.filters[key];
	const single = 'single' in FACETS[key];
	const next = current.includes(value) ? current.filter((item) => item !== value) : single ? [value] : [...current, value];
	return { ...view, filters: { ...view.filters, [key]: next } };
}

export type Sections = { pinned: Session[]; running: Session[]; recent: Session[] };

/** Pinned tasks, then running ones, then the rest; each filtered, searched and sorted the same way. */
export function sections(tasks: Session[], view: TaskView, search: string): Sections {
	const needle = search.trim().toLowerCase();
	const shown = tasks
		.filter((task) => matches(task, view.filters))
		.filter((task) => !needle || `${task.title} ${task.repo} ${task.branch}`.toLowerCase().includes(needle))
		.sort(SORTS[view.sort].compare);
	return {
		pinned: shown.filter((task) => task.pinnedAt),
		running: shown.filter((task) => !task.pinnedAt && isLive(task)),
		recent: shown.filter((task) => !task.pinnedAt && !isLive(task)),
	};
}

/** Tasks under a heading per repository, in the order they first appear; one unnamed group when not grouping. */
export function groups(tasks: Session[], by: TaskView['group']): Array<{ key: string; label: string | null; tasks: Session[] }> {
	if (by === 'none') return [{ key: 'all', label: null, tasks }];
	const byRepo = new Map<string, Session[]>();
	for (const task of tasks) byRepo.set(task.repo, [...(byRepo.get(task.repo) ?? []), task]);
	return [...byRepo].map(([repo, list]) => ({ key: repo, label: repoName(repo), tasks: list }));
}

const STORAGE_KEY = 'anton.sidebarView';

/** The saved view over the defaults, so a view saved before a new option still has it. */
export function readView(): TaskView {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<TaskView>;
		return {
			...DEFAULT_VIEW,
			...saved,
			sort: saved.sort && saved.sort in SORTS ? saved.sort : DEFAULT_VIEW.sort,
			filters: { ...DEFAULT_VIEW.filters, ...saved.filters },
			show: { ...DEFAULT_VIEW.show, ...saved.show },
		};
	} catch {
		return DEFAULT_VIEW;
	}
}

export function saveView(view: TaskView) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
	} catch {
		// Storage is a convenience; the sidebar still works without it.
	}
}
