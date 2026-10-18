import type { MailDraft } from '../core/ports.ts';
import { appDb } from './client.ts';

type Row = Record<string, unknown>;

/** `sending` holds an approval while its email goes, so a second press cannot send it twice. */
export type ApprovalState = 'pending' | 'sending' | 'sent' | 'declined' | 'changed';

export type MailApproval = {
	id: string;
	sessionId: string;
	connector: string;
	draftId: string;
	/** The draft as the user was shown it. */
	draft: MailDraft;
	digest: string;
	state: ApprovalState;
	createdAt: string;
	decidedAt: string | null;
	sentId: string | null;
};

function toApproval(row: Row): MailApproval {
	return {
		id: String(row.id),
		sessionId: String(row.session_id),
		connector: String(row.connector),
		draftId: String(row.draft_id),
		draft: JSON.parse(String(row.draft_json)) as MailDraft,
		digest: String(row.digest),
		state: String(row.state) as ApprovalState,
		createdAt: String(row.created_at),
		decidedAt: row.decided_at == null ? null : String(row.decided_at),
		sentId: row.sent_id == null ? null : String(row.sent_id),
	};
}

export async function insertApproval(approval: Omit<MailApproval, 'state' | 'decidedAt' | 'sentId'>): Promise<void> {
	const db = await appDb();
	await db.execute({
		sql: `INSERT INTO mail_approvals (id, session_id, connector, draft_id, draft_json, digest, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
		args: [approval.id, approval.sessionId, approval.connector, approval.draftId, JSON.stringify(approval.draft), approval.digest, approval.createdAt],
	});
}

export async function getApproval(id: string): Promise<MailApproval | null> {
	const db = await appDb();
	const row = (await db.execute({ sql: 'SELECT * FROM mail_approvals WHERE id = ?', args: [id] })).rows[0];
	return row ? toApproval(row) : null;
}

export async function listApprovals(sessionId: string): Promise<MailApproval[]> {
	const db = await appDb();
	return (await db.execute({ sql: 'SELECT * FROM mail_approvals WHERE session_id = ? ORDER BY created_at', args: [sessionId] })).rows.map(toApproval);
}

/** Moves an approval from one state to the next; false when it was no longer in `from`, as when another press got there first. */
export async function moveApproval(id: string, from: ApprovalState, to: ApprovalState, sentId: string | null = null): Promise<boolean> {
	const db = await appDb();
	const result = await db.execute({
		sql: `UPDATE mail_approvals SET state = ?, decided_at = ?, sent_id = COALESCE(?, sent_id) WHERE id = ? AND state = ?`,
		args: [to, to === 'pending' || to === 'sending' ? null : new Date().toISOString(), sentId, id, from],
	});
	return result.rowsAffected > 0;
}
