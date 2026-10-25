// The day that shows zero even though you worked it.
//
// Two different failures wear the same face on Zoho's screen. A day with a
// check-in and no check-out reads as an absence; a day with neither reads as an
// absence too — but the second one is the worse of the pair, because nothing
// in the app ever noticed it. The forced card only fires for a day that was
// started, so a day you never punched into at all has, until now, simply gone.
//
// Both are recoverable, and from the same evidence: WorkPulse was running, it
// saw ticks, it holds the entries you wrote. That is a better account of when
// you started and stopped than the memory of somebody filling in a form nine
// days later.
//
// Nothing here guesses silently. Every proposal carries what it was built from
// and whether it had anything real to go on, because a punch somebody submits
// is a claim they are making about themselves.

import { MIN } from './time'

/** What is wrong with the day. */
export type Fault = 'no-checkout' | 'no-checkin' | 'neither'

export interface DayEvidence {
	date: string
	checkedInAt?: number
	checkedOutAt?: number
	isOff?: boolean
	/** The slots you wrote something against, in order. */
	entries: { slotStart: number; slotEnd: number }[]
	/** Stretches the machine was quiet, as [from, to]. */
	away: [number, number][]
	/** The last time the worker ticked on that day, if it did. */
	lastTick?: number
	/** The shift, as instants on that date. */
	shiftStart: number
	shiftEnd: number
}

export interface Proposal {
	at: number
	/** What it was built from, in the second person. */
	why: string
	/** Nothing real to go on — the shift time was used. Say so, always. */
	guessed: boolean
}

export interface Recovery {
	date: string
	fault: Fault
	/** Only for a missing arrival. */
	arrived?: Proposal
	/** Only for a missing departure. */
	left?: Proposal
	/** What Zoho shows now, in minutes. Nearly always zero — that is the point. */
	beforeMinutes: number
	/** What it would show once this is applied. */
	afterMinutes: number
	/** Days until the day is sealed. Zero means today is the last day. */
	sealsIn: number
}

/**
 * Zoho locks a day a week after it. Not our deadline — theirs — which is the
 * only reason it is allowed to create any urgency at all.
 */
export const SEAL_DAYS = 7

export function sealsIn(date: string, now: number, windowDays = SEAL_DAYS): number {
	const day = Date.parse(`${date}T00:00:00+05:30`)
	if (Number.isNaN(day)) return windowDays
	const elapsed = Math.floor((now - day) / (24 * 60 * MIN))
	return Math.max(0, windowDays - elapsed)
}

/** A day already sealed cannot be offered as a one-click fix. It needs a form. */
export const sealed = (date: string, now: number): boolean => sealsIn(date, now) <= 0

/**
 * When you actually started.
 *
 * The mirror of `leftAt` in closeout.ts, and deliberately the same shape: the
 * first thing you wrote down beats the first tick, because an entry is
 * something you asserted and a tick is only something observed.
 */
export function arrivedAt(d: DayEvidence): Proposal {
	const first = d.entries[0]?.slotStart
	if (first != null && first < d.shiftEnd) return { at: first, why: 'the start of your first entry', guessed: false }
	// A tick before the shift started still counts: people start early, and the
	// app was running to see it.
	if (d.lastTick != null && d.entries.length === 0 && d.lastTick < d.shiftEnd) {
		return { at: Math.min(d.lastTick, d.shiftStart), why: 'the first thing WorkPulse saw', guessed: false }
	}
	return { at: d.shiftStart, why: 'your usual shift start — nothing else to go on', guessed: true }
}

/**
 * When you stopped, for a day being recovered whole.
 *
 * `closeout.leftAt` answers this for a day that was checked in and is being
 * closed today. This answers it for a day in the past, where "now" is no
 * longer evidence of anything.
 */
