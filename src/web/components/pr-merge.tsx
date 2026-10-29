import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, CircleAlert, CircleCheck, CircleDot, CircleX, GitMerge, GitPullRequestClosed } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Btn, Icon, IconBtn, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '@/components/signal';
import { api, type CheckRun, type PullRequestDetail } from '@/lib/api';
import { age } from '@/lib/format';

/** Checks in a phrase: "2 failing, 5 passing". */
function checksPhrase(checks: CheckRun[]): string {
	const count = (status: CheckRun['status']) => checks.filter((check) => check.status === status).length;
	const parts = [
		count('failed') ? `${count('failed')} failing` : null,
		count('pending') ? `${count('pending')} running` : null,
		count('passed') ? `${count('passed')} passing` : null,
	].filter(Boolean);
	return parts.length ? parts.join(', ') : 'No checks';
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';
export const mergeLabel: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };

export function MergeMethodMenu({ method, onChange, disabled }: { method: MergeMethod; onChange: (method: MergeMethod) => void; disabled?: boolean }) {
	return <Menu><MenuTrigger asChild><IconBtn icon={ChevronDown} size="sm" variant="secondary" label="Merge method" disabled={disabled} className="rounded-l-none border-l-0" /></MenuTrigger>
		<MenuContent align="end" className="w-[240px]"><MenuLabel>Merge method</MenuLabel>
			{(['squash', 'merge', 'rebase'] as const).map((option) => <MenuItem key={option} checked={method === option} onSelect={() => onChange(option)}>{mergeLabel[option]}</MenuItem>)}
		</MenuContent></Menu>;
}

/**
 * Where the pull request stands for merging, and the Merge button: squash,
 * by default, after a second click, since a merge cannot be undone.
 */
export function MergeBox({ sessionId, pull, ownWork, initialConfirming = false, initialMethod = 'squash', onMerged, compact = false }: { sessionId: string; pull: PullRequestDetail; ownWork: boolean; initialConfirming?: boolean; initialMethod?: MergeMethod; onMerged?: (pull: PullRequestDetail) => void; compact?: boolean }) {
	const queryClient = useQueryClient();
	const [method, setMethod] = useState<MergeMethod>(initialMethod);
	const [confirming, setConfirming] = useState(initialConfirming);
	const [uncertain, setUncertain] = useState(false);
	const confirmButton = useRef<HTMLButtonElement>(null);
	useEffect(() => { if (initialConfirming) confirmButton.current?.focus(); }, [initialConfirming]);
	const merge = useMutation({
		mutationFn: () => api.mergePull(sessionId, pull.number, { method, sha: pull.headSha }),
		onSuccess: (merged) => {
			setConfirming(false);
			onMerged?.(merged);
			queryClient.setQueryData(['pull', sessionId, pull.number], merged);
			void queryClient.invalidateQueries({ queryKey: ['pulls', sessionId] });
			void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
			void queryClient.invalidateQueries({ queryKey: ['changes', sessionId] });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
		onError: (error) => {
			if (error.message.includes('Merged, but the pull request could not be read back')) {
				setConfirming(false);
				setUncertain(true);
				void queryClient.invalidateQueries({ queryKey: ['pull', sessionId, pull.number] });
				void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
				void queryClient.invalidateQueries({ queryKey: ['pulls', sessionId] });
			}
		},
	});
	if (pull.state === 'merged') {
		if (compact) return <span className="text-[12px] text-(--text-secondary)">Merged{pull.mergedBy ? ` by ${pull.mergedBy}` : ''}</span>;
		return (
			<Box tone="merged" icon={GitMerge} title={`Merged${pull.mergedBy ? ` by ${pull.mergedBy}` : ''}${pull.mergedAt ? ` ${age(pull.mergedAt)} ago` : ''}`}>
				{pull.headBranch} went into {pull.baseBranch}.
			</Box>
		);
	}
	if (pull.state === 'closed') {
		if (compact) return <span className="text-[12px] text-(--text-secondary)">Closed without merging</span>;
		return (
			<Box tone="closed" icon={GitPullRequestClosed} title="Closed without merging">
				{pull.closedAt ? `Closed ${age(pull.closedAt)} ago.` : 'It was closed on GitHub.'}
			</Box>
		);
	}
	const failing = pull.checks.some((check) => check.status === 'failed');
	const running = pull.checks.some((check) => check.status === 'pending');
	const blocked = uncertain ? 'Merge may have succeeded; refresh the pull request before trying again.' : pull.draft ? 'A draft cannot be merged; mark it ready on GitHub first.' : pull.mergeable === false ? `It has conflicts with ${pull.baseBranch}; ask the agent to fix them.` : !ownWork ? "This thread reviews someone else's pull request; merge it on GitHub." : null;
	const label = mergeLabel[method];
	const action = (
		<div className="flex shrink-0 items-center">
			<Btn ref={confirmButton} size="sm" variant={confirming ? 'primary' : 'secondary'} icon={GitMerge}
				disabled={Boolean(blocked) || merge.isPending}
				onClick={() => (confirming ? merge.mutate() : setConfirming(true))}
				onBlur={() => setConfirming(false)} className="rounded-r-none">
				{merge.isPending ? 'Merging…' : confirming ? 'Click again to merge' : label}
			</Btn>
			<MergeMethodMenu method={method} onChange={(next) => { setMethod(next); setConfirming(false); }} disabled={Boolean(blocked) || merge.isPending} />
		</div>
	);
	const problem = merge.isError ? merge.error.message : blocked;
	if (compact) return <div className="flex min-w-0 flex-col items-start gap-1">{action}{problem ? <span role="alert" className="max-w-[280px] text-[12px] text-(--danger-text)">{problem}</span> : null}</div>;
	return (
		<Box tone={blocked || failing ? 'warning' : 'ready'} icon={blocked || failing ? CircleAlert : running ? CircleDot : CircleCheck}
			title={blocked ? 'Not ready to merge' : failing ? 'Checks are failing' : running ? 'Checks are running' : 'Ready to merge'} action={action}>
			{merge.isError ? <span className="text-(--danger-text)">{merge.error.message}</span> : <>{blocked ?? checksPhrase(pull.checks)}{pull.approved ? ' · Approved' : ''}</>}
		</Box>
	);
}

const BOX_TONE = {
	ready: 'var(--success-text)',
	warning: 'var(--warning-text)',
	merged: 'var(--data-2)',
	closed: 'var(--danger-text)',
} as const;

function Box({ tone, icon, title, action, children }: { tone: keyof typeof BOX_TONE; icon: typeof GitMerge; title: string; action?: ReactNode; children: ReactNode }) {
	const color = BOX_TONE[tone];
	return (
		<div className="in-card flex-row flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
			<span
				className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border"
				style={{ color, borderColor: `color-mix(in oklab, ${color} 28%, transparent)`, background: `color-mix(in oklab, ${color} 12%, transparent)` }}
			>
				<Icon icon={icon} size={14} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="text-[13px] leading-[18px] font-medium text-(--text-primary)">{title}</span>
				<span className="text-[12px] leading-[17px] text-(--text-tertiary)">{children}</span>
			</div>
			{action}
		</div>
	);
}

