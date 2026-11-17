import type { QueryKey } from '@tanstack/react-query';
import { api, type Output, outputUrl, spaceFileUrl } from '@/lib/api';

export type Kind = 'page' | 'image' | 'pdf' | 'table' | 'text' | 'other';

const KINDS: Array<[RegExp, Kind]> = [
	// HTML shows as the page it is, live, with its source a click away.
	[/\.html?$/i, 'page'],
	[/\.(png|jpe?g|gif|webp|avif|svg)$/i, 'image'],
	[/\.pdf$/i, 'pdf'],
	[/\.(csv|tsv)$/i, 'table'],
	[/\.(md|txt|log|json|ya?ml|xml|html?|diff|patch|sh|[cm]?[jt]sx?|py|go|rs|sql)$/i, 'text'],
];

export const kindOf = (path: string): Kind => KINDS.find(([pattern]) => pattern.test(path))?.[1] ?? 'other';

export type Place = { path: string; url: string; textKey: QueryKey; text: () => Promise<string>; sessionId?: string };

export const taskPlace = (sessionId: string, path: string): Place => ({
	path,
	url: outputUrl(sessionId, path),
	textKey: ['output', sessionId, path],
	text: () => api.outputText(sessionId, path),
	sessionId,
});

/** Every thread of the project reads these at ../project-files. */
export const spacePlace = (spaceId: string, path: string): Place => ({
	path,
	url: spaceFileUrl(spaceId, path),
	textKey: ['space-file', spaceId, path],
	text: () => api.spaceFileText(spaceId, path),
});

export const PROJECT_FOLDER = 'Project files';

/** Each kind of Library brings its files, already fetched; the views below are the same for all. */
export type LibrarySource = {
	files: Output[] | undefined;
	error: Error | null;
	place: (path: string) => Place;
	agentPath: (path: string) => string;
	upload: (file: File) => Promise<unknown>;
	/** Null for a Library whose files cannot be deleted from here. */
	remove: ((path: string) => Promise<unknown>) | null;
	refresh: () => void;
	addedTo: string;
	empty: string;
};

export const nameOf = (path: string) => path.split('/').pop() ?? path;
