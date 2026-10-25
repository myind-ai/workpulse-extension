// Meetings that happen at the same time every week: a standup, a sprint review,
// a one-to-one. They are not tasks — you cannot finish one early — so they live
// apart from the task list and only ever produce a nudge before they start.

import { addDays, atIst, istDate, istWeekday } from './time'

/**
 * What kind of meeting it is, which decides what the card arrives with.
 *
 * A scrum wants three points in a fixed order and nothing else. A review wants
 * the week. A one-to-one wants what you have been stuck on. Asking people to
 * remember all of that at 09:45 is the thing this replaces.
 */
export type MeetingKind = 'scrum' | 'review' | 'one-to-one' | 'other'

export interface Meeting {
	id: string
	name: string
	kind?: MeetingKind
	/** "09:45" IST. */
	time: string
	/** 1 = Monday … 7 = Sunday. */
	days: number[]
	/** How long before it starts to say something. */
	leadMinutes: number
	enabled: boolean
	/** The day it was last announced, so it is said once. */
	notifiedOn?: string
	/**
	 * How long it takes, when it should also go on the timesheet. 0 or absent
	 * means it is only ever a nudge. The same half hour every weekday is work
	 * you do, and typing it in afterwards is the part people stop doing.
	 */
	logMinutes?: number
	/** The Zoho job to log it against, and what to call it on the timesheet. */
	jobId?: string
	logText?: string
	/** The day it was last logged — or answered "it did not happen". */
	loggedOn?: string
	/**
	 * Put it on the timesheet without asking.
	 *
	 * A standup that happens every day is not a question worth asking every
	 * day — and a card that asks it daily is the exact friction this app
	 * exists to remove. On by default for anything with a length set, because
	 * setting a length already says "this goes on the timesheet".
	 *
	 * What makes assuming it happened safe is that the assumption is always
	 * reversible: the row is local, visibly marked as added for you, and one
	 * click to remove. The review before pushing is where it gets checked.
	 */
	autoLog?: boolean
	/**
	 * Today it is at a different time. Meetings move: the standup slips to ten
	 * because someone is on a call, the review goes to Thursday. A recurring
	 * rule that cannot be bent for one day is a rule people turn off.
	 */
	movedOn?: { date: string; time: string }
	/** Not happening on this date at all. */
	skippedOn?: string
}

/**
 * What time this meeting is on a given day — its usual time, the time it was
 * moved to, or nothing at all if it was called off for that day.
 */
export function timeOn(m: Meeting, date: string): string | null {
	if (m.skippedOn === date) return null
	return m.movedOn?.date === date ? m.movedOn.time : m.time
}

/** Past this long after the start, a reminder is no longer a reminder. */
const STALE_AFTER = 20 * 60_000

/**
 * The meetings worth announcing right now: on today's list, inside the lead
 * window, not already said today, and not so far past that the nudge would be
 * about something you are already in — opening the laptop at six should not
 * announce the morning standup.
 */
export function dueMeetings(list: Meeting[], now: number): Meeting[] {
	const date = istDate(now)
	const weekday = istWeekday(now)
	return list.filter((m) => {
		if (!m.enabled || m.notifiedOn === date) return false
		// A meeting moved *to* today speaks today, even if today is not one of its
		// usual days — that is what moving it means.
		if (!m.days.includes(weekday) && m.movedOn?.date !== date) return false
		const time = timeOn(m, date)
		if (!time) return false
		const starts = atIst(date, time)
		return now >= starts - Math.max(0, m.leadMinutes) * 60_000 && now < starts + STALE_AFTER
	})
}

/** The slot a meeting would occupy on the given day — zero-length if it is off. */
export function meetingSlot(m: Meeting, date: string): { from: number; to: number } {
	const time = timeOn(m, date)
	if (!time) return { from: 0, to: 0 }
	const from = atIst(date, time)
	return { from, to: from + Math.max(0, m.logMinutes ?? 0) * 60_000 }
}

/**
 * Today's meetings that take time on the timesheet, as instants. The hourly
 * card uses these to leave the meeting alone — both while it runs and
 * afterwards, since the meeting card logs that stretch itself.
 */
export function meetingSlots(list: Meeting[], date: string): { from: number; to: number }[] {
	const weekday = istWeekday(atIst(date, '12:00'))
	return list
		.filter((m) => m.enabled && (m.logMinutes ?? 0) > 0 && (m.days.includes(weekday) || m.movedOn?.date === date) && timeOn(m, date))
		.map((m) => meetingSlot(m, date))
		.filter((s) => s.to > s.from)
}

/**
 * Meetings that have finished today and are owed a line on the timesheet. Asked
 * after the meeting rather than before, because before it you do not yet know
 * whether it happened — which is the only question worth asking.
 *
 * `covered` says the time is already accounted for by something you logged
 * yourself; then there is nothing to ask and nothing to add.
 */
export function dueToLog(list: Meeting[], now: number, covered: (from: number, to: number) => boolean, within = 4 * 60 * 60_000): Meeting[] {
	const date = istDate(now)
	const weekday = istWeekday(now)
	return list.filter((m) => {
		if (!m.enabled || !m.logMinutes || m.loggedOn === date) return false
		if (!m.days.includes(weekday) && m.movedOn?.date !== date) return false
		if (!timeOn(m, date)) return false
		const { from, to } = meetingSlot(m, date)
		// Finished, and — when somebody is being asked — not so long ago that
		// the answer would be a guess. A meeting that writes itself has no such
		// limit: opening the laptop at two should still record the stand-up,
		// and the row is reversible either way.
		if (now < to || now > to + within) return false
		return !covered(from, to)
	})
}

/** Does this one put itself on the timesheet, or ask first? */
export const logsItself = (m: Meeting): boolean => m.autoLog !== false && (m.logMinutes ?? 0) > 0

/** "in 5 minutes" / "now" — how the nudge should read at this moment. */
export function meetingWhen(m: Meeting, now: number): string {
	const date = istDate(now)
	const mins = Math.round((atIst(date, timeOn(m, date) ?? m.time) - now) / 60_000)
	if (mins > 1) return `in ${mins} minutes`
	if (mins === 1) return 'in a minute'
	return mins === 0 ? 'now' : 'started'
}

/**
 * When this meeting will next speak, as an instant — so the list can say it out
 * loud. Looks forward seven days, which is as far as a weekly rule ever needs.
 */
export function nextMeetingAt(m: Meeting, now: number): number | null {
	if (!m.enabled || !m.days.length) return null
	for (let i = 0; i < 8; i++) {
		const date = addDays(istDate(now), i)
		if (!m.days.includes(istWeekday(atIst(date, '12:00'))) && m.movedOn?.date !== date) continue
		const time = timeOn(m, date)
		if (!time) continue
		const speaks = atIst(date, time) - Math.max(0, m.leadMinutes) * 60_000
		// Today's may already have gone; the stale window is what decides.
		if (speaks + STALE_AFTER > now && !(i === 0 && m.notifiedOn === date)) return speaks
	}
	return null
}
