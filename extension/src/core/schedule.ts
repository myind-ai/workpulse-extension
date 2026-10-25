// The scheduler's brain (ported from src-tauri/src/scheduler.rs). Pure: turns a
// snapshot into this tick's actions. background/engine.ts gathers the snapshot
// and carries the actions out.

import { lastCallDue } from './closeout'
import { isWorkDay } from './rules'
import { atIst, HOUR, MIN } from './time'
import type { Day, DayFlags, Pending, Settings } from './types'

export interface Snapshot {
	now: number
	today: string
	settings: Settings
	day: Day
	/** Where the next hourly slot starts (later of check-in and the last saved slot). */
	slotStart: number | null
	/** Minutes already written down today. */
	loggedMinutes: number
	idleSecs: number
	flags: DayFlags
	pending: Pending | null
	snoozeUntil?: number
	/** While a focus session runs, the hourly card waits for it. */
	focusUntil?: number
	/** Last break, or check-in if there has been none — for the stretch nudge. */
	lastBreakAt?: number
	/**
	 * Today's scheduled meetings, as instants. Time you already described once in
	 * settings is not time to ask about: without this, the hourly card interrupts
	 * your stand-up to ask what you are working on.
	 */
	meetings?: Slot[]
	hasZoho: boolean
	/** Zoho refused the API for this role: the page path is used instead. */
	roleBlocked?: boolean
	awaitingZoho: boolean
	lastSync?: number
	pendingDays: number
}

export type Action =
	| { type: 'sync' }
	| { type: 'checkin'; blocking: boolean }
	| { type: 'notify'; kind: 'checkin' | 'wrapup' | 'hoursdone' | 'break'; title: string; body: string }
	| { type: 'prompt' }
	| { type: 'wrapup' }
	| { type: 'scan' }
	| { type: 'catchup' }
	/** Still checked in, hours after the shift ended. Rings. */
	| { type: 'lastcall' }

/**
 * A ceiling on the cards nobody asked for.
 *
 * Eye breaks, water, a meeting nudge, a learning to write down: each is small,
 * and all of them together are the reason people turn an extension off. So the
 * gentle ones queue behind a few minutes of quiet and a cap for the hour, and
 * wait rather than stack. The ones you must answer — check in, log the hour,
 * close the day — are not in here: those are the job.
 */
export function mayInterrupt(
	s: { now: number; at?: number; hour?: string; count?: number },
	{ everyMinutes = 10, maxPerHour = 4 } = {},
): boolean {
	if (s.at != null && s.now - s.at < everyMinutes * MIN) return false
	const thisHour = String(Math.floor(s.now / HOUR))
	return s.hour !== thisHour || (s.count ?? 0) < maxPerHour
}

/** The gentle-card counter after one has gone out. */
export function countInterrupt(s: { now: number; hour?: string; count?: number }): { at: number; hour: string; count: number } {
	const thisHour = String(Math.floor(s.now / HOUR))
	return { at: s.now, hour: thisHour, count: s.hour === thisHour ? (s.count ?? 0) + 1 : 1 }
}

export interface Slot {
	from: number
	to: number
}

/**
 * The stretch the hourly card should ask about — the first gap between what is
 * already written down and now, cut short by any meeting in the way.
 *
 * Asking about the earliest gap rather than the latest matters: a meeting in the
 * middle of an unlogged stretch used to swallow everything before it, because
 * the mark moved to the meeting's end and the half hour in front of it was
 * never mentioned again.
 */
export function askWindow(slotStart: number, now: number, meetings: Slot[] = []): Slot | null {
	const cuts = meetings.filter((m) => m.to > slotStart && m.from < now).sort((a, b) => a.from - b.from)
	let from = slotStart
	for (const m of cuts) {
		if (m.from > from) return { from, to: Math.min(m.from, now) }
		from = Math.max(from, m.to)
	}
	return from < now ? { from, to: now } : null
}

/** Are you in a meeting right now? Then nothing is owed until it ends. */
export const inMeeting = (now: number, meetings: Slot[] = []): boolean => meetings.some((m) => m.from <= now && now < m.to)

export const ACTIVE_SECS = 120
export const IDLE_SKIP_SECS = 600
const FINAL_SLOT_MIN = 10

/** Is a slot long enough to be worth asking about? The end of the day settles for less. */
export function slotDue(now: number, slotStart: number, shiftEnd: number, intervalMinutes: number): boolean {
	return now >= shiftEnd ? shiftEnd - slotStart >= FINAL_SLOT_MIN * MIN : now - slotStart >= intervalMinutes * MIN
}

/**
 * Whether an hourly prompt is still owed *now* — the same question `decide`
 * asks before raising one, so a card cannot outlive its reason. Asked again on
 * every tick and when the prompt window is closed, so a slot logged from the
 * dashboard, or a day since checked out, takes the card away instead of leaving
 * it queued behind a snooze.
 */
export function promptOwed(s: {
	isOff: boolean
	checkedInAt?: number
	checkedOutAt?: number
	slotEnd: number | null
	now: number
	shiftEnd: number
	intervalMinutes: number
	manual?: boolean
	/** Minutes written down today, and the day's target. */
	loggedMinutes?: number
	minHours?: number
	meetings?: Slot[]
}): boolean {
	if (s.manual) return true // you asked for it; an empty slot is your business
	if (s.isOff || s.checkedInAt == null || s.checkedOutAt != null) return false
	// The day's hours are in: a card still on the screen is no longer owed.
	if (s.minHours != null && (s.loggedMinutes ?? 0) >= s.minHours * 60) return false
	const win = askWindow(Math.max(s.checkedInAt, s.slotEnd ?? 0), s.now, s.meetings)
	if (!win) return false
	return slotDue(win.to, win.from, s.shiftEnd, s.intervalMinutes)
}

