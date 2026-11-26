import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

/** Content never opened is not built at all, so a long conversation's closed cards cost nothing; once opened it stays mounted, so closing animates. The first open measures the newly mounted content while the row is still closed: mounting it and opening the row in the same style pass makes the grid animate from a zero-sized end state. */
export function Disclosure({ open, children, id }: { open: boolean; children: ReactNode; id?: string }) {
	const [opened, setOpened] = useState(open);
	const [measured, setMeasured] = useState(open);
	const content = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (!open || measured) return;
		void content.current?.scrollHeight;
		setOpened(true);
		setMeasured(true);
	}, [open, measured]);
	return (
		<div id={id} aria-hidden={!open} inert={!open} className="sg-disclosure" data-open={open && measured}>
			<div ref={content} className="min-h-0 overflow-hidden">{opened || open ? children : null}</div>
		</div>
	);
}
