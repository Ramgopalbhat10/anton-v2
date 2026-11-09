import { useEffect, useState } from 'react';

/**
 * The sky behind Anton: 24 public-domain pictures from NASA's Image and Video
 * Library, one an hour. Each is a 320×200 crop in `public/sky/`, small enough to
 * ship with the app; the page draws it as a pixel mesh (`components/sky.tsx`).
 * Or, chosen in its menu or Settings › General, NASA's Astronomy Picture of the
 * Day, which the server reads once a day (`/api/sky/today`) and which stays all day.
 */
export type SkyImage = {
	/** File in `public/sky/`, without `.jpg`; `apod-<date>` for a picture of the day. */
	slug: string;
	title: string;
	credit: string;
	/** Its page in NASA's library. */
	nasaId: string;
	/** Where the picture is, when it is not one of the 24 in `public/sky/`. */
	src?: string;
	/** Its page, when it is not in NASA's library. */
	link?: string;
	/** The day it is the picture for (`YYYY-MM-DD`), for a picture of the day. */
	day?: string;
};

export const SKY: SkyImage[] = [
	{ slug: 'cosmic-cliffs', title: 'Cosmic Cliffs, Carina Nebula', credit: 'NASA, ESA, CSA, STScI', nasaId: 'carina_nebula' },
	{ slug: 'orbital-sunrise', title: 'Orbital sunrise over the terminator', credit: 'NASA', nasaId: 'iss071e439624' },
	{ slug: 'mystic-mountain', title: 'Mystic Mountain, Carina Nebula', credit: 'NASA, ESA', nasaId: 'GSFC_20171208_Archive_e002064' },
	{ slug: 'aurora-borealis', title: 'Aurora borealis over Canada', credit: 'NASA', nasaId: 'iss072e159172' },
	{ slug: 'saturn-eclipse', title: 'Saturn in eclipse, from Cassini', credit: 'NASA/JPL-Caltech/SSI', nasaId: 'PIA17172' },
	{ slug: 'extreme-deep-field', title: 'Hubble eXtreme Deep Field', credit: 'NASA, ESA', nasaId: 'GSFC_20171208_Archive_e001651' },
	{ slug: 'earthrise', title: 'Earthrise, Apollo 8', credit: 'NASA', nasaId: 'as08-14-2383' },
	{ slug: 'southern-ring', title: 'Southern Ring Nebula, from Webb', credit: 'NASA, ESA, CSA, STScI', nasaId: 'southern_ring_nebula' },
	{ slug: 'sunrise-namibia', title: 'Sunrise above Namibia', credit: 'NASA', nasaId: 'iss072e487315' },
	{ slug: 'solar-bursts', title: 'Bursts of solar material', credit: 'NASA/SDO', nasaId: 'GSFC_20171208_Archive_e000264' },
	{ slug: 'helix-nebula', title: 'Helix Nebula in ultraviolet', credit: 'NASA/JPL-Caltech', nasaId: 'PIA15658' },
	{ slug: 'milky-way-rise', title: 'The Milky Way above Earth’s glow', credit: 'NASA', nasaId: 'iss074e0521637' },
	{ slug: 'crab-nebula', title: 'Heart of the Crab Nebula', credit: 'NASA, ESA', nasaId: 'GSFC_20171208_Archive_e000273' },
	{ slug: 'earthset', title: 'Earthset from Orion, Artemis II', credit: 'NASA', nasaId: 'art002e021278' },
	{ slug: 'neptune-triton', title: 'Crescents of Neptune and Triton', credit: 'NASA/JPL', nasaId: 'PIA02215' },
	{ slug: 'station-sunrise', title: 'Sunrise from the space station', credit: 'NASA', nasaId: 'iss043e193779' },
	{ slug: 'lagoon-nebula', title: 'Heart of the Lagoon Nebula', credit: 'NASA, ESA', nasaId: 'GSFC_20171208_Archive_e001955' },
	{ slug: 'blue-marble', title: 'Blue Marble, eastern hemisphere', credit: 'NASA', nasaId: 'GSFC_20171208_Archive_e001788' },
	{ slug: 'magellanic-clouds', title: 'The Magellanic Clouds from orbit', credit: 'NASA', nasaId: 'iss071e418742' },
	{ slug: 'sdo-eclipse', title: 'Earth crossing the Sun, from SDO', credit: 'NASA/GSFC/SDO', nasaId: 'PIA22259' },
	{ slug: 'andromeda', title: 'Andromeda galaxy, from Hubble', credit: 'NASA, ESA', nasaId: 'GSFC_20171208_Archive_e000833' },
	{ slug: 'station-sunset', title: 'The station orbits into sunset', credit: 'NASA', nasaId: 'iss074e0089785' },
	{ slug: 'comet-neowise', title: 'Comet NEOWISE under the station', credit: 'NASA/Bill Ingalls', nasaId: 'NHQ202007180001' },
	{ slug: 'apollo-17-earth', title: 'The Blue Marble, Apollo 17', credit: 'NASA', nasaId: 'as17-148-22727' },
];

