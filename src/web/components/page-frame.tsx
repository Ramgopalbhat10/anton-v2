import type { ReactNode } from 'react';
import { MenuButton } from '@/components/nav';

/** A top-level page: its name in the header bar, actions on the right, and a scrolling body. */
export function PageFrame({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-1 border-b border-(--border-subtle) pr-3 pl-2 text-[13px] font-medium text-(--text-secondary) md:pl-4">
				<MenuButton />
				<span className="min-w-0 flex-1 truncate">{title}</span>
				{actions}
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-6 pb-12 md:px-6">
				<div className="mx-auto flex max-w-[960px] flex-col gap-4">{children}</div>
			</div>
		</div>
	);
}
