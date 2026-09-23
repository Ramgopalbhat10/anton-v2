import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { FilesTab } from '@/components/files-tab';
import { GitTab } from '@/components/git-tab';
import { TerminalTab } from '@/components/terminal-tab';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';

const sections = ['Git', 'Terminal', 'Files'] as const;
type Section = (typeof sections)[number];

export function VmPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
	const [open, setOpen] = useState<Section[]>(['Git', 'Terminal', 'Files']);
	const [active, setActive] = useState<Section | null>('Git');

	function show(name: Section) {
		setOpen((current) => (current.includes(name) ? current : [...current, name]));
		setActive(name);
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
						{open.map((name) => {
							const variant = active === name ? 'secondary' : 'ghost';
							return (
								<ButtonGroup key={name}>
									<Button type="button" variant={variant} size="sm" onClick={() => setActive(name)}>
										{name}
									</Button>
									<Button
										type="button"
										variant={variant}
										size="icon-sm"
										aria-label={`Close ${name}`}
										onClick={() => closeSection(name)}
									>
										<X />
									</Button>
								</ButtonGroup>
							);
						})}
					</div>
				</ScrollArea>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<Button type="button" variant="ghost" size="sm" className="md:hidden" onClick={onClose}>
						Close
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="ghost" size="icon-sm" aria-label="Add panel">
								<Plus />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							<DropdownMenuGroup>
								{sections.map((name) => (
									<DropdownMenuItem key={name} onSelect={() => show(name)}>
										{name}
										{open.includes(name) ? <DropdownMenuShortcut>Open</DropdownMenuShortcut> : null}
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			<div className="min-h-0 flex-1">
				{active === 'Git' && open.includes('Git') ? <GitTab sessionId={sessionId} /> : null}
				{active === 'Terminal' && open.includes('Terminal') ? <TerminalTab sessionId={sessionId} /> : null}
				{active === 'Files' && open.includes('Files') ? <FilesTab sessionId={sessionId} /> : null}
				{open.length === 0 ? (
					<Empty className="h-full">
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