export function departedAt(d: DayEvidence): Proposal {
	const lastEntry = d.entries.at(-1)?.slotEnd
	const quiet = [...d.away].sort((a, b) => a[0] - b[0]).at(-1)
	const cap = d.shiftEnd + 4 * 60 * MIN
	if (quiet && quiet[1] - quiet[0] >= 20 * MIN && quiet[0] <= cap && quiet[0] > (lastEntry ?? 0)) {
		return { at: quiet[0], why: 'when the machine went quiet', guessed: false }
	}
	if (lastEntry != null && lastEntry <= cap) return { at: lastEntry, why: 'the end of your last entry', guessed: false }
	if (d.lastTick != null && d.lastTick <= cap) return { at: d.lastTick, why: 'the last thing WorkPulse saw', guessed: false }
	return { at: d.shiftEnd, why: 'your usual shift end — nothing else to go on', guessed: true }
}

/** Was anything actually done that day? A day nobody worked is not a fault. */
export function worked(d: DayEvidence): boolean {
	return d.entries.length > 0 || d.lastTick != null || d.checkedInAt != null
}

/**
 * What, if anything, this day is owed — or null when it is fine.
 *
 * A day off is never a fault. Nor is a day nobody worked: proposing a punch for
 * a day somebody genuinely did not work is asking them to file a false claim,
 * which is a far worse failure than missing one.
 */
export function recoveryFor(d: DayEvidence, now: number): Recovery | null {
	if (d.isOff) return null
	if (!worked(d)) return null
	const hasIn = d.checkedInAt != null
	const hasOut = d.checkedOutAt != null
	if (hasIn && hasOut) return null

	const fault: Fault = hasIn ? 'no-checkout' : d.entries.length || d.lastTick != null ? (hasOut ? 'no-checkin' : 'neither') : 'neither'
	const arrived = hasIn ? undefined : arrivedAt(d)
	const left = hasOut ? undefined : departedAt(d)
	const start = d.checkedInAt ?? arrived!.at
	const end = d.checkedOutAt ?? left!.at

	return {
		date: d.date,
		fault,
		arrived,
		left,
		// A half-punched day shows nothing on Zoho's own screen: an in with no
		// out is not "some hours", it is an absence.
		beforeMinutes: hasIn && hasOut ? Math.round((d.checkedOutAt! - d.checkedInAt!) / MIN) : 0,
		afterMinutes: Math.max(0, Math.round((end - start) / MIN)),
		sealsIn: sealsIn(d.date, now),
	}
}

/** Everything recoverable, worst deadline first — that is the order to fix in. */
export function recoverable(days: DayEvidence[], now: number): Recovery[] {
	return days
		.map((d) => recoveryFor(d, now))
		.filter((r): r is Recovery => r !== null)
		.sort((a, b) => a.sealsIn - b.sealsIn || a.date.localeCompare(b.date))
}

/**
 * The line the first run leads with.
 *
 * Counts days, not punches: "2 missing punches" when it is one day missing
 * both ends is a lie somebody will catch, and the first sentence the app says
 * has to be true.
 */
export function headline(list: Recovery[]): string {
	if (!list.length) return 'No missing punches. Your week is intact.'
	const hours = Math.round(list.reduce((a, r) => a + (r.afterMinutes - r.beforeMinutes), 0) / 60)
	const days = `${list.length} day${list.length === 1 ? '' : 's'}`
	const urgent = list.filter((r) => r.sealsIn <= 2).length
	const soon = urgent ? ` ${urgent} seal${urgent === 1 ? 's' : ''} within two days.` : ''
	return `${days} showing as absent, worth about ${hours} hour${hours === 1 ? '' : 's'}.${soon}`
}

/** "0 hours → 7.5 hours" — the payoff, shown rather than described. */
export function beforeAfter(r: Recovery): string {
	const h = (m: number) => (m % 60 === 0 ? `${m / 60}` : (m / 60).toFixed(1))
	return `${h(r.beforeMinutes)} hours → ${h(r.afterMinutes)} hours`
}
