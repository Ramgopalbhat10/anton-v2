import {
	Activity,
	Anchor,
	Atom,
	BookOpen,
	Bot,
	Box,
	Boxes,
	Brain,
	Briefcase,
	Bug,
	Building2,
	Calendar,
	Camera,
	ChartColumn,
	Check,
	Cloud,
	Code,
	Compass,
	Cpu,
	CreditCard,
	Database,
	FileText,
	Flag,
	FlaskConical,
	Flame,
	Folder,
	Gamepad2,
	Gauge,
	GitBranch,
	Globe,
	GraduationCap,
	Hammer,
	HeartPulse,
	Image,
	KeyRound,
	Languages,
	Layers,
	LayoutDashboard,
	Leaf,
	Lightbulb,
	Lock,
	type LucideIcon,
	Mail,
	Map as MapIcon,
	Megaphone,
	MessageSquare,
	Monitor,
	Package,
	Palette,
	PenTool,
	Plug,
	Puzzle,
	Radar,
	Receipt,
	Rocket,
	Scale,
	Search,
	Server,
	Shield,
	ShoppingCart,
	Smartphone,
	Sparkles,
	Store,
	Target,
	Telescope,
	Terminal,
	Trophy,
	Truck,
	Users,
	Wallet,
	Webhook,
	Workflow,
	Wrench,
	Zap,
} from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/signal';
import { cn } from '@/lib/utils';

/* A project's mark is a drawn icon on a tinted tile, never an emoji. It is
   saved as "<icon>" or "<icon>:<tint>", like "rocket:violet"; anything else
   (an emoji from before, an icon since removed) draws the project's initial. */

export type ProjectIconEntry = { key: string; icon: LucideIcon; label: string; words: string };