const HOUR = 3_600_000;

/** A shuffle of the 24 pictures that is the same all day and different the next, so a given hour shows a new one each day. */
function dayOrder(day: number): number[] {
	const order = SKY.map((_, index) => index);
	let seed = (day * 2654435761) >>> 0;
	for (let index = order.length - 1; index > 0; index--) {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		const pick = seed % (index + 1);
		[order[index], order[pick]] = [order[pick], order[index]];
	}
	return order;
}

/** The picture for the local hour of `at`. */
export function skyAt(at: Date): SkyImage {
	const day = Math.floor((at.getTime() - at.getTimezoneOffset() * 60_000) / (24 * HOUR));
	return SKY[dayOrder(day)[at.getHours() % SKY.length]];
}

export function skySource(image: SkyImage): string {
	return image.src ?? `/sky/${image.slug}.jpg`;
}

export function skyLink(image: SkyImage): string {
	return image.link ?? `https://images.nasa.gov/details/${encodeURIComponent(image.nasaId)}`;
}

/** Milliseconds until the next local midnight, when a picture of the day gives way to the next. */
export function untilTomorrow(at: Date): number {
	const next = new Date(at);
	next.setHours(24, 0, 0, 0);
	return next.getTime() - at.getTime();
}

/*
 * Which pictures the sky shows: `hourly`, a new one of the 24 each hour, or
 * `daily`, NASA's picture of the day, the same all day. Kept in this browser.
 */
export type SkyMode = 'hourly' | 'daily';

const MODE_KEY = 'anton.sky.mode';

export function readSkyMode(): SkyMode {
	try {
		return localStorage.getItem(MODE_KEY) === 'daily' ? 'daily' : 'hourly';
	} catch {
		return 'hourly';
	}
}

let mode: SkyMode | null = null;
const modeListeners = new Set<() => void>();

export function setSkyMode(next: SkyMode) {
	mode = next;
	try {
		localStorage.setItem(MODE_KEY, next);
		// A random pick belongs to the hourly pictures; choosing a mode shows that mode's picture.
		localStorage.removeItem(PICK_KEY);
	} catch {
		// Storage is a convenience; the choice still holds for this page.
	}
	held = null;
	for (const listener of modeListeners) listener();
	if (next === 'daily') void loadDaily();
}

export function useSkyMode(): SkyMode {
	const [value, setValue] = useState(() => mode ?? readSkyMode());
	useEffect(() => {
		const update = () => setValue(mode ?? readSkyMode());
		modeListeners.add(update);
		return () => void modeListeners.delete(update);
	}, []);
	return value;
}

type DailyAnswer = { date: string; title: string; credit: string; link: string; image: string };

/** The picture of the day as the server last gave it, for the local day it was asked on. */
let daily: { asked: string; image: SkyImage | null } | null = null;
let loading: Promise<void> | null = null;

const localDate = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

/** Asks the server for today's picture once a local day; until it answers, or when there is none, the hourly picture shows. */
export function loadDaily(now = new Date()): Promise<void> {
	const asked = localDate(now);
	if (daily?.asked === asked) return Promise.resolve();
	loading ??= fetch('/api/sky/today')
		.then((response) => (response.ok ? (response.json() as Promise<{ picture: DailyAnswer | null }>) : { picture: null }))
		.then(({ picture }) => {
			daily = {
				asked,
				image: picture
					? { slug: `apod-${picture.date}`, title: picture.title, credit: picture.credit, nasaId: '', src: picture.image, link: picture.link, day: picture.date }
					: null,
			};
		})
		.catch(() => {
			daily = { asked, image: null };
		})
		.finally(() => {
			loading = null;
			for (const listener of pickListeners) listener();
		});
	return loading;
}

/** For tests: forget the picture of the day and the chosen mode. */
export function resetSky() {
	daily = null;
	loading = null;
	mode = null;
	held = null;
}

/** Milliseconds until the next local hour. */
export function untilNextHour(at: Date): number {
	const next = new Date(at);
	next.setHours(at.getHours() + 1, 0, 0, 0);
	return next.getTime() - at.getTime();
}

/** A picture asked for by name in the address (`?sky=earthrise`), to look at one on purpose. */
function pinned(): SkyImage | undefined {
	try {
		const slug = new URLSearchParams(window.location.search).get('sky');
		return slug ? SKY.find((image) => image.slug === slug) : undefined;
	} catch {
		return undefined;
	}
}

const PICK_KEY = 'anton.sky.pick';

/**
 * A picture chosen with "Show a random picture", held until the top of the
 * hour it was chosen in; then the hourly order takes over again. Kept in this
 * browser so a reload keeps it.
 */
type Pick = { slug: string; until: number };

function readPick(now: number): SkyImage | undefined {
	try {
		const pick = JSON.parse(localStorage.getItem(PICK_KEY) ?? 'null') as Pick | null;
		return pick && pick.until > now ? SKY.find((image) => image.slug === pick.slug) : undefined;
	} catch {
		return undefined;
	}
}

