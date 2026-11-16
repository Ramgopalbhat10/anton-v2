import { InvalidInputError, NotFoundError } from '../../core/errors.ts';
import { appendProjectMemory, getProject, setProjectMemory } from '../../db/projects.ts';
import { getSessionRecord } from '../../db/sessions.ts';
import { appendSpaceMemory } from '../../db/spaces.ts';

/** Kept short, since each line costs tokens in every reply. */
export const MAX_MEMORY = 8_000;
const MAX_NOTE = 300;

export async function saveMemory(projectId: string, memory: string): Promise<void> {
	if (!(await getProject(projectId))) throw new NotFoundError('Project not found');
	const text = memory.trim();
	if (text.length > MAX_MEMORY) throw new InvalidInputError(`Keep the notes under ${MAX_MEMORY} characters`);
	await setProjectMemory(projectId, text);
}

const noteLine = (note: string) => `- ${note.replace(/\s+/g, ' ').trim()}`;

/** A project's thread writes decisions and preferences to the project's memory instead of the repo's. */
export async function remember(sessionId: string, note: string, scope: 'repo' | 'project' = 'repo'): Promise<string> {
	const session = await getSessionRecord(sessionId);
	if (!session) throw new NotFoundError('Session not found');
	if (scope === 'project' && session.spaceId) return rememberForSpace(session.spaceId, note);
	if (!session.projectId) return 'This chat has no repository to keep notes for.';
	const line = noteLine(note);
	if (line.length > MAX_NOTE) return `Keep a note under ${MAX_NOTE} characters.`;
	const saved = await appendProjectMemory(session.projectId, line, MAX_MEMORY);
	return saved ? 'Saved. Later tasks on this repo will see it.' : 'The repo notes are full. Tell the user they can tidy them in the repository settings.';
}

export async function rememberForSpace(spaceId: string, note: string): Promise<string> {
	const line = noteLine(note);
	if (line.length > MAX_NOTE) return `Keep a note under ${MAX_NOTE} characters.`;
	const saved = await appendSpaceMemory(spaceId, line, MAX_MEMORY);
	return saved ? 'Saved to the project memory. The coordinator and every thread will see it.' : 'The project memory is full. Tell the user they can tidy it in the project settings.';
}
