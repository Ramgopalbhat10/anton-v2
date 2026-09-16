import { useState } from 'react';
import { FilesTab } from '@/components/files-tab';
import { GitTab } from '@/components/git-tab';
import { TerminalTab } from '@/components/terminal-tab';
import { cn } from '@/lib/utils';

const tabs = ['Git', 'Terminal', 'Files'] as const;

export function VmPanel({ sessionId }: { sessionId: string }) {
	const [tab, setTab] = useState<(typeof tabs)[number]>('Git');

	return (
		<section className="flex min-w-0 flex-1 flex-col border-l border-border bg-background">
			<div className="flex items-center gap-1 border-b border-border px-2 py-1 text-sm">
				{tabs.map((name) => (
					<button
						key={name}
						type="button"
						onClick={() => setTab(name)}
						className={cn(
							'rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground',
							tab === name && 'bg-accent text-foreground',
						)}
					>
						{name}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1">
				{tab === 'Git' ? <GitTab sessionId={sessionId} /> : null}
				{tab === 'Terminal' ? <TerminalTab sessionId={sessionId} /> : null}
				{tab === 'Files' ? <FilesTab sessionId={sessionId} /> : null}
			</div>
		</section>
	);
}
