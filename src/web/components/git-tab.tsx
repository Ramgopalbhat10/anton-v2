import { useQuery } from '@tanstack/react-query';
import { Copy, GitCommitHorizontal, GitCompare } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Btn, DiffStat, EmptyState, IconBtn, Meta, Spinner } from '@/components/signal';
import { api } from '@/lib/api';
import { type FileDiff, parsePatch } from '@/lib/diff';
import { age } from '@/lib/format';
import { cn } from '@/lib/utils';

function DiffBlock({ file }: { file: FileDiff }) {
	const [copied, setCopied] = useState(false);
	const text = file.lines
		.map((line) => (line.kind === 'hunk' ? `@@ ${line.text} @@` : `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`))
		.join('\n');
	return (
		<div className="overflow-hidden rounded-lg bg-(--bg-inset)">
			<div className="flex h-8 items-center gap-2 bg-(--bg-raised) pr-1.5 pl-3">
				<div className="min-w-0 flex-1 truncate text-[12px]">{file.path}</div>
				<IconBtn
					icon={Copy}
					size="xs"
					label={copied ? 'Copied' : 'Copy diff'}
					onClick={() => {
						void navigator.clipboard?.writeText(text).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1200);
						});
					}}
				/>
			</div>
			<div className="overflow-x-auto py-1.5 font-mono text-[12px] leading-[18px]">
				<div className="min-w-max">
					{file.lines.map((line, index) =>
						line.kind === 'hunk' ? (
							<div key={index} className="flex text-(--text-disabled)">
								<span className="w-11 shrink-0 pr-2.5 text-right">@@</span>
								<span className="whitespace-pre">{line.text}</span>
							</div>
						) : (
							<div
								key={index}
								className={cn(
									'flex',
									line.kind === 'add' && 'bg-(--success-bg)',
									line.kind === 'remove' && 'bg-(--danger-bg)',
								)}
							>
								<span className="w-11 shrink-0 pr-2.5 text-right text-(--text-disabled)">{line.number}</span>
								<span
									className={cn(
										'pr-3 pl-2 whitespace-pre',
										line.kind === 'add' ? 'text-(--success-text)' : line.kind === 'remove' ? 'text-(--danger-text)' : 'text-(--text-secondary)',
									)}
								>
									{line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
									{line.text}
								</span>
							</div>
						),
					)}
				</div>
			</div>
		</div>
	);
}

export function GitTab({ sessionId }: { sessionId: string }) {
	const [view, setView] = useState<'diff' | 'commits'>('diff');
	const [selected, setSelected] = useState<string | null>(null);
	const git = useQuery({
		queryKey: ['git', sessionId],
		queryFn: () => api.git(sessionId),
		refetchInterval: 4000,
	});
	const files = useMemo(() => (git.data ? parsePatch(git.data.patch) : []), [git.data]);

	if (git.isError) {
		return <EmptyState title="Sandbox unavailable" body="Start the session again, or retry once the VM is back." />;
	}
	if (!git.data) {
		return (
			<div className="flex h-7 items-center gap-2 text-[12px] text-(--text-tertiary)">
				<Spinner size={12} />
				Starting the sandbox
			</div>
		);
	}

	const { branch, upstream, log } = git.data;
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	const current = files.find((file) => file.path === selected) ?? files[0];

	return (
		<div className="flex flex-col gap-2">
			<div className="flex h-7 items-center gap-2.5 text-[11px] tracking-[0.04em]">
				{view === 'diff' ? (
					<>
						<span className="text-(--text-disabled)">
							{files.length} {files.length === 1 ? 'FILE' : 'FILES'}
						</span>
						<span className="text-(--success-text)">+{added}</span>
						<span className="text-(--danger-text)">-{removed}</span>
					</>
				) : (
					<span className="text-(--text-disabled)">{log.length} COMMITS</span>
				)}
				<Meta className="hidden truncate uppercase sm:inline">
					{upstream ?? 'HEAD'} → {branch}
				</Meta>
				<div className="flex-1" />
				<Btn
					variant="ghost"
					size="xs"
					icon={view === 'diff' ? GitCommitHorizontal : GitCompare}
					onClick={() => setView(view === 'diff' ? 'commits' : 'diff')}
				>
					{view === 'diff' ? 'Commits' : 'Diff'}
				</Btn>
			</div>

			{view === 'commits' ? (
				log.length === 0 ? (
					<EmptyState icon={GitCommitHorizontal} title="No commits yet" body="Commits on the working branch show up here." />
				) : (
					<div className="flex flex-col gap-px">
						{log.map((entry) => (
							<div key={entry.sha} className="flex h-7 items-center gap-2 rounded-md px-2 hover:bg-(--bg-hover)">
								<span className="shrink-0 font-mono text-[11px] text-(--text-tertiary)">{entry.sha.slice(0, 7)}</span>
								<span className="min-w-0 flex-1 truncate text-[12px] text-(--text-secondary)">{entry.subject}</span>
								<span className="shrink-0 text-[11px] text-(--text-disabled)">{age(entry.at)}</span>
							</div>
						))}
					</div>
				)
			) : files.length === 0 ? (
				<EmptyState icon={GitCompare} title="No changes yet" body="Files the agent edits in the sandbox show up here as a diff." />
			) : (
				<>
					<div className="flex flex-col gap-px">
						{files.map((file) => {
							const active = file.path === current?.path;
							return (
								<button
									type="button"
									key={file.path}
									onClick={() => setSelected(file.path)}
									className="relative flex h-7 items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
								>
									{active ? <div className="absolute inset-0 rounded-md bg-(--alpha-white-6)" /> : null}
									<div
										className={cn(
											'relative min-w-0 flex-1 truncate text-[12px]',
											active ? 'text-(--text-primary)' : 'text-(--text-secondary)',
										)}
									>
										{file.path}
									</div>
									<div className="relative">
										<DiffStat added={file.added} removed={file.removed} />
									</div>
								</button>
							);
						})}
					</div>
					{current ? <DiffBlock file={current} /> : null}
				</>
			)}
		</div>
	);
}
