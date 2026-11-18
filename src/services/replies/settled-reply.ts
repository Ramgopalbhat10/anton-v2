import { announce } from '../../core/changes.ts';
import { logProblem } from '../../core/log.ts';
import type { Trace } from '../../core/trace.ts';
import { saveTrace } from '../../db/traces.ts';
import { finishTrace } from '../context/response-trace.ts';
import { finishReply, replyFacts, replyTotal } from '../models/response-usage.ts';

type SettledEvent = { type: string; instanceId?: string; agentName?: string; submissionId?: string; outcome?: string };

/** Deliveries that joined a reply settle with it, each with its own event, moments apart. */
const JOINED_MS = 30_000;
const lastSettled = new Map<string, { trace: Trace; at: number }>();

/**
 * A Coder reply that fails (a plan's limit, a provider error) or is stopped never runs its finish hook, so its message
 * carries no trace or usage. Both are kept here instead, on the trace, and the page finds them by the reply's submission.
 */
export function keepSettledReply(event: SettledEvent): void {
	if (event.type !== 'submission_settled' || (event.outcome !== 'failed' && event.outcome !== 'aborted')) return;
	if (!event.instanceId || !event.submissionId) return;
	if (event.agentName && !/^coder$/i.test(event.agentName)) return;
	const id = event.instanceId;
	const submissionId = event.submissionId;
	const reply = finishReply(id);
	const trace = finishTrace(id);
	if (!trace) {
		const kept = lastSettled.get(id);
		if (!kept?.trace.settled || Date.now() - kept.at > JOINED_MS || kept.trace.settled.submissions.includes(submissionId)) return;
		kept.trace.settled.submissions.push(submissionId);
		keep(kept.trace);
		return;
	}
	const { tools: _tools, ...facts } = reply ? replyFacts(reply) : { tools: null };
	trace.settled = {
		submissions: [submissionId],
		outcome: event.outcome,
		metadata: {
			traceId: trace.id,
			...(reply ? { usage: replyTotal(reply), usageParts: { main: reply.main, subagents: reply.subagents }, billing: reply.billing, ...facts } : {}),
			durationMs: trace.durationMs,
		},
	};
	lastSettled.set(id, { trace, at: Date.now() });
	for (const [key, value] of lastSettled) if (Date.now() - value.at > JOINED_MS) lastSettled.delete(key);
	keep(trace);
}

/** The save keeps it in memory at once, so the page's refetch finds it even before the database has it. */
function keep(trace: Trace): void {
	void saveTrace(trace).catch((error: unknown) => logProblem('warn', 'Trace not kept', error, trace.sessionId));
	announce({ kind: 'task', id: trace.sessionId, what: 'settled' });
}
