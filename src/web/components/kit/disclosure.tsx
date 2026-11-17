import { type ReactNode, useRef } from 'react';

/** Content never opened is not built at all, so a long conversation's closed cards cost nothing; once opened it stays mounted, so closing animates. */
export function Disclosure({ open, children, id }: { open: boolean; children: ReactNode; id?: string }) {
	const opened = useRef(open);
	if (open) opened.current = true;
	return (
		<div id={id} aria-hidden={!open} inert={!open} className="sg-disclosure" data-open={open}>
			<div className="min-h-0 overflow-hidden">{opened.current ? children : null}</div>
		</div>
	);
}
