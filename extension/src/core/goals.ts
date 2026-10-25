// Goals bigger than a day, and the two numbers that tell you how a stretch of
// days actually went.
//
// A goal here is one sentence and a verdict. Progress is never a made-up
// percentage: it is the hours you logged, the days you completed and the things
// you worked on, counted from entries that already exist.

import { addDays, atIst, fmtMinutes, istDate, istWeekday } from './time'
import type { Entry } from './types'
import { ticketKey } from './links'

export type GoalScope = 'week' | 'month'

export interface Goal {
	/** `2026-W42` or `2026-10`. */
	key: string
	scope: GoalScope
	text: string
	at: number
	verdict?: 'done' | 'partly' | 'missed'
	why?: string
}

/** The Monday-based week a date falls in, as `2026-W42`. */
export function weekKey(date: string): string {
	const monday = startOfWeek(date)
	const [y] = monday.split('-').map(Number)
	// Week 1 is the one holding the first Monday on or after 1 January.
	const firstMonday = startOfWeek(`${y}-01-07`)
	const weeks = Math.round((atIst(monday, '12:00') - atIst(firstMonday, '12:00')) / (7 * 86_400_000)) + 1
	return `${y}-W${String(weeks).padStart(2, '0')}`
}

export const monthKey = (date: string) => date.slice(0, 7)

export function startOfWeek(date: string): string {
	return addDays(date, -(istWeekday(atIst(date, '12:00')) - 1))
}

/** Every date in the week or month a date belongs to, oldest first. */
export function datesIn(scope: GoalScope, date: string): string[] {
	if (scope === 'week') {
		const start = startOfWeek(date)
		return Array.from({ length: 7 }, (_, i) => addDays(start, i))
	}
	const [y, m] = date.split('-').map(Number)
	const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
	return Array.from({ length: days }, (_, i) => `${date.slice(0, 7)}-${String(i + 1).padStart(2, '0')}`)
}

export interface Progress {
	/** Days you were on the clock. */
	worked: number
	/** Work days in the period that have been and gone. */
	elapsed: number
	minutes: number
	/** The things worked on, biggest first. */
	things: { label: string; minutes: number }[]
	/** Days whose logs never reached Zoho. */
	pending: number
}

export interface ProgressInput {
	dates: string[]
	today: string
	workDays: number[]
	entries: Entry[]
	days: { date: string; checkedInAt?: number; isOff?: boolean }[]
	pendingDays: string[]
	jobName: (id: string) => string
}

/** What a week or a month amounted to. Counted, never estimated. */
export function progress(i: ProgressInput): Progress {
	const inRange = new Set(i.dates)
	const isWork = (d: string) => i.workDays.includes(istWeekday(atIst(d, '12:00')))
	const byThing = new Map<string, number>()
	let minutes = 0

	for (const e of i.entries) {
		if (!inRange.has(e.date) || e.kind !== 'work' || e.minutes <= 0) continue
		const label = ticketKey(e.text) ?? (e.jobId ? i.jobName(e.jobId) : 'Other')
		byThing.set(label, (byThing.get(label) ?? 0) + e.minutes)
		minutes += e.minutes
	}

	return {
		worked: i.days.filter((d) => inRange.has(d.date) && !d.isOff && d.checkedInAt != null).length,
		elapsed: i.dates.filter((d) => d <= i.today && isWork(d)).length,
		minutes,
		things: [...byThing.entries()].map(([label, m]) => ({ label, minutes: m })).sort((a, b) => b.minutes - a.minutes),
		pending: i.pendingDays.filter((d) => inRange.has(d)).length,
	}
}

// ── how scattered the day was ───────────────────────────────────────────────

export interface Switches {
	/** Times the thing you were working on changed. */
	count: number
	/** The longest unbroken run on one thing, in minutes. */
	longest: number
	/** What that run was on. */
	longestOn?: string
	/** Distinct things worked on. */
	things: number
}

