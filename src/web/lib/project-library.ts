import type { Session } from '@/lib/api';

/**
 * How the project's Library lays out what its threads saved: under From
 * threads, a folder per thread named for it, holding its files. Folders Anton
 * keeps for the agent's own tools (pages under renders/, images under
 * images/) are left out of the path there, so a run's page sits one click
 * inside its thread's folder; the thread's own Library keeps them.
 */

/** Folders Anton files the agent's pages and images in (`RENDER_DIR`, `IMAGE_DIR`), not ones anyone chose. */
const ANTON_FOLDERS = ['renders/', 'images/'];

const day = (at: string) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/**
 * A folder name for each thread, by id: its title, with the day it started when another thread has the same
 * title (a routine's runs, say), and its id when even that is shared. A slash would make a folder of its own.
 */
export function threadFolders(threads: Session[]): Map<string, string> {
	const titleOf = (thread: Session) => thread.title.replaceAll('/', '∕').trim() || 'Untitled';
	const count = (names: string[]) => names.reduce((counts, name) => counts.set(name, (counts.get(name) ?? 0) + 1), new Map<string, number>());
	const titles = count(threads.map(titleOf));
	const dated = threads.map((thread) => {
		const title = titleOf(thread);
		// A routine's run already ends with its day; another would only repeat it.
		return (titles.get(title) ?? 0) > 1 && !title.endsWith(day(thread.createdAt)) ? `${title} · ${day(thread.createdAt)}` : title;
	});
	const names = count(dated);
	return new Map(threads.map((thread, index) => [thread.id, (names.get(dated[index]) ?? 0) > 1 ? `${dated[index]} · ${thread.id.slice(0, 6)}` : dated[index]]));
}

/** Where each of a thread's files shows in its folder, by its path in the thread's Library: Anton's own folders left out, unless that would put two files at one path. */
export function shownPaths(paths: string[]): Map<string, string> {
	const flat = (path: string) => {
		const folder = ANTON_FOLDERS.find((prefix) => path.startsWith(prefix));
		return folder ? path.slice(folder.length) : path;
	};
	const taken = new Map<string, number>();
	for (const path of paths) taken.set(flat(path), (taken.get(flat(path)) ?? 0) + 1);
	return new Map(paths.map((path) => [path, (taken.get(flat(path)) ?? 0) > 1 ? path : flat(path)]));
}