export function decide(s: Snapshot): Action[] {
	const out: Action[] = []
	if (s.day.isOff || !isWorkDay(s.today, s.settings.workDays)) return out
	const active = s.idleSecs < ACTIVE_SECS
	const checkedIn = s.day.checkedInAt != null
	const checkedOut = s.day.checkedOutAt != null
	const start = atIst(s.today, s.settings.shiftStart)
	const end = atIst(s.today, s.settings.shiftEnd)
	const graceEnd = start + s.settings.graceMinutes * MIN
	const pendingKind = s.pending?.kind
	const snoozed = s.snoozeUntil != null && s.now < s.snoozeUntil

	// Read Zoho first: never nag about a check-in made on the phone or the web.
	// A refused role is read from your own pages instead (see Engine.tick).
	if (s.hasZoho && !s.roleBlocked && !checkedOut) {
		const every = s.awaitingZoho ? 25_000 : 5 * MIN
		if (s.lastSync == null) return [{ type: 'sync' }]
		if (s.now - s.lastSync >= every) out.push({ type: 'sync' })
	}

	if (!checkedIn) {
		if (s.now >= end) return out // the day is over; the morning scan will flag it
		// Zoho is open and the punch is yours to make: asking again while you are
		// standing in front of the page you were sent to is the loop people
		// describe as "it keeps asking me to check in". The widget and the card
		// both offer "I've checked in" meanwhile, and a read will see the punch.
		if (s.awaitingZoho) return out
		if (s.now >= graceEnd) {
			// Never over the top of a card that is already waiting for an answer:
			// yesterday's unclosed day is one click, and replacing it with "check
			// in" loses the click and the day.
			const waiting = pendingKind != null && s.pending?.blocking
			if (!snoozed && !waiting) out.push({ type: 'checkin', blocking: true })
			return out
		}
		if (s.now >= start && !s.flags.checkinNotified) {
			out.push({ type: 'notify', kind: 'checkin', title: 'Time to check in', body: `Your shift started at ${s.settings.shiftStart}.` })
		}
		if (active && !s.flags.checkinSoftShown && !pendingKind) out.push({ type: 'checkin', blocking: false })
		return out
	}

	// A focus session is a promise to leave you alone: the hourly card waits for
	// it to end, when it asks once about the whole block.
	const focusing = s.focusUntil != null && s.now < s.focusUntil
	if (!checkedOut && s.slotStart != null && !focusing) {
		// A meeting is not an interruption to log — it is one not to interrupt.
		const win = askWindow(s.slotStart, s.now, s.meetings)
		const due = win != null && !inMeeting(s.now, s.meetings) && slotDue(win.to, win.from, end, s.settings.promptInterval)
		// Once the day's hours are written down, the hourly question has been
		// answered — for the day. Working on is your business, and the time can be
		// added whenever you like from "Log now" or the Review page; what should
		// not happen is an extension interrupting the ninth hour to ask about the
		// ninth hour.
		const enough = s.loggedMinutes >= s.settings.minHours * 60
		// After the shift ends you get the final partial slot once, and then the
		// evening belongs to the wrap-up card — which already shows what is
		// unlogged and offers to log it. Two reminders for the same thing, one of
		// them hourly, is how an evening gets ruined.
		const wrappedUp = s.flags.wrapupNotified
		if (due && active && !snoozed && !pendingKind && !enough && !wrappedUp) out.push({ type: 'prompt' })
	}

	if (s.now >= end && s.day.timelogStatus === 'pending') {
		if (!s.flags.wrapupNotified) {
			out.push({ type: 'notify', kind: 'wrapup', title: 'Time to wrap up', body: "Review today's entries, check out and log your time." })
		}
		const late = s.now >= end + (s.settings.wrapupDelay ?? 30) * MIN
		if (late && active && !snoozed && !focusing && !s.flags.wrapupBlocked && !pendingKind) out.push({ type: 'wrapup' })
	}

	// Your hours are in: say so once, so checking out is a decision and not an
	// accident. Measured from check-in, which is what Zoho's own total follows.
	// Only before shift end — after that the wrap-up notification says it.
	if (checkedIn && !checkedOut && s.now < end && !s.flags.hoursDoneNotified && s.day.checkedInAt != null && s.now - s.day.checkedInAt >= s.settings.minHours * 60 * MIN) {
		out.push({ type: 'notify', kind: 'hoursdone', title: `${s.settings.minHours}h done`, body: 'Your hours for today are complete. Log the last slot and check out.' })
	}

	// Hours at the desk without stopping. Suggested once per stretch, and never
	// during a focus session — that is the one time sitting still is the point.
	const breakAfter = (s.settings.breakAfterHours ?? 0) * 60 * MIN
	if (checkedIn && !checkedOut && breakAfter > 0 && !focusing && !s.flags.breakNotified && s.lastBreakAt != null && s.now - s.lastBreakAt >= breakAfter) {
		const hours = Math.round((s.now - s.lastBreakAt) / (60 * MIN))
		out.push({ type: 'notify', kind: 'break', title: 'Time to stand up', body: `${hours} hours without a break. Five minutes away helps the next one.` })
	}

	// Hours past the end of the shift and still checked in. Tonight it is one
	// click; tomorrow it is a regularisation form and a guess at what time you
	// left. So this one rings.
	if (lastCallDue({ now: s.now, shiftEnd: end, checkedIn, checkedOut, told: !!s.flags.lastCallTold, isOff: s.day.isOff })) {
		out.push({ type: 'lastcall' })
	}

	if (s.hasZoho && !s.flags.scanDone) out.push({ type: 'scan' })
	if (s.pendingDays > 0 && !s.flags.catchupNotified) out.push({ type: 'catchup' })
	return out
}
