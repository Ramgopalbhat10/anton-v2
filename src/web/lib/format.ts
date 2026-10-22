/** Compact age for list rows: "now", "4m", "2h", "1d". */
export function age(iso: string, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
	if (seconds < 60) return 'now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Elapsed duration for live work: "12s", "4m 12s", "1h 3m". */
export function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Wall-clock time for message meta: "14:02". */
export function clock(iso: string): string {
	return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Token counts at a glance: "840", "12.3K", "2K", "1.2M", "100M"; a round count drops its ".0". */
export function tokens(count: number): string {
	if (count < 1000) return String(count);
	const short = count < 1_000_000 ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}K` : `${(count / 1_000_000).toFixed(1)}M`;
	return short.replace(/\.0(?=[KM]$)/, '');
}

/** "in 52m", "in 3h", "in 9d": how long until a time that is still ahead. */
export function until(iso: string, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

/** US dollars, with enough digits that small model costs do not read as zero. */
export function dollars(amount: number): string {
	if (amount === 0) return '$0';
	if (amount < 0.001) return '<$0.001';
	return `$${amount.toFixed(amount < 1 ? 3 : 2)}`;
}

/** Fractions of a cent, as the decision model costs: "$0.0009". */
export function fineDollars(amount: number): string {
	if (amount === 0) return '$0';
	if (amount < 0.0001) return '<$0.0001';
	return amount < 0.01 ? `$${amount.toFixed(4)}` : dollars(amount);
}

/** A file's size in the unit that reads best. */
export function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
