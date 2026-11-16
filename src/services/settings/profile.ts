import { getProviders } from '../../providers/index.ts';
import { logProblem } from '../../core/log.ts';

let cached: Promise<string | null> | undefined;

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