let held: Pick | null = null;
const pickListeners = new Set<() => void>();

/** The picture to show at `now`: one asked for in the address, one picked at random this hour, the picture of the day when chosen, or the hour's own. */
function current(now: Date): SkyImage {
	const time = now.getTime();
	const fromMemory = held && held.until > time ? SKY.find((image) => image.slug === held?.slug) : undefined;
	const ofTheDay = (mode ?? readSkyMode()) === 'daily' && daily?.asked === localDate(now) ? daily.image : null;
	return pinned() ?? fromMemory ?? readPick(time) ?? ofTheDay ?? skyAt(now);
}

/** A different one of the pictures, at random, and that `random` picks it (for tests). */
export function randomSky(than: SkyImage, random: () => number = Math.random): SkyImage {
	const others = SKY.filter((image) => image.slug !== than.slug);
	return others[Math.floor(random() * others.length)] ?? than;
}

/** Swaps the sky for another picture at random, until the top of the hour. */
export function shuffleSky() {
	const now = new Date();
	const next = randomSky(current(now));
	held = { slug: next.slug, until: now.getTime() + untilNextHour(now) };
	try {
		localStorage.setItem(PICK_KEY, JSON.stringify(held));
	} catch {
		// Storage is a convenience; the pick still holds for this page.
	}
	for (const listener of pickListeners) listener();
}

/** This hour's picture (or one picked at random, or the picture of the day), moving on by itself at the top of each hour. */
export function useSky(): SkyImage {
	const [image, setImage] = useState(() => current(new Date()));
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout>;
		const update = () => {
			const now = new Date();
			// A new local day asks for the new picture of the day; the hourly one shows until it comes.
			if ((mode ?? readSkyMode()) === 'daily') void loadDaily(now);
			setImage(current(now));
		};
		const schedule = () => {
			timer = setTimeout(() => {
				update();
				schedule();
			}, untilNextHour(new Date()) + 500);
		};
		schedule();
		update();
		pickListeners.add(update);
		modeListeners.add(update);
		return () => {
			clearTimeout(timer);
			pickListeners.delete(update);
			modeListeners.delete(update);
		};
	}, []);
	// The same picture keeps the same object, so the sky does not redraw it.
	return image;
}

const KEY = 'anton.sky';

/** Whether the sky is on: a choice kept in this browser, on unless turned off. */
export function readSkyOn(): boolean {
	try {
		return localStorage.getItem(KEY) !== 'off';
	} catch {
		return true;
	}
}

const listeners = new Set<(on: boolean) => void>();

export function setSkyOn(on: boolean) {
	try {
		localStorage.setItem(KEY, on ? 'on' : 'off');
	} catch {
		// Storage is a convenience; the choice still holds for this page.
	}
	for (const listener of listeners) listener(on);
}

export function useSkyOn(): boolean {
	const [on, setOn] = useState(readSkyOn);
	useEffect(() => {
		listeners.add(setOn);
		return () => void listeners.delete(setOn);
	}, []);
	return on;
}

/*
 * How bright the sky looks, 0 to 100, kept in this browser. The default (60)
 * is the picture as drawn; below it the sky fades toward the canvas, above it
 * the picture brightens and its colour lifts.
 */
const BRIGHTNESS_KEY = 'anton.sky.brightness';
export const SKY_BRIGHTNESS_DEFAULT = 60;

export function readSkyBrightness(): number {
	try {
		const stored = localStorage.getItem(BRIGHTNESS_KEY);
		const value = stored === null ? Number.NaN : Number(stored);
		return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : SKY_BRIGHTNESS_DEFAULT;
	} catch {
		return SKY_BRIGHTNESS_DEFAULT;
	}
}

let brightness: number | null = null;
const brightnessListeners = new Set<(value: number) => void>();

export function setSkyBrightness(value: number) {
	const next = Math.min(100, Math.max(0, Math.round(value)));
	brightness = next;
	try {
		localStorage.setItem(BRIGHTNESS_KEY, String(next));
	} catch {
		// Storage is a convenience; the choice still holds for this page.
	}
	for (const listener of brightnessListeners) listener(next);
}

export function useSkyBrightness(): number {
	const [value, setValue] = useState(() => brightness ?? readSkyBrightness());
	useEffect(() => {
		brightnessListeners.add(setValue);
		return () => void brightnessListeners.delete(setValue);
	}, []);
	return value;
}

/** What a brightness does to the sky: fade it in up to the default, then brighten and saturate it. */
export function skyLook(value: number): { opacity: number; filter?: string } {
	if (value <= SKY_BRIGHTNESS_DEFAULT) return { opacity: Number((0.1 + 0.9 * (value / SKY_BRIGHTNESS_DEFAULT)).toFixed(3)) };
	const lift = (value - SKY_BRIGHTNESS_DEFAULT) / (100 - SKY_BRIGHTNESS_DEFAULT);
	return { opacity: 1, filter: `brightness(${(1 + 0.5 * lift).toFixed(3)}) saturate(${(1 + 0.25 * lift).toFixed(3)})` };
}
