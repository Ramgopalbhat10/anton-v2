import { logProblem } from '../../core/log.ts';
import { sendToAgent } from '../tasks/agent-runner.ts';

/**
 * The agent hears a Run or Send from the server, whichever page, tab or reply the card is in: a waiting agent starts
 * its next reply on it, and one still working reads it at its next step.
 */
export async function tellAgent(sessionId: string, text: string): Promise<void> {
	await sendToAgent(sessionId, text).catch((error: unknown) => logProblem('warn', 'Could not tell the agent your answer', error, sessionId));
}
