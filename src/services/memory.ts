import { InvalidInputError, NotFoundError } from '../core/errors.ts';
import { appendProjectMemory, getProject, setProjectMemory } from '../db/projects.ts';
import { getSessionRecord } from '../db/sessions.ts';
import { appendSpaceMemory } from '../db/spaces.ts';

/**
 * Notes about a repo that every task's agent reads: how to run things,
 * conventions, gotchas. Kept short, since each line costs tokens in every reply.
 */
export const MAX_MEMORY = 8_000;
const MAX_NOTE = 300;

/** Saves the notes as the user edited them. */
export async function saveMemory(projectId: string, memory: string): Promise<void> {
	if (!(await getProject(projectId))) throw new NotFoundError('Project not found');
	const text = memory.trim();
	if (text.length > MAX_MEMORY) throw new InvalidInputError(`Keep the notes under ${MAX_MEMORY} characters`);
	await setProjectMemory(projectId, text);
}

const noteLine = (note: string) => `- ${note.replace(/\s+/g, ' ').trim()}`;

/**
 * The agent's `remember` tool: adds one line to the notes of the task's repo, or, for a project's thread,
 * to the project's memory when the note is a decision or preference rather than a fact about the code.
 */
export async function remember(sessionId: string, note: string, scope: 'repo' | 'project' = 'repo'): Promise<string> {
	const session = await getSessionRecord(sessionId);
	if (!session) throw new NotFoundError('Session not found');
	if (scope === 'project' && session.spaceId) return rememberForSpace(session.spaceId, note);
	const line = noteLine(note);
	if (line.length > MAX_NOTE) return `Keep a note under ${MAX_NOTE} characters.`;
	const saved = await appendProjectMemory(session.projectId, line, MAX_MEMORY);
	return saved ? 'Saved. Later tasks on this repo will see it.' : 'The repo notes are full. Tell the user they can tidy them in the repository settings.';
}

/** Adds one line to a project's memory, which its coordinator and every thread read. */
export async function rememberForSpace(spaceId: string, note: string): Promise<string> {
	const line = noteLine(note);
	if (line.length > MAX_NOTE) return `Keep a note under ${MAX_NOTE} characters.`;
	const saved = await appendSpaceMemory(spaceId, line, MAX_MEMORY);
	return saved ? 'Saved to the project memory. The coordinator and every thread will see it.' : 'The project memory is full. Tell the user they can tidy it in the project settings.';
}