/** The icons a project can wear, roughly grouped: work, product, infrastructure, people, the rest. */
export const PROJECT_ICONS: ProjectIconEntry[] = [
	{ key: 'folder', icon: Folder, label: 'Folder', words: 'general misc files' },
	{ key: 'rocket', icon: Rocket, label: 'Rocket', words: 'launch release ship deploy' },
	{ key: 'flag', icon: Flag, label: 'Flag', words: 'milestone goal release' },
	{ key: 'target', icon: Target, label: 'Target', words: 'goal okr focus' },
	{ key: 'compass', icon: Compass, label: 'Compass', words: 'onboarding explore discovery' },
	{ key: 'map', icon: MapIcon, label: 'Map', words: 'roadmap plan route' },
	{ key: 'workflow', icon: Workflow, label: 'Workflow', words: 'automation pipeline process ci' },
	{ key: 'layers', icon: Layers, label: 'Layers', words: 'platform stack architecture' },
	{ key: 'boxes', icon: Boxes, label: 'Boxes', words: 'monorepo packages modules' },
	{ key: 'package', icon: Package, label: 'Package', words: 'library sdk npm dependency' },
	{ key: 'box', icon: Box, label: 'Box', words: 'service component' },
	{ key: 'puzzle', icon: Puzzle, label: 'Puzzle', words: 'plugin extension integration' },
	{ key: 'plug', icon: Plug, label: 'Plug', words: 'integration connector api' },
	{ key: 'webhook', icon: Webhook, label: 'Webhook', words: 'events api hooks' },
	{ key: 'code', icon: Code, label: 'Code', words: 'refactor cleanup engineering' },
	{ key: 'terminal', icon: Terminal, label: 'Terminal', words: 'cli tooling scripts' },
	{ key: 'git-branch', icon: GitBranch, label: 'Branch', words: 'git migration upgrade' },
	{ key: 'bug', icon: Bug, label: 'Bug', words: 'fix bugs triage issues' },
	{ key: 'wrench', icon: Wrench, label: 'Wrench', words: 'maintenance chores fix' },
	{ key: 'hammer', icon: Hammer, label: 'Hammer', words: 'build construct' },
	{ key: 'flask', icon: FlaskConical, label: 'Flask', words: 'experiment test research lab' },
	{ key: 'gauge', icon: Gauge, label: 'Gauge', words: 'performance speed metrics' },
	{ key: 'zap', icon: Zap, label: 'Zap', words: 'fast performance energy' },
	{ key: 'activity', icon: Activity, label: 'Activity', words: 'monitoring observability health' },
	{ key: 'chart', icon: ChartColumn, label: 'Chart', words: 'analytics data reports' },
	{ key: 'dashboard', icon: LayoutDashboard, label: 'Dashboard', words: 'admin console panel' },
	{ key: 'database', icon: Database, label: 'Database', words: 'data schema storage sql' },
	{ key: 'server', icon: Server, label: 'Server', words: 'backend infra hosting' },
	{ key: 'cloud', icon: Cloud, label: 'Cloud', words: 'infra aws hosting deploy' },
	{ key: 'cpu', icon: Cpu, label: 'Chip', words: 'compute hardware ml' },
	{ key: 'globe', icon: Globe, label: 'Globe', words: 'web website site i18n' },
	{ key: 'monitor', icon: Monitor, label: 'Monitor', words: 'desktop frontend ui' },
	{ key: 'smartphone', icon: Smartphone, label: 'Phone', words: 'mobile ios android app' },
	{ key: 'palette', icon: Palette, label: 'Palette', words: 'design theme ui brand' },
	{ key: 'pen-tool', icon: PenTool, label: 'Pen', words: 'design illustration' },
	{ key: 'image', icon: Image, label: 'Image', words: 'media assets photos' },
	{ key: 'camera', icon: Camera, label: 'Camera', words: 'media video capture' },
	{ key: 'book-open', icon: BookOpen, label: 'Book', words: 'docs documentation guide readme' },
	{ key: 'file-text', icon: FileText, label: 'Document', words: 'docs spec content writing' },
	{ key: 'languages', icon: Languages, label: 'Languages', words: 'i18n translation localization' },
	{ key: 'shield', icon: Shield, label: 'Shield', words: 'security compliance audit' },
	{ key: 'lock', icon: Lock, label: 'Lock', words: 'auth security privacy' },
	{ key: 'key', icon: KeyRound, label: 'Key', words: 'auth login sso credentials' },
	{ key: 'scale', icon: Scale, label: 'Scale', words: 'legal compliance policy' },
	{ key: 'credit-card', icon: CreditCard, label: 'Card', words: 'billing payments stripe' },
	{ key: 'wallet', icon: Wallet, label: 'Wallet', words: 'finance billing money' },
	{ key: 'receipt', icon: Receipt, label: 'Receipt', words: 'invoices billing orders' },
	{ key: 'shopping-cart', icon: ShoppingCart, label: 'Cart', words: 'shop ecommerce checkout' },
	{ key: 'store', icon: Store, label: 'Store', words: 'shop marketplace commerce' },
	{ key: 'truck', icon: Truck, label: 'Truck', words: 'shipping delivery logistics' },
	{ key: 'users', icon: Users, label: 'People', words: 'team accounts customers community' },
	{ key: 'message', icon: MessageSquare, label: 'Message', words: 'chat support feedback' },
	{ key: 'mail', icon: Mail, label: 'Mail', words: 'email newsletter notifications' },
	{ key: 'megaphone', icon: Megaphone, label: 'Megaphone', words: 'marketing announcement growth' },
	{ key: 'calendar', icon: Calendar, label: 'Calendar', words: 'schedule planning sprint' },
	{ key: 'briefcase', icon: Briefcase, label: 'Briefcase', words: 'business client work' },
	{ key: 'building', icon: Building2, label: 'Building', words: 'company enterprise org' },
	{ key: 'graduation', icon: GraduationCap, label: 'Cap', words: 'learning education course' },
	{ key: 'bot', icon: Bot, label: 'Bot', words: 'ai agent automation llm' },
	{ key: 'brain', icon: Brain, label: 'Brain', words: 'ai ml model research' },
	{ key: 'sparkles', icon: Sparkles, label: 'Sparkles', words: 'ai new feature magic' },
	{ key: 'lightbulb', icon: Lightbulb, label: 'Idea', words: 'ideas prototype brainstorm' },
	{ key: 'atom', icon: Atom, label: 'Atom', words: 'react science core' },
	{ key: 'radar', icon: Radar, label: 'Radar', words: 'scanning detection tracking' },
	{ key: 'telescope', icon: Telescope, label: 'Telescope', words: 'research explore spike' },
	{ key: 'heart-pulse', icon: HeartPulse, label: 'Pulse', words: 'health uptime reliability' },
	{ key: 'flame', icon: Flame, label: 'Flame', words: 'hotfix incident urgent' },
	{ key: 'leaf', icon: Leaf, label: 'Leaf', words: 'green sustainability cleanup' },
	{ key: 'anchor', icon: Anchor, label: 'Anchor', words: 'stable core foundation' },
	{ key: 'trophy', icon: Trophy, label: 'Trophy', words: 'win achievement goals' },
	{ key: 'gamepad', icon: Gamepad2, label: 'Game', words: 'games fun play' },
];

