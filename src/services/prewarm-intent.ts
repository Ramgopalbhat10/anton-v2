import { config } from '../config.ts';
import { decide, yesOf } from './decisions.ts';
import { logProblem } from './log.ts';
import { releaseSpare } from './spares.ts';
import { prewarmMachine } from './workspace.ts';

/*
 * Whether a repository task's sandbox is started ahead of the agent. A sandbox takes a minute or two to start cold,
 * so a task that will run commands or change files starts one as its reply begins (and a new task's starts while it
 * is typed, as a spare). A question about the code needs none: the agent reads the repository without a sandbox. A
 * live run's 14-second answer to a question still cloned the repository and installed its packages, which on Modal is
 * paid for. So the decision model reads the message first, in about a second, while the agent's first call is under
 * way: a message it judges likely to need commands or changes is prewarmed as before; one it judges a question is not,
 * and the spare woken for its draft is let go at once rather than left to stop on its own two minutes later. Leaning to
 * prewarm: a sandbox started for a question costs a few minutes of a machine, one missed costs the user a cold start.
 */

/** Below this probability, by the decision model, that the message needs a sandbox, none is started. */
export const PREWARM_AT = 0.25;
/** What the decision model reads of the message. */
const REQUEST_CHARS = 2_000;

type Deps = {
	prewarm: (id: string) => Promise<void>;
	release: (id: string) => void;
	judge: (id: string, request: string) => Promise<number | null>;
	byIntent: boolean;
};

/** The decision model's probability that answering the message needs commands or file changes; null with none, or when it fails. */
async function sandboxLikely(id: string, request: string): Promise<number | null> {
	const answers = await decide(
		id,
		{ message: request.slice(0, REQUEST_CHARS) },
		{
			sandbox: {
				type: 'yes-no',
				instructions:
					'A coding agent is about to act on this message about a code repository. It can read and search the repository without a sandbox; ' +
					'it needs one only to run commands (tests, builds, scripts, git) or to change, add or delete files. ' +
					'Will acting on this message most likely need it to run a command or change a file? A question about the code, how something works or where something is, is no; a request to fix, add, change, run, test or check something is yes.',
			},
		},
	);
	return yesOf(answers?.sandbox);
}

const defaults: Deps = { prewarm: prewarmMachine, release: releaseSpare, judge: sandboxLikely, byIntent: config.prewarmByIntent };

/**
 * As a repository task's reply starts without a workspace: prewarms its sandbox unless the message (`request`, null for
 * a reply that no user message started) reads as a question that needs none. Never throws; it runs behind the reply.
 */
export async function prewarmFor(id: string, request: string | null, deps: Partial<Deps> = {}): Promise<'prewarmed' | 'skipped'> {
	const d = { ...defaults, ...deps };
	try {
		if (d.byIntent && request?.trim()) {
			const likely = await d.judge(id, request);
			if (likely !== null && likely < PREWARM_AT) {
				d.release(id);
				return 'skipped';
			}
		}
		await d.prewarm(id);
		return 'prewarmed';
	} catch (error) {
		logProblem('warn', 'The sandbox did not start ahead of the agent', error, id);
		return 'prewarmed';
	}
}
