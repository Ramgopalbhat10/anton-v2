import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@flue/runtime/node';
import type {
	AgentSubmission,
	AgentSubmissionStore,
	AttachmentStore,
	ConversationStreamStore,
	GetAttachmentInput,
	PersistenceAdapter,
	PersistenceStores,
	PutAttachmentInput,
} from '@flue/runtime/adapter';
import { parseSessionStorageKey } from '@flue/runtime/adapter';
import { config } from './config.ts';
import { INCOGNITO_PREFIX } from './core/incognito.ts';

/**
 * Conversations, attachments, and accepted submissions are stored here so
 * they survive a restart. Swap in another adapter (Postgres, libSQL, ...)
 * when one host's SQLite file is no longer enough:
 * https://flueframework.com/docs/guide/database/
 *
 * Incognito chats are the exception: ids starting `inco_` are routed to a
 * second, in-memory database, so a throwaway conversation — its stream,
 * submissions and attachments — is never written to disk and dies with the
 * process. Every Flue key that carries the instance id (the stream path
 * `agents/<agent>/<id>`, the attachment's conversation id, the submission's
 * session key) contains the prefix, which is how each store picks a side.
 */
const durable = sqlite(path.join(config.dataDir, 'flue.db'));
// A shared-cache in-memory URI: the adapter and this handle see the same database, so an
// incognito chat can be purged row by row when its window closes rather than waiting for a restart.
const EPHEMERAL_URI = 'file:anton-incognito?mode=memory&cache=shared';
const ephemeral = sqlite(EPHEMERAL_URI);
const ephemeralSql = new DatabaseSync(EPHEMERAL_URI);

const ephemeralKey = (value: string): boolean => value.includes(INCOGNITO_PREFIX);

/** Which side of the pair a submission id lives on; learned at admission, probed once after. */
type Side = 'durable' | 'ephemeral';

function routeSubmissions(disk: AgentSubmissionStore, mem: AgentSubmissionStore): AgentSubmissionStore {
	const known = new Map<string, Side>();
	const sideOf = (submission: AgentSubmission | null): Side => {
		if (!submission) return 'durable';
		const instance = parseSessionStorageKey(submission.sessionKey)?.instanceId;
		return instance && ephemeralKey(instance) ? 'ephemeral' : 'durable';
	};
	/** The store owning a submission id: the admission map first, then a probe of the in-memory side (cheap), then disk. */
	const pick = async (submissionId: string): Promise<AgentSubmissionStore> => {
		const hit = known.get(submissionId);
		if (hit) return hit === 'ephemeral' ? mem : disk;
		const found = await mem.getSubmission(submissionId);
		const side = sideOf(found);
		if (found) known.set(submissionId, side);
		return side === 'ephemeral' ? mem : disk;
	};
	const bySessionKey = (sessionKey: string): AgentSubmissionStore => {
		const instance = parseSessionStorageKey(sessionKey)?.instanceId;
		return instance && ephemeralKey(instance) ? mem : disk;
	};
	/** List results from both sides, in admission order; a session's rows all live on one side, so per-session order is untouched. */
	const merged = (left: AgentSubmission[], right: AgentSubmission[]): AgentSubmission[] =>
		[...left, ...right].sort((a, b) => a.acceptedAt - b.acceptedAt || a.submissionId.localeCompare(b.submissionId));
	const byInput = (input: { id: string }): AgentSubmissionStore => (ephemeralKey(input.id) ? mem : disk);
	return {
		async getSubmission(submissionId) {
			const found = (await mem.getSubmission(submissionId)) ?? (await disk.getSubmission(submissionId));
			if (found) known.set(submissionId, sideOf(found));
			return found;
		},
		async hasUnsettledSubmissions() {
			return (await mem.hasUnsettledSubmissions()) || (await disk.hasUnsettledSubmissions());
		},
		async listRunnableSubmissions() {
			return merged(await mem.listRunnableSubmissions(), await disk.listRunnableSubmissions());
		},
		async listUnreadySubmissions() {
			return merged(await mem.listUnreadySubmissions(), await disk.listUnreadySubmissions());
		},
		async listRunningSubmissions() {
			return merged(await mem.listRunningSubmissions(), await disk.listRunningSubmissions());
		},
		async listPendingSubmissionSettlements() {
			return [...(await mem.listPendingSubmissionSettlements()), ...(await disk.listPendingSubmissionSettlements())];
		},
		async replaceSubmissionAttempt(attempt, nextAttemptId, lease) {
			return (await pick(attempt.submissionId)).replaceSubmissionAttempt(attempt, nextAttemptId, lease);
		},
		async admitDispatch(input) {
			const store = byInput(input);
			const admission = await store.admitDispatch(input);
			if (admission.kind === 'submission') known.set(admission.submission.submissionId, store === mem ? 'ephemeral' : 'durable');
			return admission;
		},
		async admitDirect(input) {
			const store = byInput(input);
			const submission = await store.admitDirect(input);
			known.set(submission.submissionId, store === mem ? 'ephemeral' : 'durable');
			return submission;
		},
		async markSubmissionCanonicalReady(submissionId) {
			return (await pick(submissionId)).markSubmissionCanonicalReady(submissionId);
		},
		async settleQueuedSubmission(submissionId, outcome, error) {
			return (await pick(submissionId)).settleQueuedSubmission(submissionId, outcome, error);
		},
		async claimSubmission(claim) {
			return (await pick(claim.submissionId)).claimSubmission(claim);
		},
		async markSubmissionInputApplied(attempt, durability) {
			return (await pick(attempt.submissionId)).markSubmissionInputApplied(attempt, durability);
		},
		async requestSessionAbort(sessionKey) {
			return bySessionKey(sessionKey).requestSessionAbort(sessionKey);
		},
		async requeueSubmission(attempt) {
			return (await pick(attempt.submissionId)).requeueSubmission(attempt);
		},
		async reserveSubmissionSettlement(attempt, settlement) {
			return (await pick(attempt.submissionId)).reserveSubmissionSettlement(attempt, settlement);
		},
		async finalizeSubmissionSettlement(attempt, recordId, options) {
			return (await pick(attempt.submissionId)).finalizeSubmissionSettlement(attempt, recordId, options);
		},
		async completeSubmission(attempt) {
			return (await pick(attempt.submissionId)).completeSubmission(attempt);
		},
		async failSubmission(attempt, error) {
			return (await pick(attempt.submissionId)).failSubmission(attempt, error);
		},
		async claimJoinableSubmissions(host, agentName) {
			return (await pick(host.submissionId)).claimJoinableSubmissions(host, agentName);
		},
		async finalizeJoinedSubmission(host, submissionId) {
			return (await pick(host.submissionId)).finalizeJoinedSubmission(host, submissionId);
		},
		async revertJoiningSubmission(host, submissionId) {
			return (await pick(host.submissionId)).revertJoiningSubmission(host, submissionId);
		},
		async listJoinedSubmissions(hostSubmissionId) {
			return (await pick(hostSubmissionId)).listJoinedSubmissions(hostSubmissionId);
		},
		async renewLeases(ownerId, submissionIds) {
			const groups = new Map<AgentSubmissionStore, string[]>();
			for (const id of submissionIds) {
				const store = await pick(id);
				groups.set(store, [...(groups.get(store) ?? []), id]);
			}
			await Promise.all([...groups].map(([store, ids]) => store.renewLeases(ownerId, ids)));
		},
		async listExpiredSubmissions() {
			return merged(await mem.listExpiredSubmissions(), await disk.listExpiredSubmissions());
		},
	};
}

