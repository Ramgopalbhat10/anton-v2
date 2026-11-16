/** Whether a failed reply reads as the plan or account turning the call away: resending fails the same way, so the thread offers another model. */
export function isPlanRefusal(text: string): boolean {
	return /not available (for|on|to) (free|your)|free (users|plan|tier)|upgrade (your )?(plan|subscription|account)|subscription|plan (does not|doesn't) (include|support|allow)|usage limit|quota|insufficient (credits|balance|funds)|out of credits|payment required|\b40[123]\b|unauthori[sz]ed|forbidden|not (signed|logged) in|sign in again|rate.?limit/i.test(
		text,
	);
}
