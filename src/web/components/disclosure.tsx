import { type ReactNode, useRef } from 'react';

/**
 * Keeps content mounted while the grid eases between its natural height and
 * zero. Content that has never been open is not built at all: a long
 * conversation's closed step cards would otherwise keep every row, command
 * and output in the page. Once opened it stays mounted, so closing animates.
 */
export function Disclosure({ open, children, id }: { open: boolean; children: ReactNode; id?: string }) {
	const opened = useRef(open);
	if (open) opened.current = true;
	return (
		<div id={id} aria-hidden={!open} inert={!open} className="sg-disclosure" data-open={open}>
			<div className="min-h-0 overflow-hidden">{opened.current ? children : null}</div>
		</div>
	);
}
