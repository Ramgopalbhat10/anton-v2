import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FilesTab } from '@/components/files-tab';
import { GitTab } from '@/components/git-tab';
import { TerminalTab } from '@/components/terminal-tab';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const sections = ['Git', 'Terminal', 'Files'] as const;
type Section = (typeof sections)[number];

export function VmPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
	const [open, setOpen] = useState<Section[]>(['Git', 'Terminal', 'Files']);
	const [active, setActive] = useState<Section | null>('Git');
	const [menu, setMenu] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menu) return;
		function onPointer(event: MouseEvent) {
			if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
		}
		function onKey(event: KeyboardEvent) {
			if (event.key === 'Escape') setMenu(false);
		}
		document.addEventListener('mousedown', onPointer);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onPointer);
			document.removeEventListener('keydown', onKey);
		};
	}, [menu]);

	function show(name: Section) {
		setOpen((current) => (current.includes(name) ? current : [...current, name]));
		setActive(name);
		setMenu(false);
	}

	function closeSection(name: Section) {
		const next = open.filter((item) => item !== name);
		setOpen(next);
		if (active === name) {
			const index = open.indexOf(name);
			setActive(next[Math.max(0, index - 1)] ?? null);
		}
	}

	return (
		<section className="flex min-w-0 flex-1 flex-col border-l border-border bg-background">
			<div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
				<div className="flex min-w-0 items-center gap-1 overflow-x-auto">
					{open.map((name) => (
						<div
							key={name}
							className={cn(
								'inline-flex h-7 shrink-0 items-center rounded-md',
								active === name ? 'bg-muted text-foreground' : 'text-muted-foreground',
							)}
						>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 px-2 font-normal"
								onClick={() => setActive(name)}
							>
								{name}
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="mr-0.5 size-5"
								aria-label={`Close ${name}`}
								onClick={() => closeSection(name)}
							>
								<X className="size-3" />
							</Button>
						</div>
					))}
				</div>
				<div className="relative" ref={menuRef}>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label="Add panel"
						aria-expanded={menu}
						onClick={() => setMenu((value) => !value)}
					>
						<Plus className="size-4" />
					</Button>
					{menu ? (
						<div
							role="menu"
							className="absolute left-0 top-full z-20 mt-1 w-40 rounded-md border border-border bg-card py-1 shadow-lg"
						>
							{sections.map((name) => (
								<button
									key={name}
									type="button"
									role="menuitem"
									className="flex h-8 w-full items-center justify-between px-3 text-left text-[13px] hover:bg-accent"
									onClick={() => show(name)}
								>
									<span>{name}</span>
									{open.includes(name) ? <span className="text-[11px] text-muted-foreground">Open</span> : null}
								</button>
							))}
						</div>
					) : null}
				</div>
				<Button type="button" variant="ghost" size="sm" className="ml-auto md:hidden" onClick={onClose}>
					Close
				</Button>
			</div>
			<div className="min-h-0 flex-1">
				{active === 'Git' && open.includes('Git') ? <GitTab sessionId={sessionId} /> : null}
				{active === 'Terminal' && open.includes('Terminal') ? <TerminalTab sessionId={sessionId} /> : null}
				{active === 'Files' && open.includes('Files') ? <FilesTab sessionId={sessionId} /> : null}
				{open.length === 0 ? (
					<div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
						No panels open. Use + to add Git, Terminal, or Files.
					</div>
				) : null}
			</div>
		</section>
	);
}
