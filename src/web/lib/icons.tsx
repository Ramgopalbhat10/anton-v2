import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
	Activity01Icon,
	AlertCircleIcon,
	AnchorIcon,
	AppWindowIcon,
	ArrowDown02Icon,
	ArrowDownWideNarrowIcon,
	ArrowExpand01Icon,
	ArrowLeft02Icon,
	ArrowLeftRightIcon,
	ArrowRight02Icon,
	ArrowShrink01Icon,
	ArrowUp02Icon,
	ArrowUpDownIcon,
	ArrowUpRight01Icon,
	Atom01Icon,
	BellIcon,
	BellOffIcon,
	BellRingIcon,
	BinocularsIcon,
	BlocksIcon,
	BookOpen01Icon,
	Bookmark01Icon,
	BotIcon,
	BoxIcon,
	BoxesIcon,
	BracesIcon,
	BrainIcon,
	Briefcase01Icon,
	BubbleChatQuestionIcon,
	Bug01Icon,
	Building03Icon,
	Calendar03Icon,
	CalendarClockIcon,
	CalendarDaysIcon,
	Camera01Icon,
	ChartColumnIcon,
	ChartNoAxesColumnIcon,
	CheckCheckIcon,
	CheckIcon as CheckGlyph,
	CheckmarkSquare02Icon,
	ChevronDownIcon as ChevronDownGlyph,
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronUpIcon as ChevronUpGlyph,
	ChevronsDownUpIcon,
	CircleCheckIcon,
	CircleDashedIcon,
	CircleDollarSignIcon,
	CircleDotIcon,
	CircleIcon,
	CircleXIcon,
	ClipboardListIcon,
	Clock01Icon,
	CloudCheckIcon,
	CloudIcon,
	CodeIcon,
	Coins01Icon,
	CompassIcon,
	CopyIcon,
	CornerDownRightIcon,
	CpuIcon,
	CreditCardIcon,
	DatabaseIcon,
	Delete02Icon,
	Download04Icon,
	ExternalLinkIcon,
	Edit02Icon,
	EyeIcon,
	EyeOffIcon,
	File01Icon,
	FileArchiveIcon,
	FileCodeIcon,
	FileDiffIcon,
	FileImageIcon,
	FileMinusIcon,
	FilePlusIcon,
	FileRemoveIcon,
	FileSpreadsheetIcon,
	FileStackIcon,
	FileTextIcon,
	Files02Icon,
	FilterIcon,
	Flag01Icon,
	FlameIcon,
	FlaskConicalIcon,
	FoldVerticalIcon,
	Folder01Icon,
	FolderGit2Icon,
	FolderKanbanIcon,
	FolderMinusIcon,
	FolderOpenIcon,
	FolderSearchIcon,
	FolderUpIcon,
	GameController01Icon,
	GaugeIcon,
	GitBranchIcon,
	GitCommitHorizontalIcon,
	GitMergeIcon,
	GitPullRequestClosedIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
	GithubIcon,
	GlobeIcon,
	GraduationCapIcon,
	GridTableIcon,
	HammerIcon,
	HandIcon,
	HardDriveIcon,
	HeartPulseIcon,
	HistoryIcon,
	Home01Icon,
	HourglassIcon,
	Image01Icon,
	ImagePlusIcon,
	InboxIcon,
	InfoIcon,
	KeyRoundIcon,
	LanguagesIcon,
	Layers01Icon,
	LayoutDashboardIcon,
	LayoutGridIcon,
	LayoutPanelTopIcon,
	Leaf01Icon,
	LibraryIcon,
	LightbulbIcon,
	Link02Icon,
	LinkIcon,
	ListChecksIcon,
	ListFilterIcon,
	ListIcon,
	ListPlusIcon,
	ListTodoIcon,
	ListTreeIcon,
	LoaderIcon,
	LockIcon,
	LockKeyholeIcon,
	Mail01Icon,
	MapIcon,
	Megaphone01Icon,
	MenuIcon,
	MessageCircleReplyIcon,
	MessageSquareCodeIcon,
	MessageSquareIcon,
	MessageSquareTextIcon,
	MinusIcon,
	MonitorIcon,
	MonitorSmartphoneIcon,
	MoonIcon,
	MoreHorizontalIcon,
	MoreVerticalIcon,
	OctagonAlertIcon,
	PackageIcon,
	PaletteIcon,
	PanelLeftIcon,
	PanelLeftOpenIcon,
	PanelRightIcon,
	PaperclipIcon,
	PauseIcon,
	PenTool01Icon,
	PencilLineIcon,
	PinIcon,
	PinOffIcon,
	PlayIcon,
	PlugIcon,
	PlusIcon,
	PowerIcon,
	PresentationBarChart01Icon,
	PuzzleIcon,
	Radar01Icon,
	ReceiptIcon,
	Redo02Icon,
	RefreshCwIcon,
	RocketIcon,
	RotateCcwIcon,
	RotateCwIcon,
	Rows2Icon,
	Rows3Icon,
	ScaleIcon,
	ScanSearchIcon,
	ScrollTextIcon,
	Search01Icon,
	SendIcon,
	ServerCrashIcon,
	ServerIcon,
	ServerOffIcon,
	Settings01Icon,
	Settings02Icon,
	ShapesIcon,
	SheetIcon,
	Shield01Icon,
	ShieldCheckIcon,
	ShoppingCart01Icon,
	SlidersHorizontalIcon,
	SmartphoneIcon,
	SparkleIcon,
	SparklesIcon,
	SplitIcon,
	SquareDashedMousePointerIcon,
	SquareIcon,
	SquarePenIcon,
	SquareSlashIcon,
	SquareTerminalIcon,
	StarIcon,
	StopCircleIcon,
	Store01Icon,
	Sun03Icon,
	Tag01Icon,
	Target01Icon,
	TerminalIcon,
	Timer01Icon,
	TriangleAlertIcon,
	TrophyIcon,
	TruckIcon,
	TypeIcon,
	Undo02Icon,
	UnfoldMoreIcon,
	Upload04Icon,
	UsersIcon,
	Wallet01Icon,
	WaypointsIcon,
	WebhookIcon,
	WorkflowIcon,
	Wrench01Icon,
	XIcon,
	ZapIcon,
} from '@hugeicons/core-free-icons';
import { forwardRef, type ForwardRefExoticComponent, type RefAttributes, type SVGProps } from 'react';
import { cn } from '@/lib/utils';

