// Days that are not working days, in Zoho's own words.
//
// Zoho's attendance report already says so — "Holiday", "Paid Leave", "Weekend"
// come back in the same `Status` field WorkPulse reads for everything else. The
// app simply never looked, so it asked you to check in on Diwali, prompted you
// every hour on approved leave, and raised a regularisation issue on Wednesday
// for an absence approved three weeks earlier. Worse, Zoho refuses a time log
// on those days outright ("Weekend/Holidays/Leave", code 8008), so the one
// answer you did give could not be saved.
//
// Nothing here asks Zoho anything new. It reads a field that was already there.

import type { DayReport } from './rules'

export type DayKind = 'work' | 'weekend' | 'holiday' | 'leave' | 'half'

/**
 * What kind of day Zoho says this was.
 *
 * Status strings vary with how a company configured Zoho — "Paid Leave", "Comp
 * Off", "Week Off", "Restricted Holiday" — so this matches on words rather than
 * on a list of exact values nobody can keep up to date. "Present" always wins:
 * a day you worked is a working day whatever else it is labelled.
 */
export function dayKind(status: string): DayKind {
	const s = (status ?? '').toLowerCase()
	if (/half.?day/.test(s)) return 'half'
	// Worked, whatever the label says. A half day is the one exception above:
	// Zoho marks those present too.
	if (/present/.test(s)) return 'work'
	if (/week.?off|weekend/.test(s)) return 'weekend'
	if (/holiday|festival/.test(s)) return 'holiday'
	// "Absent" is not leave, and must never be read as one: an absence nobody
	// approved is exactly the thing the regularisation page is for.
	if (/absent/.test(s)) return 'work'
	if (/leave|vacation|\bpto\b|comp.?off|wfh.?approved|on duty|od\b/.test(s)) return 'leave'
	return 'work'
}

/** Is this a day the app should say nothing on? */
export const isOffKind = (k: DayKind) => k === 'weekend' || k === 'holiday' || k === 'leave'

/** How it should read on screen: "Holiday", "On leave", "Half day". */
export function kindLabel(k: DayKind): string {
	return { work: 'Working day', weekend: 'Week off', holiday: 'Holiday', leave: 'On leave', half: 'Half day' }[k]
}

export interface OffDay {
	date: string
	kind: DayKind
	/** Zoho's own words, kept so a surprising day can be checked against Zoho. */
	status: string
}

/** Every day in a report that is not an ordinary working day. */
export function offDays(report: DayReport[]): OffDay[] {
	return report
		.map((d) => ({ date: d.date, kind: dayKind(d.status), status: (d.status ?? '').trim() }))
		.filter((d) => d.kind !== 'work')
}

/**
 * The hours expected of a day. A half day asks for half of them — nagging
 * someone at 13:00 that they are four hours short of eight is the app not
 * having read the thing it is holding.
 */
export function hoursFor(kind: DayKind, minHours: number): number {
	if (isOffKind(kind)) return 0
	return kind === 'half' ? minHours / 2 : minHours
}
