// The hours you actually worked, against the hours you are meant to.
//
// Nobody counts this for you. The timesheet records what the company needs for
// billing; the attendance page records punches. Neither ever says "that was a
// forty-seven hour week". This is the number an employee actually cares about,
// it is a fact with a date on it, and it lives on your own machine.
//
// It is counted, never estimated, and it is deliberately not a league table:
// there is no comparison with anyone else, nothing is shared with a team by
// default, and it does not congratulate you for a long week.

import { fmtMinutes } from './time'

export interface WorkedDay {
	date: string
	/** Minutes between check-in and check-out, when both are known. */
	clockMinutes: number
	/** Minutes written down against work. */
	loggedMinutes: number
	/** The hours this day was meant to be — 0 on a holiday, half on a half day. */
	expectedMinutes: number
	/** A day that was not a working day at all. */
	off?: boolean
}

export interface Overtime {
	from: string
	to: string
	/** The better of clock and logged, per day, added up. */
	minutes: number
	expected: number
	/** Minutes over, which is the number people mean. Never below zero. */
	over: number
	/** Minutes short, for the same reason — both are facts. */
	short: number
	days: number
	/** Days longer than the day was meant to be. */
	longDays: number
	/** Days worked that were not working days at all. */
	offDaysWorked: { date: string; minutes: number }[]
	/** The longest single day in the period. */
	longest?: { date: string; minutes: number }
}

/**
 * What the period came to.
 *
 * The clock wins over what was logged, because the time you were there is the
 * time you were there — a day you forgot to write down is not a day you did not
 * work. Where there is no clock, what you logged stands in.
 */
export function overtime(days: WorkedDay[], from: string, to: string): Overtime {
	const inRange = days.filter((d) => d.date >= from && d.date <= to)
	let minutes = 0
	let expected = 0
	let longDays = 0
	let longest: { date: string; minutes: number } | undefined
	const offDaysWorked: { date: string; minutes: number }[] = []

	for (const d of inRange) {
		const worked = Math.max(d.clockMinutes, d.loggedMinutes)
		if (worked <= 0) continue
		minutes += worked
		expected += d.expectedMinutes
		if (d.off || d.expectedMinutes === 0) offDaysWorked.push({ date: d.date, minutes: worked })
		else if (worked > d.expectedMinutes) longDays += 1
		if (!longest || worked > longest.minutes) longest = { date: d.date, minutes: worked }
	}

	const diff = minutes - expected
	return {
		from,
		to,
		minutes,
		expected,
		over: Math.max(0, diff),
		short: Math.max(0, -diff),
		days: inRange.filter((d) => Math.max(d.clockMinutes, d.loggedMinutes) > 0).length,
		longDays,
		offDaysWorked,
		longest,
	}
}

/**
 * One sentence, and only when there is something to say.
 *
 * A week that came out even gets nothing: an app that comments on every normal
 * week is an app you stop reading.
 */
export function overtimeLine(o: Overtime): string | null {
	if (!o.days) return null
	if (o.offDaysWorked.length) {
		const day = o.offDaysWorked.length === 1 ? 'a day off' : `${o.offDaysWorked.length} days off`
		return `${fmtMinutes(o.minutes)} over ${o.days} days — including ${day}. That is ${fmtMinutes(o.over)} more than the ${fmtMinutes(o.expected)} these days were meant to be.`
	}
	if (o.over >= 60) return `${fmtMinutes(o.minutes)} over ${o.days} days: ${fmtMinutes(o.over)} more than the ${fmtMinutes(o.expected)} they were meant to be${o.longDays ? `, across ${o.longDays} long day${o.longDays === 1 ? '' : 's'}` : ''}.`
	if (o.short >= 120) return `${fmtMinutes(o.minutes)} over ${o.days} days — ${fmtMinutes(o.short)} short of ${fmtMinutes(o.expected)}.`
	return null
}