/* Hugeicons' free stroke-rounded set (MIT), exported under the names the app used with Lucide. Every icon carries `icon icon-<name>` for tests and styles. */

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & { size?: number | string; strokeWidth?: number; absoluteStrokeWidth?: boolean };
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

function icon(name: string, glyph: IconSvgElement): IconComponent {
	const Drawn = forwardRef<SVGSVGElement, IconProps>(function Drawn({ className, strokeWidth = 1.5, ...props }, ref) {
		return <HugeiconsIcon ref={ref} icon={glyph} strokeWidth={strokeWidth} className={cn('icon', `icon-${name}`, className)} {...props} />;
	});
	Drawn.displayName = name;
	return Drawn;
}

export const Activity = icon('activity', Activity01Icon);
export const Anchor = icon('anchor', AnchorIcon);
export const AppWindow = icon('app-window', AppWindowIcon);
export const ArrowDown = icon('arrow-down', ArrowDown02Icon);
export const ArrowDownWideNarrow = icon('arrow-down-wide-narrow', ArrowDownWideNarrowIcon);
export const ArrowLeft = icon('arrow-left', ArrowLeft02Icon);
export const ArrowLeftRight = icon('arrow-left-right', ArrowLeftRightIcon);
export const ArrowRight = icon('arrow-right', ArrowRight02Icon);
export const ArrowUp = icon('arrow-up', ArrowUp02Icon);
export const ArrowUpDown = icon('arrow-up-down', ArrowUpDownIcon);
export const ArrowUpRight = icon('arrow-up-right', ArrowUpRight01Icon);
export const Atom = icon('atom', Atom01Icon);
export const Bell = icon('bell', BellIcon);
export const BellOff = icon('bell-off', BellOffIcon);
export const BellRing = icon('bell-ring', BellRingIcon);
export const Blocks = icon('blocks', BlocksIcon);
export const BookOpen = icon('book-open', BookOpen01Icon);
export const Bookmark = icon('bookmark', Bookmark01Icon);
export const Bot = icon('bot', BotIcon);
export const Box = icon('box', BoxIcon);
export const Boxes = icon('boxes', BoxesIcon);
export const Braces = icon('braces', BracesIcon);
export const Brain = icon('brain', BrainIcon);
export const Briefcase = icon('briefcase', Briefcase01Icon);
export const Bug = icon('bug', Bug01Icon);
export const Building2 = icon('building2', Building03Icon);
export const Calendar = icon('calendar', Calendar03Icon);
export const CalendarClock = icon('calendar-clock', CalendarClockIcon);
export const CalendarDays = icon('calendar-days', CalendarDaysIcon);
export const Camera = icon('camera', Camera01Icon);
export const ChartColumn = icon('chart-column', ChartColumnIcon);
export const ChartNoAxesColumn = icon('chart-no-axes-column', ChartNoAxesColumnIcon);
export const Check = icon('check', CheckGlyph);
export const CheckCheck = icon('check-check', CheckCheckIcon);
export const CheckIcon = icon('check', CheckGlyph);
export const CheckSquare = icon('check-square', CheckmarkSquare02Icon);
export const ChevronDown = icon('chevron-down', ChevronDownGlyph);
export const ChevronDownIcon = icon('chevron-down', ChevronDownGlyph);
export const ChevronLeft = icon('chevron-left', ChevronLeftIcon);
export const ChevronRight = icon('chevron-right', ChevronRightIcon);
export const ChevronUp = icon('chevron-up', ChevronUpGlyph);
export const ChevronUpIcon = icon('chevron-up', ChevronUpGlyph);
export const ChevronsDownUp = icon('chevrons-down-up', ChevronsDownUpIcon);
export const ChevronsUpDown = icon('chevrons-up-down', UnfoldMoreIcon);
export const Circle = icon('circle', CircleIcon);
export const CircleAlert = icon('circle-alert', AlertCircleIcon);
export const CircleCheck = icon('circle-check', CircleCheckIcon);
export const CircleDashed = icon('circle-dashed', CircleDashedIcon);
export const CircleDollarSign = icon('circle-dollar-sign', CircleDollarSignIcon);
export const CircleDot = icon('circle-dot', CircleDotIcon);
export const CircleStop = icon('circle-stop', StopCircleIcon);
export const CircleX = icon('circle-x', CircleXIcon);
export const ClipboardList = icon('clipboard-list', ClipboardListIcon);
export const Clock = icon('clock', Clock01Icon);
export const Cloud = icon('cloud', CloudIcon);
export const CloudCheck = icon('cloud-check', CloudCheckIcon);
export const Code = icon('code', CodeIcon);
export const Coins = icon('coins', Coins01Icon);
export const Compass = icon('compass', CompassIcon);
export const Copy = icon('copy', CopyIcon);
export const CornerDownRight = icon('corner-down-right', CornerDownRightIcon);
export const Cpu = icon('cpu', CpuIcon);
export const CreditCard = icon('credit-card', CreditCardIcon);
export const Database = icon('database', DatabaseIcon);
export const Download = icon('download', Download04Icon);
export const ExternalLink = icon('external-link', ExternalLinkIcon);
export const Eye = icon('eye', EyeIcon);
export const EyeOff = icon('eye-off', EyeOffIcon);
export const File = icon('file', File01Icon);
export const FileArchive = icon('file-archive', FileArchiveIcon);
export const FileCode = icon('file-code', FileCodeIcon);
export const FileDiff = icon('file-diff', FileDiffIcon);
export const FileImage = icon('file-image', FileImageIcon);
export const FileMinus = icon('file-minus', FileMinusIcon);
export const FilePlus = icon('file-plus', FilePlusIcon);
export const FileSpreadsheet = icon('file-spreadsheet', FileSpreadsheetIcon);
export const FileStack = icon('file-stack', FileStackIcon);
export const FileText = icon('file-text', FileTextIcon);
export const FileX2 = icon('file-x2', FileRemoveIcon);
export const Files = icon('files', Files02Icon);
export const Filter = icon('filter', FilterIcon);
export const Flag = icon('flag', Flag01Icon);
export const Flame = icon('flame', FlameIcon);
export const FlaskConical = icon('flask-conical', FlaskConicalIcon);
export const FoldVertical = icon('fold-vertical', FoldVerticalIcon);
export const Folder = icon('folder', Folder01Icon);
export const FolderGit2 = icon('folder-git2', FolderGit2Icon);
export const FolderKanban = icon('folder-kanban', FolderKanbanIcon);
export const FolderMinus = icon('folder-minus', FolderMinusIcon);
export const FolderOpen = icon('folder-open', FolderOpenIcon);
export const FolderSearch = icon('folder-search', FolderSearchIcon);
export const FolderUp = icon('folder-up', FolderUpIcon);
export const Gamepad2 = icon('gamepad2', GameController01Icon);
export const Gauge = icon('gauge', GaugeIcon);
export const GitBranch = icon('git-branch', GitBranchIcon);
export const GitCommitHorizontal = icon('git-commit-horizontal', GitCommitHorizontalIcon);
export const GitMerge = icon('git-merge', GitMergeIcon);
export const GitPullRequest = icon('git-pull-request', GitPullRequestIcon);
export const GitPullRequestClosed = icon('git-pull-request-closed', GitPullRequestClosedIcon);
export const GitPullRequestDraft = icon('git-pull-request-draft', GitPullRequestDraftIcon);
export const Github = icon('github', GithubIcon);
export const Globe = icon('globe', GlobeIcon);
export const GraduationCap = icon('graduation-cap', GraduationCapIcon);
export const Hammer = icon('hammer', HammerIcon);
export const Hand = icon('hand', HandIcon);
export const HardDrive = icon('hard-drive', HardDriveIcon);
export const HeartPulse = icon('heart-pulse', HeartPulseIcon);
export const History = icon('history', HistoryIcon);
export const Home = icon('home', Home01Icon);
export const Hourglass = icon('hourglass', HourglassIcon);
export const House = icon('house', Home01Icon);
export const Image = icon('image', Image01Icon);
export const ImagePlus = icon('image-plus', ImagePlusIcon);
export const Inbox = icon('inbox', InboxIcon);
export const Info = icon('info', InfoIcon);
export const KeyRound = icon('key-round', KeyRoundIcon);
export const Languages = icon('languages', LanguagesIcon);
export const Layers = icon('layers', Layers01Icon);
export const LayoutDashboard = icon('layout-dashboard', LayoutDashboardIcon);
export const LayoutGrid = icon('layout-grid', LayoutGridIcon);
export const LayoutPanelTop = icon('layout-panel-top', LayoutPanelTopIcon);
export const Leaf = icon('leaf', Leaf01Icon);
export const Library = icon('library', LibraryIcon);
export const Lightbulb = icon('lightbulb', LightbulbIcon);
export const Link = icon('link', LinkIcon);
export const Link2 = icon('link2', Link02Icon);
export const List = icon('list', ListIcon);
export const ListChecks = icon('list-checks', ListChecksIcon);
export const ListFilter = icon('list-filter', ListFilterIcon);
export const ListPlus = icon('list-plus', ListPlusIcon);
export const ListTodo = icon('list-todo', ListTodoIcon);
export const ListTree = icon('list-tree', ListTreeIcon);
export const Loader = icon('loader', LoaderIcon);
export const Lock = icon('lock', LockIcon);
export const LockKeyhole = icon('lock-keyhole', LockKeyholeIcon);
export const Mail = icon('mail', Mail01Icon);
export const Map = icon('map', MapIcon);
export const Maximize2 = icon('maximize2', ArrowExpand01Icon);
export const Megaphone = icon('megaphone', Megaphone01Icon);
export const Menu = icon('menu', MenuIcon);
export const MessageCircleQuestion = icon('message-circle-question', BubbleChatQuestionIcon);
export const MessageCircleReply = icon('message-circle-reply', MessageCircleReplyIcon);
export const MessageSquare = icon('message-square', MessageSquareIcon);
export const MessageSquareCode = icon('message-square-code', MessageSquareCodeIcon);
export const MessageSquareText = icon('message-square-text', MessageSquareTextIcon);
export const Minimize2 = icon('minimize2', ArrowShrink01Icon);
export const Minus = icon('minus', MinusIcon);
export const Monitor = icon('monitor', MonitorIcon);
export const MonitorSmartphone = icon('monitor-smartphone', MonitorSmartphoneIcon);
export const Moon = icon('moon', MoonIcon);
export const MoreHorizontal = icon('more-horizontal', MoreHorizontalIcon);
export const MoreVertical = icon('more-vertical', MoreVerticalIcon);
export const OctagonAlert = icon('octagon-alert', OctagonAlertIcon);
export const Package = icon('package', PackageIcon);
export const Palette = icon('palette', PaletteIcon);
export const PanelLeft = icon('panel-left', PanelLeftIcon);
export const PanelLeftOpen = icon('panel-left-open', PanelLeftOpenIcon);
export const PanelRight = icon('panel-right', PanelRightIcon);
export const Paperclip = icon('paperclip', PaperclipIcon);
export const Pause = icon('pause', PauseIcon);
export const PenTool = icon('pen-tool', PenTool01Icon);
export const Pencil = icon('pencil', Edit02Icon);
export const PencilLine = icon('pencil-line', PencilLineIcon);
export const Pin = icon('pin', PinIcon);
export const PinOff = icon('pin-off', PinOffIcon);
export const Play = icon('play', PlayIcon);
export const Plug = icon('plug', PlugIcon);
export const Plus = icon('plus', PlusIcon);
export const Power = icon('power', PowerIcon);
export const Presentation = icon('presentation', PresentationBarChart01Icon);
export const Puzzle = icon('puzzle', PuzzleIcon);
export const Radar = icon('radar', Radar01Icon);
export const Receipt = icon('receipt', ReceiptIcon);
export const Redo2 = icon('redo2', Redo02Icon);
export const RefreshCw = icon('refresh-cw', RefreshCwIcon);
export const Rocket = icon('rocket', RocketIcon);
export const RotateCcw = icon('rotate-ccw', RotateCcwIcon);
export const RotateCw = icon('rotate-cw', RotateCwIcon);
export const Rows2 = icon('rows2', Rows2Icon);
export const Rows3 = icon('rows3', Rows3Icon);
export const Scale = icon('scale', ScaleIcon);
export const ScanSearch = icon('scan-search', ScanSearchIcon);
export const ScrollText = icon('scroll-text', ScrollTextIcon);
export const Search = icon('search', Search01Icon);
export const Send = icon('send', SendIcon);
export const Server = icon('server', ServerIcon);
export const ServerCrash = icon('server-crash', ServerCrashIcon);
export const ServerOff = icon('server-off', ServerOffIcon);
export const Settings = icon('settings', Settings01Icon);
export const Settings2 = icon('settings2', Settings02Icon);
export const Shapes = icon('shapes', ShapesIcon);
export const Sheet = icon('sheet', SheetIcon);
export const Shield = icon('shield', Shield01Icon);
export const ShieldCheck = icon('shield-check', ShieldCheckIcon);
export const ShoppingCart = icon('shopping-cart', ShoppingCart01Icon);
export const SlidersHorizontal = icon('sliders-horizontal', SlidersHorizontalIcon);
export const Smartphone = icon('smartphone', SmartphoneIcon);
export const Sparkle = icon('sparkle', SparkleIcon);
export const Sparkles = icon('sparkles', SparklesIcon);
export const Split = icon('split', SplitIcon);
export const Square = icon('square', SquareIcon);
export const SquareDashedMousePointer = icon('square-dashed-mouse-pointer', SquareDashedMousePointerIcon);
export const SquarePen = icon('square-pen', SquarePenIcon);
export const SquareSlash = icon('square-slash', SquareSlashIcon);
export const SquareTerminal = icon('square-terminal', SquareTerminalIcon);
export const Star = icon('star', StarIcon);
export const Store = icon('store', Store01Icon);
export const Sun = icon('sun', Sun03Icon);
export const Table2 = icon('table2', GridTableIcon);
export const Tag = icon('tag', Tag01Icon);
export const Target = icon('target', Target01Icon);
export const Telescope = icon('telescope', BinocularsIcon);
export const Terminal = icon('terminal', TerminalIcon);
export const Timer = icon('timer', Timer01Icon);
export const Trash2 = icon('trash2', Delete02Icon);
export const TriangleAlert = icon('triangle-alert', TriangleAlertIcon);
export const Trophy = icon('trophy', TrophyIcon);
export const Truck = icon('truck', TruckIcon);
export const Type = icon('type', TypeIcon);
export const Undo2 = icon('undo2', Undo02Icon);
export const Upload = icon('upload', Upload04Icon);
export const Users = icon('users', UsersIcon);
export const Wallet = icon('wallet', Wallet01Icon);
export const Waypoints = icon('waypoints', WaypointsIcon);
export const Webhook = icon('webhook', WebhookIcon);
export const Workflow = icon('workflow', WorkflowIcon);
export const Wrench = icon('wrench', Wrench01Icon);
export const X = icon('x', XIcon);
export const Zap = icon('zap', ZapIcon);