function routeStreams(disk: ConversationStreamStore, mem: ConversationStreamStore): ConversationStreamStore {
	const pick = (path: string): ConversationStreamStore => (ephemeralKey(path) ? mem : disk);
	return {
		createStream: (p, identity) => pick(p).createStream(p, identity),
		acquireProducer: (p, producerId) => pick(p).acquireProducer(p, producerId),
		append: (input) => pick(input.path).append(input),
		read: (p, options) => pick(p).read(p, options),
		getMeta: (p) => pick(p).getMeta(p),
		subscribe: (p, listener) => pick(p).subscribe(p, listener),
		putFoldCheckpoint: (p, checkpoint) => pick(p).putFoldCheckpoint?.(p, checkpoint) ?? Promise.resolve(),
		getFoldCheckpoint: (p, options) => pick(p).getFoldCheckpoint?.(p, options) ?? Promise.resolve(null),
	};
}

function routeAttachments(disk: AttachmentStore, mem: AttachmentStore): AttachmentStore {
	// The stream path (`agents/<agent>/<instance id>`) names the conversation; the in-memory side
	// is picked when it holds an incognito id.
	const pick = (streamPath: string): AttachmentStore => (ephemeralKey(streamPath) ? mem : disk);
	return {
		put: (input: PutAttachmentInput) => pick(input.streamPath).put(input),
		get: (input: GetAttachmentInput) => pick(input.streamPath).get(input),
	};
}

/**
 * Deletes every row an incognito chat left in the in-memory database: its stream, batches,
 * fold checkpoints, attachments and submissions, matched by the instance id in their keys.
 * The schema is Flue's own; the tables are internal, so this mirrors the adapter's DDL.
 */
export function purgeIncognito(id: string): void {
	try {
		const like = `%${id}%`;
		const run = (sql: string) => ephemeralSql.prepare(sql).run(like);
		run('DELETE FROM flue_conversation_stream_batch_chunks WHERE path LIKE ?');
		run('DELETE FROM flue_conversation_stream_batches WHERE path LIKE ?');
		run('DELETE FROM flue_conversation_streams WHERE path LIKE ?');
		run('DELETE FROM flue_conversation_fold_checkpoint_chunks WHERE path LIKE ?');
		run('DELETE FROM flue_conversation_fold_checkpoints WHERE path LIKE ?');
		run('DELETE FROM flue_attachment_chunks WHERE stream_path LIKE ?');
		run('DELETE FROM flue_attachments WHERE stream_path LIKE ?');
		run('DELETE FROM flue_submission_chunks WHERE submission_id IN (SELECT submission_id FROM flue_agent_submissions WHERE session_key LIKE ?)');
		run('DELETE FROM flue_agent_submissions WHERE session_key LIKE ?');
	} catch {
		// Ephemeral rows only; a missing table just means there was nothing to purge.
	}
}

export default {
	async migrate() {
		await durable.migrate?.();
		await ephemeral.migrate?.();
	},
	async connect(): Promise<PersistenceStores> {
		const [d, m] = await Promise.all([durable.connect(), ephemeral.connect()]);
		return {
			submissionStore: routeSubmissions(d.submissionStore, m.submissionStore),
			conversationStreamStore: routeStreams(d.conversationStreamStore, m.conversationStreamStore),
			attachmentStore: routeAttachments(d.attachmentStore, m.attachmentStore),
		};
	},
	async close() {
		await durable.close?.();
		await ephemeral.close?.();
	},
} satisfies PersistenceAdapter;