/**
 * Context switches, counted from the order you logged things rather than from
 * tab activity — which counts reading a doc about the thing you are doing as a
 * switch away from it, and is why tab-based numbers feel wrong.
 */
export function switches(entries: Entry[], jobName: (id: string) => string): Switches {
	const work = entries.filter((e) => e.kind === 'work' && e.minutes > 0).sort((a, b) => a.slotStart - b.slotStart)
	const labels = work.map((e) => ticketKey(e.text) ?? (e.jobId ? jobName(e.jobId) : 'Other'))
	let count = 0
	let run = 0
	let longest = 0
	let longestOn: string | undefined
	for (const [i, label] of labels.entries()) {
		if (i > 0 && label !== labels[i - 1]) {
			count++
			run = 0
		}
		run += work[i].minutes
		if (run > longest) {
			longest = run
			longestOn = label
		}
	}
	return { count, longest, longestOn, things: new Set(labels).size }
}

/** How that compares with a normal day, said plainly rather than scored. */
export function switchNote(s: Switches): string {
	if (!s.things) return 'Nothing logged yet.'
	if (s.count === 0) return `One thing all day — ${s.longestOn}.`
	if (s.count <= 3) return `${s.count} switch${s.count === 1 ? '' : 'es'} between ${s.things} things. Longest stretch ${fmtMinutes(s.longest)} on ${s.longestOn}.`
	return `${s.count} switches between ${s.things} things. The longest unbroken stretch was ${fmtMinutes(s.longest)}.`
}


export const goalKeyFor = (scope: GoalScope, date: string) => (scope === 'week' ? weekKey(date) : monthKey(date))

/** "Week of 12 Oct" / "October" — a goal's own name. */
export function goalTitle(scope: GoalScope, date: string): string {
	if (scope === 'month') {
		const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
		return `${months[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`
	}
	const start = startOfWeek(date)
	const d = Number(start.slice(8, 10))
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
	return `Week of ${d} ${months[Number(start.slice(5, 7)) - 1]}`
}

// ── the ten-minute cleanup ──────────────────────────────────────────────────

export interface QuickTask {
	uid: string
	title: string
	key?: string
	estimateMinutes?: number
}

/**
 * The small things that never deserve a ticket and never get done: send the
 * update, approve the expense, reply to the client. Shown three at a time —
 * a list of twenty is the thing you are avoiding.
 */
export function quickWins<T extends { uid: string; title: string; key?: string; status: string; kind?: string; quick?: boolean; blocked?: boolean; estimateMinutes?: number; createdAt: number }>(
	tasks: T[],
	limit = 3,
): QuickTask[] {
	return tasks
		.filter((t) => t.kind !== 'note' && t.status !== 'done' && !t.blocked && (t.quick || (t.estimateMinutes != null && t.estimateMinutes <= 15)))
		.sort((a, b) => (a.estimateMinutes ?? 10) - (b.estimateMinutes ?? 10) || a.createdAt - b.createdAt)
		.slice(0, limit)
		.map((t) => ({ uid: t.uid, title: t.title, key: t.key, estimateMinutes: t.estimateMinutes }))
}

/** What the cleanup block would cost you, for the button to say it. */
export const cleanupMinutes = (list: QuickTask[]) => list.reduce((n, t) => n + (t.estimateMinutes ?? 10), 0)

export interface PlannedActual {
	title: string
	planned: number
	actual: number
}

/**
 * Planned against actual, for the tasks where you said what you expected. Only
 * those: inventing an estimate to compare against would make the number a lie.
 */
export function plannedActual<T extends { uid: string; title: string; key?: string; estimateMinutes?: number; spentMinutes: number }>(tasks: T[]): PlannedActual[] {
	return tasks
		.filter((t) => t.estimateMinutes != null && t.estimateMinutes > 0 && t.spentMinutes > 0)
		.map((t) => ({ title: t.key ? `${t.key} — ${t.title}` : t.title, planned: t.estimateMinutes!, actual: t.spentMinutes }))
		.sort((a, b) => b.actual - a.actual)
}
