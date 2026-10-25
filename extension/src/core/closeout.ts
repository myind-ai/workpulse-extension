// The day that was never closed.
//
// You shut the laptop at seven and went home. Nothing punched you out, because
// nothing was running to do it. Zoho now has a check-in with no check-out,
// which it will treat as an absence or a zero-hour day — and the first you hear
// of it is a regularisation request two weeks later, by which time you are
// guessing what time you left.
//
// WorkPulse was there. It knows when the machine went quiet, when the last tick
// ran, and when you last wrote something down. That is enough to say "you
// stopped at 19:42" instead of asking you to remember.

import { MIN } from './time'

export interface CloseoutInput {
	/** When the day was checked in. */
	checkedInAt: number
	/** Stretches the machine or the person was away: [from, to]. */
	away: [number, number][]
	/** The end of the last thing written down that day. */
	lastEntryEnd?: number
	/** The last time the extension ran at all. */
	lastTick?: number
	/** The end of the shift, which caps a guess that ran away with itself. */
	shiftEnd: number
	/** Now, for a day being closed late. */
	now: number
}

export interface Leaving {
	/** The best guess at when you actually stopped. */
	at: number
	/** Why that number, in words, because a guess has to show its working. */
	why: string
	/** True when there is really nothing to go on and the shift end is standing in. */
	guessed: boolean
}

/**
 * When you stopped.
 *
 * In order of how much it is worth: the moment the machine went quiet for the
 * last time (you shut the lid), then the last tick the extension managed, then
 * the end of the last thing you wrote down. Each is capped at the shift end
 * plus a little, because a laptop left open until two in the morning is not a
 * nine-hour overtime claim.
 */
export function leftAt(i: CloseoutInput): Leaving {
	const cap = Math.min(i.now, i.shiftEnd + 4 * 60 * MIN)
	const within = (t: number) => t > i.checkedInAt && t <= cap

	// The last stretch of being away that is still going — the lid closing.
	const last = [...i.away].sort((a, b) => a[0] - b[0]).at(-1)
	if (last && within(last[0]) && last[1] - last[0] >= 20 * MIN) {
		return { at: last[0], why: 'when the machine went quiet', guessed: false }
	}
	if (i.lastTick != null && within(i.lastTick) && i.now - i.lastTick >= 20 * MIN) {
		return { at: i.lastTick, why: 'the last thing WorkPulse saw', guessed: false }
	}
	if (i.lastEntryEnd != null && within(i.lastEntryEnd)) {
		return { at: i.lastEntryEnd, why: 'the end of your last entry', guessed: false }
	}
	return { at: Math.min(i.shiftEnd, cap), why: 'your shift end — nothing else to go on', guessed: true }
}

/**
 * Is this day owed a check-out?
 *
 * A day off, a day never started, and a day already closed are all fine. What
 * is not fine is a check-in with nothing after it.
 */
export function needsClosing(d: { checkedInAt?: number; checkedOutAt?: number; isOff?: boolean }): boolean {
	return !d.isOff && d.checkedInAt != null && d.checkedOutAt == null
}

/**
 * The last call, before the day becomes a regularisation.
 *
 * Measured from the end of the shift rather than the clock, so a night shift
 * gets the same three hours as a day one. It rings, because the whole point is
 * that you have stopped paying attention to the screen.
 */
export const LAST_CALL_AFTER = 3 * 60 * MIN

export function lastCallDue(s: { now: number; shiftEnd: number; checkedIn: boolean; checkedOut: boolean; told: boolean; isOff: boolean }): boolean {
	if (s.isOff || !s.checkedIn || s.checkedOut || s.told) return false
	return s.now >= s.shiftEnd + LAST_CALL_AFTER
}

/** The sentence a regularisation form wants, with the time filled in. */
export function regularisationNote(date: string, at: string, why: string): string {
	return `Missed the check-out on ${date}. Worked until about ${at} — ${why}. Requesting a regularisation for that time.`
}
