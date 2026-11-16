import { randomUUID } from 'node:crypto';
import { announce } from '../../core/changes.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import { getToolApproval, insertToolApproval, listToolApprovals, moveToolApproval, type ToolApproval, type ToolApprovalState } from '../../db/tool-approvals.ts';
import { executeComposioTool } from './composio.ts';
import { logProblem } from '../../core/log.ts';

/** Only the user's Run runs the call, from Anton's server; the call is kept, not its credentials. */

export type ToolApprovalView = {
	id: string;
	connector: string;
	tool: string;
	args: Record<string, unknown>;
	state: ToolApprovalState;
	result: string | null;
	error: string | null;
	createdAt: string;
	decidedAt: string | null;
};

const RESULT_CHARS = 20_000;

const present = (approval: ToolApproval): ToolApprovalView => ({
	id: approval.id,
	connector: approval.connector,
	tool: approval.tool,
	args: approval.args,
	state: approval.state,
	result: approval.result === null ? null : approval.result.length > RESULT_CHARS ? `${approval.result.slice(0, RESULT_CHARS)}\n…` : approval.result,
	error: approval.error,
	createdAt: approval.createdAt,
	decidedAt: approval.decidedAt,
});

export async function requestToolApproval(
	sessionId: string,
	call: { connector: string; tool: string; args: Record<string, unknown>; payload: { toolkit: string; slug: string; args: Record<string, unknown> } },
): Promise<{ approval: ToolApprovalView; output: string }> {
	const id = `tool_${randomUUID()}`;
	const createdAt = new Date().toISOString();
	await insertToolApproval({ id, sessionId, connector: call.connector, tool: call.tool, args: call.args, payload: call.payload, createdAt });
	announce({ kind: 'task', id: sessionId, what: 'approvals' });
	const approval: ToolApprovalView = { id, connector: call.connector, tool: call.tool, args: call.args, state: 'pending', result: null, error: null, createdAt, decidedAt: null };
	return {
		approval,
		output:
			`The user now sees this ${call.connector} call with Run and Don't run, and nothing happens until they press Run. ` +
			`Stop here and wait for their answer; write nothing after this. [approval:${id}]`,
	};
}

export async function toolApprovals(sessionId: string): Promise<ToolApprovalView[]> {
	return (await listToolApprovals(sessionId)).map((approval) => present(approval));
}

export async function decideToolApproval(sessionId: string, approvalId: string, run: boolean): Promise<ToolApprovalView> {
	const approval = await getToolApproval(approvalId);
	if (!approval || approval.sessionId !== sessionId) throw new NotFoundError('No tool call waits for your answer here');
	if (approval.state !== 'pending') {
		throw new ConflictError(
			approval.state === 'running'
				? 'That call is running.'
				: approval.state === 'done'
					? 'That call already ran.'
					: approval.state === 'failed'
						? 'That call failed; ask the agent to try again.'
						: 'You already chose not to run it.',
		);
	}
	if (!run) {
		await moveToolApproval(approval.id, 'pending', 'declined');
	} else {
		if (!(await moveToolApproval(approval.id, 'pending', 'running'))) throw new ConflictError('That call already has an answer.');
		const { toolkit, slug, args } = approval.payload;
		try {
			const result = await executeComposioTool(toolkit, slug, args);
			await moveToolApproval(approval.id, 'running', 'done', { result });
		} catch (error) {
			logProblem('warn', `The approved ${approval.connector} call failed`, error);
			await moveToolApproval(approval.id, 'running', 'failed', { error: error instanceof Error ? error.message : String(error) });
		}
	}
	announce({ kind: 'task', id: sessionId, what: 'approvals' });
	return present((await getToolApproval(approval.id))!);
}
