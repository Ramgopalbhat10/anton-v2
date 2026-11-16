import { Cron } from 'croner';

/** On the zone's own clock, so 9:00 stays 9:00 across daylight saving; croner runs a skipped time at the next valid one and a repeated one once. */
export const FREQUENCIES = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'cron'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export type Schedule = {
	frequency: Frequency;
	/** `HH:MM`; hourly runs use only its minutes. */
	time: string;
	/** Counted from midnight: a divisor of 24, so each day's runs fall at the same times. */
	everyHours: number;
	/** 0 for Sunday to 6 for Saturday. */
	days: number[];
	/** 1 to 28 (every month has them), or 0 for the month's last day. */
	dayOfMonth: number;
	/** Five fields (minute hour day month weekday), for `cron`. */
	cron: string;
	timeZone: string;
};

export type ScheduleInput = Partial<Schedule> & Pick<Schedule, 'frequency'>;

export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

/** Old names ICU still lists (and Chrome reports) for renamed zones; Intl and croner take either. */
const RENAMED: Record<string, string> = {
	'Asia/Calcutta': 'Asia/Kolkata',
	'Asia/Saigon': 'Asia/Ho_Chi_Minh',
	'Asia/Katmandu': 'Asia/Kathmandu',
	'Asia/Rangoon': 'Asia/Yangon',
	'Europe/Kiev': 'Europe/Kyiv',
	'Atlantic/Faeroe': 'Atlantic/Faroe',
	'America/Godthab': 'America/Nuuk',
	'Pacific/Ponape': 'Pacific/Pohnpei',
	'Pacific/Truk': 'Pacific/Chuuk',
	'Pacific/Enderbury': 'Pacific/Kanton',
};
const current = (zone: string) => RENAMED[zone] ?? zone;

export function localTimeZone(): string {
	try {
		return current(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
	} catch {
		return 'UTC';
	}
}

export function defaultSchedule(timeZone = localTimeZone()): Schedule {
	return { frequency: 'daily', time: '09:00', everyHours: 6, days: [1], dayOfMonth: 1, cron: '0 9 * * 1-5', timeZone };
}

export function normalizeSchedule(input: ScheduleInput): Schedule {
	const base = defaultSchedule('UTC');
	return {
		frequency: input.frequency,
		time: input.time ?? base.time,
		everyHours: input.everyHours ?? base.everyHours,
		days: [...new Set(input.days ?? base.days)].sort((a, b) => a - b),
		dayOfMonth: input.dayOfMonth ?? base.dayOfMonth,
		cron: (input.cron ?? '').trim().replace(/\s+/g, ' '),
		timeZone: input.timeZone?.trim() || base.timeZone,
	};
}

const clock = (time: string): [number, number] => {
	const [hours, minutes] = time.split(':').map(Number);
	return [hours, minutes];
};

export function isTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

export function cronOf(schedule: Schedule): string {
	const [hours, minutes] = clock(schedule.time);
	switch (schedule.frequency) {
		case 'hourly':
			return `${minutes} ${schedule.everyHours === 1 ? '*' : `*/${schedule.everyHours}`} * * *`;
		case 'daily':
			return `${minutes} ${hours} * * *`;
		case 'weekdays':
			return `${minutes} ${hours} * * 1-5`;
		case 'weekly':
			return `${minutes} ${hours} * * ${schedule.days.join(',')}`;
		case 'monthly':
			return `${minutes} ${hours} ${schedule.dayOfMonth === 0 ? 'L' : schedule.dayOfMonth} * *`;
		case 'cron':
			return schedule.cron;
	}
}

export function scheduleProblem(schedule: Schedule): string | null {
	if (!FREQUENCIES.includes(schedule.frequency)) return 'Pick how often it runs';
	if (!isTimeZone(schedule.timeZone)) return `“${schedule.timeZone}” is not a time zone`;
	const time = /^(\d{2}):(\d{2})$/.exec(schedule.time);
	if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) return 'Pick a time of day';
	if (schedule.frequency === 'hourly' && !(HOUR_STEPS as readonly number[]).includes(schedule.everyHours)) return 'Pick how many hours apart it runs';
	if (schedule.frequency === 'weekly' && (schedule.days.length === 0 || schedule.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) {
		return 'Pick at least one day';
	}
	if (schedule.frequency === 'monthly' && !(Number.isInteger(schedule.dayOfMonth) && schedule.dayOfMonth >= 0 && schedule.dayOfMonth <= 28)) {
		return 'Pick a day of the month';
	}
	if (schedule.frequency === 'cron') {
		if (schedule.cron.split(' ').length !== 5) return 'Write five fields: minute hour day month weekday';
		try {
			new Cron(schedule.cron, { timezone: schedule.timeZone, paused: true });
		} catch (error) {
			return `That cron expression does not read: ${error instanceof Error ? error.message.replace(/^CronPattern: /, '') : String(error)}`;
		}
	}
	return nextRuns(schedule, new Date(), 1).length ? null : 'That schedule never runs';
}

export function nextRuns(schedule: Schedule, after: Date, count: number): Date[] {
	try {
		return new Cron(cronOf(schedule), { timezone: schedule.timeZone, paused: true }).nextRuns(count, after);
	} catch {
		return [];
	}
}

export const nextRun = (schedule: Schedule, after: Date): Date | null => nextRuns(schedule, after, 1)[0] ?? null;

export function clockTime(time: string): string {
	const [hours, minutes] = clock(time);
	return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

const ordinal = (day: number) => `${day}${day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'}`;

function listed(words: string[]): string {
	return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

export function zoneName(zone: string): string {
	if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
	return `${(zone.split('/').pop() ?? zone).replace(/_/g, ' ')} time`;
}

export function zoneOffset(zone: string, at = new Date()): string {
	try {
		const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(at).find((item) => item.type === 'timeZoneName');
		return part?.value ?? '';
	} catch {
		return '';
	}
}

export function describeSchedule(schedule: Schedule): string {
	const at = clockTime(schedule.time);
	const zone = zoneName(schedule.timeZone);
	switch (schedule.frequency) {
		case 'hourly': {
			const minutes = `:${schedule.time.slice(3)}`;
			return `${schedule.everyHours === 1 ? 'every hour' : `every ${schedule.everyHours} hours`} at ${minutes}, ${zone}`;
		}
		case 'daily':
			return `every day at ${at}, ${zone}`;
		case 'weekdays':
			return `every weekday at ${at}, ${zone}`;
		case 'weekly': {
			const days = WEEK.filter((day) => schedule.days.includes(day));
			if (days.length === 7) return `every day at ${at}, ${zone}`;
			const names = days.map((day) => (days.length > 2 ? DAY_NAMES[day].slice(0, 3) : DAY_NAMES[day]));
			return `every ${listed(names)} at ${at}, ${zone}`;
		}
		case 'monthly':
			return `on the ${schedule.dayOfMonth === 0 ? 'last day' : ordinal(schedule.dayOfMonth)} of every month at ${at}, ${zone}`;
		case 'cron':
			return `on the cron schedule “${schedule.cron}”, ${zone}`;
	}
}

export function runTime(at: Date, zone: string): string {
	return at.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone });
}

export function timeZones(): string[] {
	const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
	return [...new Set([localTimeZone(), 'UTC', ...known.map(current)])];
}
