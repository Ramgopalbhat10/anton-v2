import { useState } from 'react';
import { FilesTab } from '@/components/files-tab';
import { GitTab } from '@/components/git-tab';
import { TerminalTab } from '@/components/terminal-tab';
import { cn } from '@/lib/utils';

const tabs = ['Git', 'Terminal', 'Files'] as const;

export function VmPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
	const [tab, setTab] = useState<(typeof tabs)[number]>('Git');

	return (
		<section className="flex min-w-0 flex-1 flex-col border-l border-border bg-background">
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
				<div className="flex h-7 items-center gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Workspace">
					{tabs.map((name) => (
						<button
							key={name}
							type="button"
							role="tab"
							aria-selected={tab === name}
							onClick={() => setTab(name)}
							className={cn(
								'flex h-6 items-center rounded-md px-2.5 text-[13px]',
								tab === name
									? 'bg-background text-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							{name}
						</button>
					))}
				</div>
				<button
					type="button"
					onClick={onClose}
					className="ml-auto h-6 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
				>
					Close
				</button>
			</div>
			<div className="min-h-0 flex-1">
				{tab === 'Git' ? <GitTab sessionId={sessionId} /> : null}
				{tab === 'Terminal' ? <TerminalTab sessionId={sessionId} /> : null}
				{tab === 'Files' ? <FilesTab sessionId={sessionId} /> : null}
			</div>
		</section>
	);
}
