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
			<div className="flex h-10 shrink-0 items-end gap-1 border-b border-border px-2">
				{tabs.map((name) => (
					<button
						key={name}
						type="button"
						onClick={() => setTab(name)}
						className={cn(
							'-mb-px flex h-10 items-center border-b px-2.5 text-[13px]',
							tab === name
								? 'border-foreground text-foreground'
								: 'border-transparent text-muted-foreground hover:text-foreground',
						)}
					>
						{name}
					</button>
				))}
				<button
					type="button"
					onClick={onClose}
					className="mb-2 ml-auto rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
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