const BY_KEY = new Map(PROJECT_ICONS.map((entry) => [entry.key, entry]));

/** The tints a mark can take: the chart hues, so marks sit with the rest of the page. */
export const ICON_TINTS = [
	{ key: 'cyan', label: 'Cyan', color: 'var(--data-1)' },
	{ key: 'violet', label: 'Violet', color: 'var(--data-2)' },
	{ key: 'amber', label: 'Amber', color: 'var(--data-3)' },
	{ key: 'green', label: 'Green', color: 'var(--data-4)' },
	{ key: 'pink', label: 'Pink', color: 'var(--data-5)' },
	{ key: 'gray', label: 'Gray', color: 'var(--neutral-300)' },
] as const;

export type IconTint = (typeof ICON_TINTS)[number]['key'];

const tintColor = (tint: string) => ICON_TINTS.find((item) => item.key === tint)?.color ?? ICON_TINTS[0].color;

/** What a saved icon names: the drawn icon and its tint, or nothing to draw. */
export function parseIcon(value: string | null | undefined): { entry: ProjectIconEntry; tint: IconTint } | null {
	const [key, tint] = (value ?? '').split(':');
	const entry = key ? BY_KEY.get(key) : undefined;
	if (!entry) return null;
	return { entry, tint: ICON_TINTS.some((item) => item.key === tint) ? (tint as IconTint) : 'cyan' };
}

export const iconValue = (key: string, tint: IconTint) => (tint === 'cyan' ? key : `${key}:${tint}`);

/** An icon to start a new project with, from the words in its name; a folder when nothing fits. */
export function suggestIcon(name: string): string {
	const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
	for (const word of words) {
		const hit = PROJECT_ICONS.find((entry) => entry.key === word || entry.words.split(' ').some((tag) => tag === word || (word.length > 3 && tag.startsWith(word))));
		if (hit) return hit.key;
	}
	return 'folder';
}

/** A project's mark: its icon on a tile tinted to match, or its initial when it has none. */
export function ProjectIcon({ value, name, size = 24, className }: { value: string | null | undefined; name: string; size?: number; className?: string }) {
	const parsed = parseIcon(value);
	const radius = Math.max(5, Math.round(size * 0.3));
	if (!parsed) {
		return (
			<span
				aria-hidden
				className={cn('inline-flex shrink-0 items-center justify-center border border-(--border-subtle) bg-(--well-bg) font-medium text-(--accent-text)', className)}
				style={{ width: size, height: size, borderRadius: radius, fontSize: Math.round(size * 0.48) }}
			>
				{name.trim().charAt(0).toUpperCase() || 'P'}
			</span>
		);
	}
	const color = tintColor(parsed.tint);
	return (
		<span
			aria-hidden
			data-icon={parsed.entry.key}
			className={cn('inline-flex shrink-0 items-center justify-center border', className)}
			style={{
				width: size,
				height: size,
				borderRadius: radius,
				color,
				background: `linear-gradient(180deg, color-mix(in srgb, ${color} 22%, var(--well-bg)), color-mix(in srgb, ${color} 10%, var(--well-bg)))`,
				borderColor: `color-mix(in srgb, ${color} 34%, transparent)`,
				boxShadow: `inset 0 1px 0 color-mix(in srgb, ${color} 18%, transparent)`,
			}}
		>
			<parsed.entry.icon size={Math.round(size * 0.56)} strokeWidth={size >= 28 ? 1.75 : 2} />
		</span>
	);
}

/**
 * The icon picker: the mark as a button that opens a searchable grid of
 * icons and a row of tints. Choosing either saves the pair as one value.
 */
