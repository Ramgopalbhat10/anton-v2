import { CalendarClock, Check, ChevronDown, Clock, Globe, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	clockTime,
	cronOf,
	DAY_NAMES,
	describeSchedule,
	type Frequency,
	HOUR_STEPS,
	localTimeZone,
	nextRuns,
	runTime,
	type Schedule,
	scheduleProblem,
	timeZones,
	WEEK,
	zoneOffset,
} from '../../core/schedule';
import { Icon } from '@/components/signal';
import type { Automation } from '@/lib/api';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

const FREQUENCY_LABEL: Record<Frequency, string> = {
	hourly: 'Hourly',
	daily: 'Daily',
	weekdays: 'Weekdays',
	weekly: 'Weekly',
	monthly: 'Monthly',
	cron: 'Custom (cron)',
};

const FIELD_TEXT = 'text-[13px] md:text-[13px]';
const ordinal = (day: number) => `${day}${day === 1 || day === 21 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th'}`;
const minute = (time: string) => Number(time.slice(3));

/** A scheduled routine's when, as its row reads: Every weekday at 9:00 AM, Kolkata time. */
export function whenItRuns(automation: Automation): string {
	if (!automation.schedule) return 'On a schedule';
	const words = describeSchedule(automation.schedule);
	return words[0].toUpperCase() + words.slice(1);
}

/** When a routine runs next, on its own clock: next Wed, Oct 22, 9:00 AM. */
export function nextRunText(automation: Automation): string {
	if (!automation.schedule) return '';
	const next = automation.nextRunAt ? new Date(automation.nextRunAt) : nextRuns(automation.schedule, new Date(automation.lastRunAt ?? automation.createdAt), 1)[0];
	return next ? `next ${runTime(next, automation.schedule.timeZone)}` : '';
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
	return (
		<div className={cn('flex min-w-0 flex-col gap-1', className)}>
			<span className="text-[11px] text-(--text-tertiary)">{label}</span>
			{children}
		</div>
	);
}

