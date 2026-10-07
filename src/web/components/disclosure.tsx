import type { ReactNode } from 'react';

/** Keeps content mounted while the grid eases between its natural height and zero. */
export function Disclosure({ open, children, id }: { open: boolean; children: ReactNode; id?: string }) {
	return (
		<div id={id} aria-hidden={!open} inert={!open} className="sg-disclosure" data-open={open}>
			<div className="min-h-0 overflow-hidden">{children}</div>
		</div>
	);
}
