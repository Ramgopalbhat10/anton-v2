import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import type { DailyPictureInfo } from '../core/ports.ts';
import { logProblem } from './log.ts';
import { getProviders } from '../providers/index.ts';

/*
 * The picture of the day behind the app (Settings › General, or the sky's
 * menu on Home). Read once a day from NASA and kept, with its image, in
 * memory and in `data/sky/`, so every page and every restart that day shows
 * the same picture without asking NASA again. A failed read is tried again
 * after a while, never on every page load.
 */

export type DailySky = DailyPictureInfo & { image: string };

type Kept = { info: DailyPictureInfo; bytes: Uint8Array; type: string };

const RETRY_MS = 20 * 60_000;
/** The feed changes over around midnight in the US; look again a few hours after a picture was read. */
const RECHECK_MS = 3 * 3_600_000;

let kept: (Kept & { checkedAt: number }) | null = null;
let failedAt = 0;
let reading: Promise<Kept | null> | null = null;

const dir = () => path.join(config.dataDir, 'sky');

function view(info: DailyPictureInfo): DailySky {
	return { ...info, image: `/api/sky/today/image?d=${info.date}` };
}

async function fromDisk(): Promise<Kept | null> {
	try {
		const info = JSON.parse(await readFile(path.join(dir(), 'today.json'), 'utf8')) as DailyPictureInfo & { type: string };
		const bytes = new Uint8Array(await readFile(path.join(dir(), `${info.date}.img`)));
		return { info, bytes, type: info.type };
	} catch {
		return null;
	}
}

async function toDisk(next: Kept) {
	try {
		await mkdir(dir(), { recursive: true });
		await writeFile(path.join(dir(), `${next.info.date}.img`), next.bytes);
		await writeFile(path.join(dir(), 'today.json'), JSON.stringify({ ...next.info, type: next.type }));
		// Only the day's picture is kept; the ones before it go.
		for (const name of await readdir(dir())) if (name.endsWith('.img') && name !== `${next.info.date}.img`) await rm(path.join(dir(), name), { force: true });
	} catch (error) {
		logProblem('warn', 'Could not keep the picture of the day on disk', error);
	}
}

async function read(): Promise<Kept | null> {
	const source = getProviders().daily;
	if (!source) return null;
	const info = await source.today();
	if (!info) return null;
	if (kept && kept.info.date === info.date) return kept;
	const { bytes, type } = await source.image(info.imageUrl);
	const next = { info, bytes, type };
	await toDisk(next);
	return next;
}

/** Today's picture, read from NASA at most once a day; null while none can be had (the sky then keeps its hourly pictures). */
export async function dailySky(now = Date.now()): Promise<DailySky | null> {
	if (!kept) {
		const saved = await fromDisk();
		// What was kept on disk counts as checked when it was written: only a stale day is read again.
		if (saved) kept = { ...saved, checkedAt: saved.info.date === new Date(now).toISOString().slice(0, 10) ? now : 0 };
	}
	const fresh = kept && now - kept.checkedAt < RECHECK_MS;
	if (fresh || now - failedAt < RETRY_MS) return kept ? view(kept.info) : null;
	reading ??= read()
		.then((next) => {
			if (next) kept = { ...next, checkedAt: now };
			else failedAt = now;
			return next;
		})
		.catch((error) => {
			failedAt = now;
			logProblem('warn', 'Could not read NASA’s picture of the day', error);
			return null;
		})
		.finally(() => {
			reading = null;
		});
	await reading;
	return kept ? view(kept.info) : null;
}

/** The image of the picture `dailySky` last gave, for the page to draw. */
export async function dailySkyImage(): Promise<{ bytes: Uint8Array; type: string } | null> {
	if (!kept) await dailySky();
	return kept ? { bytes: kept.bytes, type: kept.type } : null;
}

/** For tests: forget what was read. */
export function forgetDailySky() {
	kept = null;
	failedAt = 0;
	reading = null;
}
