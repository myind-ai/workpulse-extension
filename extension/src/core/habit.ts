// What makes this a daily thing rather than an app you installed once.
//
// A habit needs three parts: a cue you cannot miss, a routine small enough to
// do without deciding, and a reward you can see. WorkPulse has the cue (the
// card) and the routine (one sentence). What it never had was the reward —
// the day visibly filling up, and the run of days behind it.
//
// Two rules about the run, because a streak is the easiest thing in software
// to make dishonest:
//
//   1. It counts *complete days*, not days you opened the app. You cannot
//      earn one by clicking something, and the thing it measures — a timesheet
//      with no gaps — is the thing you actually want.
//   2. Leave, holidays, weekends and days off never break it. Being away is
//      not a failure, and an app that says it is, is an app you uninstall
//      from a beach.
//
// And the pressure is real pressure or it is none: Zoho locks a day after a
// week. "This one locks on Friday" is a fact with a date on it. Anything else
// would be a progress bar pretending to be a deadline.

import { addDays } from './time'

export interface DayState {
	date: string
	/** Minutes written down as work. */
	loggedMinutes: number
	/** The hours the day was meant to be. 0 on leave, a holiday or a weekend. */
	expectedMinutes: number
	checkedIn: boolean
	/** Leave, holiday, week off, or a day you marked off. */
	off: boolean
}

/** A day counts as complete when it is off, or when the hours are in. */
export function isComplete(d: DayState): boolean {
	if (d.off || d.expectedMinutes === 0) return true
	return d.loggedMinutes >= d.expectedMinutes
}

/** How much of the day is still unaccounted for. Never negative. */
export function gapOf(d: DayState): number {
	if (d.off || d.expectedMinutes === 0) return 0
	return Math.max(0, d.expectedMinutes - d.loggedMinutes)
}

export interface Streak {
	/** Days running, counting back from the most recent finished day. */
	days: number
	/** The best run so far, so a broken one is not the whole story. */
	best: number
	/** Today is not finished yet; this is what it would become. */
	atRisk: boolean
	/** The days that are actually holding it up, for "11 days, since 2 Oct". */
	since?: string
}

/**
 * The run of complete days.
 *
 * Today is deliberately not counted until it is complete — a streak that
 * includes a day with four hours missing is a streak that is lying, and the
 * only person it lies to is the one who has to fix those four hours.
 */
export function streakOf(days: DayState[], today: string): Streak {
	const past = days.filter((d) => d.date < today).sort((a, b) => b.date.localeCompare(a.date))
	let run = 0
	let since: string | undefined
	for (const d of past) {
		// A day that was never a working day is neither a win nor a break: step
		// over it and keep counting.
		if (d.off || d.expectedMinutes === 0) continue
		if (!isComplete(d)) break
		run += 1
		since = d.date
	}

	// The best run, over everything given.
	let best = 0
	let cur = 0
	for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
		if (d.off || d.expectedMinutes === 0) continue
		if (isComplete(d)) best = Math.max(best, (cur += 1))
		else cur = 0
	}

	const now = days.find((d) => d.date === today)
	return { days: run, best: Math.max(best, run), atRisk: !!now && !isComplete(now), since }
}

/**
 * When Zoho stops accepting a day.
 *
 * This is the only deadline in the app that is not of its own invention, which
 * is exactly why it is the one worth saying out loud.
 */
export const LOCK_AFTER_DAYS = 7

export function locksOn(date: string): string {
	return addDays(date, LOCK_AFTER_DAYS)
}

const DAY_NAME = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/**
 * "locks on Friday" / "locks tomorrow" / "locked".
 *
 * `weekdayOf` is passed in so this stays pure — the caller knows about zones.
 */
export function lockLine(date: string, today: string, weekdayOf: (d: string) => number): string {
	const lock = locksOn(date)
	const left = daysBetween(today, lock)
	if (left <= 0) return 'Zoho may already have locked this one'
	if (left === 1) return 'locks tomorrow'
	if (left <= 6) return `locks on ${DAY_NAME[weekdayOf(lock) - 1]}`
	return `locks in ${left} days`
}

export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

export interface Owed {
	date: string
	minutes: number
	/** Days until Zoho stops taking it. */
	locksIn: number
}

/**
 * The days with something missing, soonest-to-lock first.
 *
 * Ordering by the deadline rather than by size is the whole point: four hours
 * you can still fix next week matter less than one hour that disappears on
 * Friday.
 */
export function owedDays(days: DayState[], today: string): Owed[] {
	return days
		.filter((d) => d.date < today && !isComplete(d) && (d.checkedIn || d.loggedMinutes > 0))
		.map((d) => ({ date: d.date, minutes: gapOf(d), locksIn: daysBetween(today, locksOn(d.date)) }))
		.sort((a, b) => a.locksIn - b.locksIn || b.minutes - a.minutes)
}

/**
 * The one line on the toolbar icon, which is the only part of WorkPulse most
 * people see for most of the day. A number that grows while it is ignored and
 * turns into a tick when it is not.
 */
export function badgeFor(s: {
	pending?: 'prompt' | 'wrapup' | 'checkin' | string | null
	workday: boolean
	checkedIn: boolean
	gapMinutes: number
	issues: number
	owed: number
	/** Minutes left in a focus block, when one is running. */
	focusLeft?: number
}): { text: string; colour: string } {
	const INDIGO = '#4F46E5'
	const AMBER = '#D97706'
	const RED = '#DC2626'
	// A block in progress owns the badge: it is the one number you are allowed
	// to want to glance at, and everything else can wait until it ends.
	if (s.focusLeft != null && s.focusLeft > 0) return { text: String(s.focusLeft), colour: '#7C3AED' }
	if (s.pending === 'prompt') return { text: 'LOG', colour: INDIGO }
	if (s.pending === 'wrapup') return { text: 'END', colour: INDIGO }
	if (!s.workday) return { text: '', colour: INDIGO }
	if (!s.checkedIn) return { text: 'IN', colour: AMBER }
	// Days that will lock come before today's gap: they are the ones with a
	// deadline on them.
	if (s.owed) return { text: String(s.owed), colour: RED }
	if (s.issues) return { text: String(s.issues), colour: RED }
	if (s.gapMinutes >= 30) return { text: hoursShort(s.gapMinutes), colour: AMBER }
	return { text: '✓', colour: '#15803D' }
}

/** "2.5" / "45m" — short enough for a 16px badge. */
export function hoursShort(minutes: number): string {
	if (minutes < 60) return `${minutes}m`
	const h = minutes / 60
	return h >= 10 ? String(Math.round(h)) : h % 1 === 0 ? String(h) : h.toFixed(1)
}

/** The days a streak is built from, for a week-at-a-glance strip. */
export function lastDays(days: DayState[], today: string, count = 14): DayState[] {
	const out: DayState[] = []
	for (let i = count - 1; i >= 0; i--) {
		const date = addDays(today, -i)
		out.push(days.find((d) => d.date === date) ?? { date, loggedMinutes: 0, expectedMinutes: 0, checkedIn: false, off: true })
	}
	return out
}

