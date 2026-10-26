/**
 * Whether a failed reply's error reads as the model's plan or account turning the call away (a free plan
 * without the model, a used-up quota, a sign-in that lapsed) rather than the work itself going wrong. Such a
 * reply will fail the same way however often it is sent again, so the thread offers another model instead.
 */
export function isPlanRefusal(text: string): boolean {
	return /not available (for|on|to) (free|your)|free (users|plan|tier)|upgrade (your )?(plan|subscription|account)|subscription|plan (does not|doesn't) (include|support|allow)|usage limit|quota|insufficient (credits|balance|funds)|out of credits|payment required|\b40[123]\b|unauthori[sz]ed|forbidden|not (signed|logged) in|sign in again|rate.?limit/i.test(
		text,
	);
}
