import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { FilesTab } from '@/components/files-tab';
import { GitTab } from '@/components/git-tab';
import { TerminalTab } from '@/components/terminal-tab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';

const sections = ['Git', 'Terminal', 'Files'] as const;
type Section = (typeof sections)[number];

export function VmPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
	const [open, setOpen] = useState<Section[]>(['Git', 'Terminal', 'Files']);
	const [active, setActive] = useState<Section | null>('Git');
	const [menu, setMenu] = useState(false);

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
				<ScrollArea className="min-w-0 flex-1">
					<div className="flex items-center gap-1">
						{open.map((name) => (
							<ButtonGroup key={name}>
								<Button
									type="button"
									variant={active === name ? 'secondary' : 'outline'}
									size="sm"
									onClick={() => setActive(name)}
								>
									{name}
								</Button>
								<Button
									type="button"
									variant={active === name ? 'secondary' : 'outline'}
									size="icon-xs"
									aria-label={`Close ${name}`}
									onClick={() => closeSection(name)}
								>
									<X />
								</Button>
							</ButtonGroup>
						))}
					</div>
				</ScrollArea>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<Button type="button" variant="ghost" size="sm" className="md:hidden" onClick={onClose}>
						Close
					</Button>
					<Popover open={menu} onOpenChange={setMenu}>
						<PopoverTrigger asChild>
							<Button type="button" variant="outline" size="icon-sm" aria-label="Add panel">
								<Plus />
							</Button>
						</PopoverTrigger>
						<PopoverContent align="end" className="w-44">
							<div className="flex flex-col gap-1">
								{sections.map((name) => (
									<Button
										key={name}
										type="button"
										variant="ghost"
										className="justify-between"
										onClick={() => show(name)}
									>
										{name}
										{open.includes(name) ? <Badge variant="secondary">Open</Badge> : null}
									</Button>
								))}
							</div>
						</PopoverContent>
					</Popover>
				</div>
			</div>
			<div className="min-h-0 flex-1">
				{active === 'Git' && open.includes('Git') ? <GitTab sessionId={sessionId} /> : null}
				{active === 'Terminal' && open.includes('Terminal') ? <TerminalTab sessionId={sessionId} /> : null}
				{active === 'Files' && open.includes('Files') ? <FilesTab sessionId={sessionId} /> : null}
				{open.length === 0 ? (
					<Empty className="h-full border-0">
						<EmptyHeader>
							<EmptyTitle>No panels open</EmptyTitle>
							<EmptyDescription>Use + to add Git, Terminal, or Files.</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : null}
			</div>
		</section>
	);
}