export function IconPicker({ value, name, onChange, size = 36 }: { value: string | null; name: string; onChange: (value: string) => void; size?: number }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const parsed = parseIcon(value);
	const tint = parsed?.tint ?? 'cyan';
	const key = parsed?.entry.key ?? null;
	const shown = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return PROJECT_ICONS;
		// Words that start with what is typed, so "ai" finds the AI icons and not "maintenance".
		return PROJECT_ICONS.filter((entry) => `${entry.key.replace(/-/g, ' ')} ${entry.label} ${entry.words}`.toLowerCase().split(' ').some((word) => word.startsWith(needle)));
	}, [query]);
	return (
		<PopoverPrimitive.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setQuery('');
			}}
		>
			<PopoverPrimitive.Trigger asChild>
				<button
					type="button"
					aria-label={parsed ? `Project icon: ${parsed.entry.label}. Change icon` : 'Choose an icon'}
					className="group/icon relative inline-flex shrink-0 items-center justify-center rounded-[11px] outline-none focus-visible:shadow-(--focus-ring) data-[state=open]:shadow-(--focus-ring)"
				>
					<ProjectIcon value={value} name={name} size={size} className="transition-[filter] group-hover/icon:brightness-125" />
				</button>
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={12}
					onOpenAutoFocus={(event) => {
						// Focus the search, and bring the icon in use into view.
						const content = event.currentTarget as HTMLElement;
						requestAnimationFrame(() => content.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }));
					}}
					className="z-50 flex w-[min(316px,calc(100vw-24px))] in-pop flex-col overflow-hidden text-(--text-primary) outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
				>
					<div className="flex items-center gap-2 border-b border-(--border-subtle) px-2.5 py-2">
						<Icon icon={Search} size={13} className="text-(--icon-tertiary)" />
						<input
							autoFocus
							aria-label="Search icons"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search icons: billing, docs, ai…"
							className="h-6 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-(--text-disabled)"
						/>
					</div>
					<div role="listbox" aria-label="Icons" className="grid max-h-[212px] grid-cols-8 gap-1 overflow-y-auto p-2">
						{shown.map((entry) => {
							const on = entry.key === key;
							return (
								<button
									key={entry.key}
									type="button"
									role="option"
									aria-selected={on}
									aria-label={entry.label}
									title={entry.label}
									onClick={() => {
										onChange(iconValue(entry.key, tint));
										setOpen(false);
									}}
									className={cn(
										'flex aspect-square items-center justify-center rounded-[8px] border outline-none focus-visible:shadow-(--focus-ring)',
										on ? 'border-transparent' : 'border-transparent text-(--icon-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)',
									)}
									style={on ? { color: tintColor(tint), background: `color-mix(in srgb, ${tintColor(tint)} 16%, transparent)`, borderColor: `color-mix(in srgb, ${tintColor(tint)} 40%, transparent)` } : undefined}
								>
									<entry.icon size={16} strokeWidth={1.9} />
								</button>
							);
						})}
						{shown.length === 0 ? <span className="col-span-8 px-1 py-3 text-center text-[12px] text-(--text-disabled)">No icon matches “{query}”</span> : null}
					</div>
					<div className="flex items-center gap-2 border-t border-(--border-subtle) px-2.5 py-2">
						<span className="in-caption">Tint</span>
						<div role="radiogroup" aria-label="Tint" className="flex items-center gap-1.5">
							{ICON_TINTS.map((item) => {
								const on = item.key === tint;
								return (
									<button
										key={item.key}
										type="button"
										role="radio"
										aria-checked={on}
										aria-label={item.label}
										title={item.label}
										onClick={() => onChange(iconValue(key ?? suggestIcon(name), item.key))}
										className="relative flex size-[18px] items-center justify-center rounded-full outline-none focus-visible:shadow-(--focus-ring)"
										style={{ background: item.color, boxShadow: on ? `0 0 0 2px var(--bg-overlay), 0 0 0 3.5px ${item.color}` : undefined }}
									>
										{on ? <Check size={11} strokeWidth={3} className="text-(--neutral-950)" /> : null}
									</button>
								);
							})}
						</div>
					</div>
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}
