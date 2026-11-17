import { memo, useEffect, useState } from 'react';
import { Logo } from '@/components/marks/illustrations';

/** The original cube loader (66435c98), kept local to chat rather than every loading control. */
export const WorkingLogo = memo(function WorkingLogo({ active, size = 16 }: { active: boolean; size?: number }) {
	const [turn, setTurn] = useState<'spin' | 'roll' | null>(null);
	useEffect(() => {
		if (!active) {
			setTurn(null);
			return;
		}
		const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
		let timer: ReturnType<typeof setTimeout> | undefined;
		const schedule = () => {
			clearTimeout(timer);
			if (motion?.matches) setTurn(null);
			else if (!turn) timer = setTimeout(() => setTurn(Math.random() < 0.55 ? 'spin' : 'roll'), 1800 + Math.random() * 2700);
		};
		schedule();
		motion?.addEventListener('change', schedule);
		return () => {
			clearTimeout(timer);
			motion?.removeEventListener('change', schedule);
		};
	}, [active, turn]);
	if (!active) return <Logo size={size} />;
	return (
		<span role="status" aria-label="Anton is working" className={`anton-working shrink-0 inline-flex${turn ? ` is-${turn}` : ''}`} style={{ width: size, height: size }}>
			<svg aria-hidden width={size} height={size} viewBox="3.5 5.2 17 17.8" className="overflow-visible">
				<g className="aw-cube" onAnimationEnd={(event) => { if (event.target === event.currentTarget) setTurn(null); }}>
					<polygon className="aw-face aw-top" points="12,6 19.1,10.1 12,14.2 4.9,10.1" />
					<polygon className="aw-face aw-left" points="4.9,10.1 12,14.2 12,22.4 4.9,18.3" />
					<polygon className="aw-face aw-right" points="12,14.2 19.1,10.1 19.1,18.3 12,22.4" />
					<g className="aw-face aw-left">
						<g className="aw-eyes" stroke="var(--aw-ink)" strokeWidth="1.75" strokeLinecap="round">
							<path d="M7.03 14.28v2.13" />
							<path d="M9.87 15.92v2.13" />
						</g>
					</g>
				</g>
			</svg>
		</span>
	);
});
