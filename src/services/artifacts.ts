import { listPages, outputIndexGeneration, readOutputIndex, writeOutputIndex, type IndexedOutput } from '../db/pages.ts';
import { listSessionRecords } from '../db/sessions.ts';
import { storedOutputs } from './files.ts';
import { isRenderPath, pageTitle } from './renders.ts';

/*
 * Everything the agent made, across every task: the Artifacts page. Each
 * task's Library is read from storage once and kept in the database until it
 * changes (checkpoints.ts forgets it then), so the page reads one table.
 * Files you added yourself (uploads/) are yours, not artifacts.
 */

export type Artifact = {
	sessionId: string;
	path: string;
	/** A page's title as the agent gave it; a file's name otherwise. */
	title: string;
	size: number;
	mtimeMs: number;
	task: { title: string; spaceId: string | null; chat: boolean };
};

/** How many tasks' storage is read at once when filling in the ones not yet listed. */
const READS_AT_ONCE = 8;

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) await work(items[next++]);
		}),
	);
}

export async function listArtifacts(): Promise<Artifact[]> {
	const [sessions, index, pages] = await Promise.all([listSessionRecords(), readOutputIndex(), listPages()]);
	await eachLimited(
		sessions.filter((session) => !index.has(session.id)),
		READS_AT_ONCE,
		async (session) => {
			const generation = outputIndexGeneration(session.id);
			const outputs: IndexedOutput[] = (await storedOutputs(session.id).catch(() => [])).map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs }));
			index.set(session.id, outputs);
			await writeOutputIndex(session.id, outputs, generation);
		},
	);
	const kept = new Map(pages.map((page) => [`${page.sessionId}\n${page.path}`, page]));
	const artifacts: Artifact[] = [];
	for (const session of sessions) {
		const task = { title: session.title, spaceId: session.spaceId, chat: !session.projectId };
		for (const output of index.get(session.id) ?? []) {
			if (output.path.startsWith('uploads/')) continue;
			const page = kept.get(`${session.id}\n${output.path}`);
			const title = page?.title ?? (isRenderPath(output.path) ? pageTitle(output.path) : (output.path.split('/').pop() ?? output.path));
			// A page someone used since it was drawn counts as edited then.
			const mtimeMs = Math.max(output.mtimeMs, page ? Date.parse(page.updatedAt) || 0 : 0);
			artifacts.push({ sessionId: session.id, path: output.path, title, size: output.size, mtimeMs, task });
		}
	}
	return artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