/** A searchable list of every time zone, with its offset now; yours and UTC first. */
function TimeZonePicker({ value, onChange }: { value: string; onChange: (zone: string) => void }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const local = localTimeZone();
	// Offsets are read once per opening: some 400 zones, each a formatter.
	const zones = useMemo(() => (open ? timeZones().map((zone) => ({ zone, offset: zoneOffset(zone) })) : []), [open]);
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const shown = zones.filter(({ zone, offset }) => words.every((word) => `${zone} ${offset}`.toLowerCase().replace(/_/g, ' ').includes(word)));
	const pick = (zone: string) => {
		onChange(zone);
		setOpen(false);
		setQuery('');
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label="Time zone"
					className={cn(
						'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg border border-input bg-input/30 px-2.5 text-left outline-none transition-colors hover:bg-input/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
						FIELD_TEXT,
					)}
				>
					<Icon icon={Globe} size={13} className="text-(--icon-tertiary)" />
					<span className="min-w-0 flex-1 truncate text-(--text-primary)">{value.replace(/_/g, ' ')}</span>
					<span className="in-num shrink-0 text-[11px] text-(--text-tertiary)">{zoneOffset(value)}</span>
					<Icon icon={ChevronDown} size={13} className="text-(--icon-tertiary)" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[min(320px,calc(100vw-24px))] gap-0 overflow-hidden p-0">
				<InputGroup className="rounded-none border-0 border-b border-(--border-subtle) dark:bg-transparent">
					<InputGroupAddon>
						<Search />
					</InputGroupAddon>
					<InputGroupInput autoFocus aria-label="Find a time zone" placeholder="City, region or GMT+5:30" value={query} onChange={(event) => setQuery(event.target.value)} className={FIELD_TEXT} />
				</InputGroup>
				<div role="listbox" aria-label="Time zones" className="max-h-[260px] overflow-y-auto p-1">
					{shown.length === 0 ? <div className="px-2 py-3 text-[12px] text-(--text-disabled)">No time zone matches</div> : null}
					{shown.map(({ zone, offset }) => (
						<button
							key={zone}
							type="button"
							role="option"
							aria-selected={zone === value}
							onClick={() => pick(zone)}
							className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-(--text-primary) outline-none hover:bg-accent focus-visible:bg-accent"
						>
							<span className="min-w-0 flex-1 truncate">{zone.replace(/_/g, ' ')}</span>
							{zone === local ? <span className="shrink-0 rounded-[4px] bg-(--alpha-white-6) px-1 text-[10px] text-(--text-secondary)">yours</span> : null}
							<span className="in-num shrink-0 text-[11px] text-(--text-tertiary)">{offset}</span>
							<Icon icon={Check} size={12} className={cn('text-(--accent-text)', zone === value ? 'opacity-100' : 'opacity-0')} />
						</button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}

/** Its next runs on its own clock, and on yours when that differs. */
function NextRuns({ schedule }: { schedule: Schedule }) {
	const problem = scheduleProblem(schedule);
	const runs = problem ? [] : nextRuns(schedule, new Date(), 3);
	const local = localTimeZone();
	const elsewhere = schedule.timeZone !== local && zoneOffset(schedule.timeZone) !== zoneOffset(local);
	return (
		<div aria-live="polite" className="flex flex-col gap-1.5 rounded-lg bg-(--bg-surface) px-3 py-2.5">
			<div className="flex items-center gap-2">
				<Icon icon={CalendarClock} size={13} className={problem ? 'text-(--danger-text)' : 'text-(--accent-text)'} />
				<span className={cn('min-w-0 flex-1 text-[13px]', problem ? 'text-(--danger-text)' : 'text-(--text-primary)')}>
					{problem ?? `Runs ${describeSchedule(schedule)}`}
				</span>
			</div>
			{runs.length ? (
				<ol aria-label="Next runs" className="m-0 flex list-none flex-col gap-0.5 p-0 pl-[21px]">
					{runs.map((run) => (
						<li key={run.getTime()} className="in-num flex flex-wrap gap-x-2 text-[12px] text-(--text-secondary)">
							<span>{runTime(run, schedule.timeZone)}</span>
							{elsewhere ? <span className="text-(--text-tertiary)">· {runTime(run, local)} your time</span> : null}
						</li>
					))}
				</ol>
			) : null}
		</div>
	);
}

/**
 * When a routine runs: how often, at what time on which days, in which time zone (yours to begin with), or a
 * cron expression; with what that comes to in words and its next runs.
 */
export function ScheduleEditor({ value, onChange }: { value: Schedule; onChange: (schedule: Schedule) => void }) {
	const set = (change: Partial<Schedule>) => onChange({ ...value, ...change });
	const { frequency } = value;
	// Minutes in steps of five, and the routine's own when it is between them.
	const minutes = [...new Set([...Array.from({ length: 12 }, (_, index) => index * 5), minute(value.time)])].sort((a, b) => a - b);
	const atTime = frequency === 'daily' || frequency === 'weekdays' || frequency === 'weekly' || frequency === 'monthly';
	return (
		<div className="@container/schedule flex flex-col gap-2.5">
			<div className="grid grid-cols-2 gap-2 @min-[480px]/schedule:grid-cols-[minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,1.3fr)]">
				<Field label="Repeats">
					<Select
						value={frequency}
						// A custom expression starts as what the schedule was, to change from there.
						onValueChange={(next) => set({ frequency: next as Frequency, ...(next === 'cron' && !value.cron.trim() ? { cron: cronOf(value) } : {}) })}
					>
						<SelectTrigger aria-label="Repeats" className={cn('w-full', FIELD_TEXT)}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper">
							{(['hourly', 'daily', 'weekdays', 'weekly', 'monthly'] as const).map((item) => (
								<SelectItem key={item} value={item} className={FIELD_TEXT}>
									{FREQUENCY_LABEL[item]}
								</SelectItem>
							))}
							<SelectSeparator />
							<SelectItem value="cron" className={FIELD_TEXT}>
								{FREQUENCY_LABEL.cron}
							</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				{atTime ? (
					<Field label="At">
						<InputGroup>
							<InputGroupAddon>
								<Clock />
							</InputGroupAddon>
							<InputGroupInput
								type="time"
								aria-label="Time of day"
								required
								value={value.time}
								onChange={(event) => event.target.value && set({ time: event.target.value })}
								className={cn('in-num appearance-none [&::-webkit-calendar-picker-indicator]:hidden', FIELD_TEXT)}
							/>
						</InputGroup>
					</Field>
				) : frequency === 'hourly' ? (
					<Field label="Past the hour">
						<Select value={String(minute(value.time))} onValueChange={(next) => set({ time: `${value.time.slice(0, 2)}:${next.padStart(2, '0')}` })}>
							<SelectTrigger aria-label="Minutes past the hour" className={cn('in-num w-full', FIELD_TEXT)}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper" className="max-h-[240px]">
								{minutes.map((item) => (
									<SelectItem key={item} value={String(item)} className={cn('in-num', FIELD_TEXT)}>
										:{String(item).padStart(2, '0')}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
				) : (
					<Field label="Expression">
						<InputGroup>
							<InputGroupInput
								aria-label="Cron expression"
								spellCheck={false}
								value={value.cron}
								placeholder="0 9 * * 1-5"
								onChange={(event) => set({ cron: event.target.value })}
								aria-invalid={Boolean(scheduleProblem(value)) || undefined}
								className={cn('font-mono', FIELD_TEXT)}
							/>
						</InputGroup>
					</Field>
				)}
				<Field label="Time zone" className="col-span-2 @min-[480px]/schedule:col-span-1">
					<TimeZonePicker value={value.timeZone} onChange={(timeZone) => set({ timeZone })} />
				</Field>
			</div>
			{frequency === 'hourly' ? (
				<Field label="Every">
					<ToggleGroup
						type="single"
						variant="outline"
						size="sm"
						spacing={1}
						aria-label="Hours between runs"
						value={String(value.everyHours)}
						onValueChange={(next) => next && set({ everyHours: Number(next) })}
						className="flex-wrap"
					>
						{HOUR_STEPS.map((hours) => (
							<ToggleGroupItem key={hours} value={String(hours)} aria-label={hours === 1 ? 'Every hour' : `Every ${hours} hours`} className="in-num text-[12px]">
								{hours === 1 ? '1 hour' : `${hours} hours`}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</Field>
			) : null}
			{frequency === 'weekly' ? (
				<Field label="On">
					<ToggleGroup
						type="multiple"
						variant="outline"
						size="sm"
						spacing={1}
						aria-label="Days of the week"
						value={value.days.map(String)}
						// At least one day stays picked.
						onValueChange={(next) => next.length && set({ days: next.map(Number).sort((a, b) => a - b) })}
						className="flex-wrap"
					>
						{WEEK.map((day) => (
							<ToggleGroupItem key={day} value={String(day)} aria-label={DAY_NAMES[day]} className="w-11 text-[12px] data-[state=on]:border-(--accent-border) data-[state=on]:bg-(--accent-bg-subtle) data-[state=on]:text-(--accent-text)">
								{DAY_NAMES[day].slice(0, 3)}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</Field>
			) : null}
			{frequency === 'monthly' ? (
				<Field label="On day" className="max-w-[200px]">
					<Select value={String(value.dayOfMonth)} onValueChange={(next) => set({ dayOfMonth: Number(next) })}>
						<SelectTrigger aria-label="Day of the month" className={cn('w-full', FIELD_TEXT)}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper" className="max-h-[260px]">
							{Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
								<SelectItem key={day} value={String(day)} className={cn('in-num', FIELD_TEXT)}>
									The {ordinal(day)}
								</SelectItem>
							))}
							<SelectSeparator />
							<SelectItem value="0" className={FIELD_TEXT}>
								The last day
							</SelectItem>
						</SelectContent>
					</Select>
				</Field>
			) : null}
			{frequency === 'cron' ? (
				<p className="m-0 text-[11px] leading-[16px] text-(--text-tertiary)">
					Five fields on the time zone's clock: <span className="font-mono">minute hour day-of-month month day-of-week</span>. For example{' '}
					<span className="font-mono">30 8 * * 1,3,5</span> runs at {clockTime('08:30')} on Mondays, Wednesdays and Fridays.
				</p>
			) : null}
			<NextRuns schedule={value} />
		</div>
	);
}
