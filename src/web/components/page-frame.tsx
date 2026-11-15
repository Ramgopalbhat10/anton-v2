import { ChevronRight } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { MenuButton } from '@/components/nav';
import { Icon } from '@/components/signal';

/**
 * The bar along the top of the work panel: where you are, as crumbs with the
 * last one bright, and the page's actions on the right. On a phone the menu
 * button leads it.
 */
export function TopBar({ crumbs, children }: { crumbs: ReactNode[]; children?: ReactNode }) {
	return (
		<header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--line) pr-3 pl-2 md:pl-4">
			<MenuButton />
			<nav aria-label="Where you are" className="flex min-w-0 items-center gap-1.5 text-body text-(--text-3)">
				{crumbs.map((crumb, index) => (
					<Fragment key={index}>
						{index > 0 ? <Icon icon={ChevronRight} size={12} className="shrink-0 text-(--text-4)" /> : null}
						<span className={index === crumbs.length - 1 ? 'min-w-0 truncate font-medium text-(--text)' : 'min-w-0 truncate'}>{crumb}</span>
					</Fragment>
				))}
			</nav>
			<span className="flex-1" />
			{children}
		</header>
	);
}
