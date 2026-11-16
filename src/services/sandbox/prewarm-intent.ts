import { config } from '../../config.ts';
import { decide, yesOf } from '../models/decisions.ts';
import { logProblem } from '../../core/log.ts';
import { releaseSpare } from './spares.ts';
import { prewarmMachine } from './workspace.ts';

/*
 * A cold sandbox takes a minute or two, but a question about the code needs none and on Modal is paid for. The decision
 * model reads the message (about a second, beside the agent's first call) and only a likely question skips the prewarm.
 * It leans to prewarm: a needless sandbox costs a few machine minutes, a missed one costs the user a cold start.
 */

export const PREWARM_AT = 0.25;
const REQUEST_CHARS = 2_000;

type Deps = {
	prewarm: (id: string) => Promise<void>;
	release: (id: string) => void;
	judge: (id: string, request: string) => Promise<number | null>;
	byIntent: boolean;
};

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

/** `request` is null for a reply no user message started. Never throws; it runs behind the reply. */
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
