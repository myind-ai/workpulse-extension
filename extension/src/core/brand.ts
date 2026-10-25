// The quiet end of asking: a heart that changes colour, and one line that says
// something different each time you look.
//
// The reason is habituation, not decoration. A line that never changes stops
// being read after a week — the eye files it with the furniture. Rotating it is
// the honest way to keep it legible; animating it, or putting it in front of
// work, is the dishonest one, so neither happens here.

import { HOUR, IST_OFFSET } from './time'

/** Hue by the hour, around the wheel, skipping the muddy greens. */
const HEART = ['#e11d48', '#db2777', '#c026d3', '#7c3aed', '#4f46e5', '#2563eb', '#0891b2', '#059669', '#ca8a04', '#ea580c']

/**
 * The heart's colour right now. It changes on the hour and is the same for
 * everyone who looks at the same hour, which makes it a clock rather than a
 * random flash — and means a screenshot can be reproduced.
 */
export function heartColour(now: number, seed = 0, palette = HEART): string {
	return palette[wrap(istHour(now) + Math.floor(seed), palette.length)]
}

/**
 * A number that is the same for everything drawn in one page load and different
 * the next time. The heart changes on the hour and on every reload, so it is
 * never the same twice in a row for long — and because it is fixed for the life
 * of the page, nothing on screen flickers between colours while you look at it.
 */
export const paintSeed = () => Math.floor(Math.random() * 1000)

/** The hour of the day where the rest of the app lives, not where UTC does. */
const istHour = (now: number) => Math.floor((now + IST_OFFSET) / HOUR)
const wrap = (n: number, len: number) => ((n % len) + len) % len

export interface Pitch {
	/** The line itself. */
	text: string
	/** What the button says. */
	cta: string
	/** Where it goes. */
	href: string
	kind: 'star' | 'sponsor' | 'source' | 'author'
}

/**
 * One line, rotating by the hour. Four of them, so a day of opening the widget
 * does not show the same sentence twice in a row, and none of them is a plea.
 */
export function pitch(now: number, urls: { source: string; sponsor: string; author: string; name: string }, seed = 0): Pitch {
	const all: Pitch[] = [
		{ kind: 'star', text: 'WorkPulse is free and open source.', cta: 'Star it', href: urls.source },
		{ kind: 'sponsor', text: 'No server, no account, no telemetry.', cta: 'Sponsor', href: urls.sponsor },
		{ kind: 'source', text: 'Found a bug, or want something changed?', cta: 'Open an issue', href: `${urls.source}/issues/new` },
		{ kind: 'author', text: `Made by ${urls.name}.`, cta: 'Say hello', href: urls.author },
	]
	return all[wrap(istHour(now) + Math.floor(seed), all.length)]
}
