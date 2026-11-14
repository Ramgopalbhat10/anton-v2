import type { ReactNode } from 'react';
import { MenuButton } from '@/components/nav';

/**
 * A top-level page: its name as a heading, with what it is for under it and
 * its actions beside it, the way a settings page opens, and a scrolling body.
 * On a phone a bar above holds the menu button and the name.
 */
export function PageFrame({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-1 pr-3 pl-2 text-body font-medium text-(--text-2) md:hidden">
				<MenuButton />
				<span className="min-w-0 flex-1 truncate">{title}</span>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-12 md:px-6 md:pt-10">
				<div className="mx-auto flex max-w-[960px] flex-col gap-4">
					<div className="mb-2 flex flex-wrap items-end gap-4">
						<div className="flex min-w-0 flex-1 basis-[280px] flex-col gap-1.5">
							<h1 className="m-0 truncate text-h1 leading-[28px] font-semibold tracking-[-0.02em] text-(--text)">{title}</h1>
							{description ? <p className="m-0 max-w-[72ch] text-body leading-[20px] text-pretty text-(--text-3)">{description}</p> : null}
						</div>
						{actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
					</div>
					{children}
				</div>
			</div>
		</div>
	);
}
