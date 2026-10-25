// Where the week went, and the five minutes on Friday that make it worth
// knowing.
//
// "Where did the week go?" is asked rhetorically, because nobody can answer it.
// You suspect meetings ate it. You cannot prove it. WorkPulse has the meetings
// and the logged work in the same minutes, which nothing else does — a calendar
// knows the meetings and not the work, a tracker knows the tickets and not the
// hours.
//
// There is no target here, deliberately. Nobody knows what share of a week
// should be meetings, and an app that invents a number and then measures you
// against it is an app making things up. It says what happened. What to do
// about it is yours.

import { fmtMinutes } from './time'

export interface WeekSplit {
	from: string
	to: string
	/** Minutes written down as work, meetings included. */
	logged: number
	meetings: number
	deep: number
	/** Days with anything logged at all. */
	days: number
	/** Times you moved between things, and how many things. */
	switches: number
	things: number
	/** The longest unbroken stretch on one thing. */
	longest: number
}

export interface WeekInput {
	from: string
	to: string
	entries: { date: string; text: string; minutes: number; slotStart: number }[]
	/** Minutes of entries that fell inside a scheduled meeting. */
	meetingMinutes: number
	deepMinutes: number
	switches: { count: number; things: number; longest: number }
}

export function weekSplit(i: WeekInput): WeekSplit {
	const logged = i.entries.reduce((n, e) => n + e.minutes, 0)
	return {
		from: i.from,
		to: i.to,
		logged,
		meetings: Math.min(i.meetingMinutes, logged),
		deep: i.deepMinutes,
		days: new Set(i.entries.filter((e) => e.minutes > 0).map((e) => e.date)).size,
		switches: i.switches.count,
		things: i.switches.things,
		longest: i.switches.longest,
	}
}

/** The share of the week a thing took, as a whole number. */
export const shareOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

/**
 * One line. Only the parts that are actually there — a week with no meetings
 * should not be told it had none.
 */
export function weekLine(w: WeekSplit): string | null {
	if (!w.logged) return null
	const bits = [`${fmtMinutes(w.logged)} over ${w.days} day${w.days === 1 ? '' : 's'}`]
	if (w.meetings) bits.push(`${fmtMinutes(w.meetings)} in meetings (${shareOf(w.meetings, w.logged)}%)`)
	if (w.deep) bits.push(`${fmtMinutes(w.deep)} of deep work`)
	if (w.switches) bits.push(`${w.switches} switches between ${w.things} things`)
	return bits.join(' · ')
}

// ── the five minutes on Friday ──────────────────────────────────────────────

export interface WeekReview {
	from: string
	to: string
	split: WeekSplit
	/** What the week was about, biggest first. */
	worked: { label: string; minutes: number }[]
	finished: string[]
	learned: string[]
	/** Still waiting on somebody else. */
	waiting: string[]
	/** What you said last week would make this one better. */
	lastIntention?: string
}

/**
 * Is it time? The last working hour of the last working day, once.
 *
 * Not Monday morning — a review of a week you cannot remember is a form. Not
 * the weekend — nobody is there. The hour before you stop on the last day you
 * work is the only moment it is both fresh and still possible to act on.
 */
export function reviewDue(s: { now: number; shiftEnd: number; isLastWorkday: boolean; doneThisWeek: boolean; checkedIn: boolean; beforeEnd?: number }): boolean {
	if (!s.isLastWorkday || s.doneThisWeek || !s.checkedIn) return false
	return s.now >= s.shiftEnd - (s.beforeEnd ?? 45) * 60_000
}

/** The text to paste into a weekly update, if somebody asks for one. */
export function reviewText(r: WeekReview): string {
	const out = [`*Week of ${r.from}*`, '']
	if (r.worked.length) {
		out.push('*What it went on*')
		for (const w of r.worked.slice(0, 8)) out.push(`• ${w.label} · ${fmtMinutes(w.minutes)}`)
		out.push('')
	}
	if (r.finished.length) {
		out.push('*Finished*')
		for (const f of r.finished.slice(0, 10)) out.push(`• ${f}`)
		out.push('')
	}
	if (r.waiting.length) {
		out.push('*Waiting on somebody*')
		for (const w of r.waiting) out.push(`• ${w}`)
		out.push('')
	}
	if (r.learned.length) {
		out.push('*Learned*')
		for (const l of r.learned.slice(0, 5)) out.push(`• ${l}`)
	}
	return out.join('\n').trim()
}
