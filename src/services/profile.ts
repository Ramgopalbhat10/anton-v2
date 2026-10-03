import { getProviders } from '../providers/index.ts';
import { logProblem } from './log.ts';

let cached: Promise<string | null> | undefined;

/** Who Anton acts as on the git host, asked once; a failed ask is tried again next time. */
export function profileName(): Promise<string | null> {
	cached ??= getProviders()
		.git.accountName()
		.catch((error: unknown) => {
			cached = undefined;
			logProblem('warn', 'Could not read the git host account', error);
			return null;
		});
	return cached;
}
