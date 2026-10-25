// Pure rules (ported from src-tauri/src/rules.rs, same test cases):
// review grouping, regularisation classification, scan range and away spans.

import { addDays, atIst, istTime, istWeekday } from './time'
import type { Entry, IssueKind, Job } from './types'

export function hoursFromHHMM(s: string): number {
	const t = (s ?? '').trim()
	if (t.includes(':')) {
		const [h, m] = t.split(':')
		return (Number(h) || 0) + (Number(m) || 0) / 60
	}
	return Number(t) || 0
}

export const round2 = (x: number) => Math.round(x * 100) / 100

/** "1:30", "01:30", "90m", "1.5" — what someone might type into an hours box. */
export function minutesFromHHMM(s: string): number | null {
	const t = (s ?? '').trim()
	if (!t) return null
	const clock = t.match(/^(\d{1,2}):([0-5]\d)$/)
	if (clock) return +clock[1] * 60 + +clock[2]
	const mins = t.match(/^(\d{1,4})\s*m$/i)
	if (mins) return +mins[1]
	const dec = t.match(/^\d{1,2}(\.\d{1,2})?$/)
	if (dec) return Math.round(parseFloat(t) * 60)
	return null
}

export function isWorkDay(date: string, workDays: number[]): boolean {
	return workDays.includes(istWeekday(atIst(date, '12:00')))
}

export interface ReviewRow {
	jobId?: string
	jobName: string
	minutes: number
	hours: number
	description: string
}

/**
 * Which row an entry belongs in.
 *
 * By job, except that a meeting gets its own. A recurring standup logged
 * against the same job as the day's work would otherwise be swallowed into it
 * — "Daily standup; LEAP-19 webhook retry" on one line — and the half hour a
 * meeting actually took stops being visible as the separate thing it was.
 * It keeps its job, so it still pushes to Zoho under the right one.
 */
const rowKey = (e: Entry) => (e.meetingId ? `meeting:${e.meetingId}` : e.jobId || '')

/** Groups `work` entries by job in order of first appearance, meetings apart. */
export function groupEntries(entries: Entry[], jobs: Job[]): ReviewRow[] {
	const names = new Map(jobs.map((j) => [j.id, j.name]))
	const groups = new Map<string, { jobId?: string; minutes: number; texts: string[] }>()
	for (const e of entries) {
		if (e.kind !== 'work' || e.minutes <= 0) continue
		const key = rowKey(e)
		let g = groups.get(key)
		if (!g) {
			g = { jobId: e.jobId || undefined, minutes: 0, texts: [] }
			groups.set(key, g)
		}
		g.minutes += e.minutes
		const text = e.text.trim()
		if (text && !g.texts.includes(text)) g.texts.push(text)
	}
	return [...groups.values()].map((g) => ({
		jobId: g.jobId,
		jobName: g.jobId ? names.get(g.jobId) ?? g.jobId : 'No job',
		minutes: g.minutes,
		hours: round2(g.minutes / 60),
		description: g.texts.join('; '),
	}))
}

/**
 * A job's time cut into rows of at most `maxMinutes`, **carrying the work that
 * actually happened in each one**.
 *
 * Splitting the total and copying the merged description into every row — which
 * is what this used to do — produces four identical lines that say everything
 * and mean nothing. Entries are logged through the day with their own text, so
 * the rows are filled in time order from those entries: the first hour says what
 * you did in the first hour. An entry that straddles a boundary is named in both
 * rows, because it genuinely was in both.
 */
export function splitRows(entries: Entry[], jobs: Job[], maxMinutes: number): ReviewRow[] {
	const names = new Map(jobs.map((j) => [j.id, j.name]))
	const order: string[] = []
	const byJob = new Map<string, Entry[]>()
	for (const e of entries) {
		if (e.kind !== 'work' || e.minutes <= 0) continue
		const key = rowKey(e)
		if (!byJob.has(key)) {
			byJob.set(key, [])
			order.push(key)
		}
		byJob.get(key)!.push(e)
	}

	const out: ReviewRow[] = []
	for (const key of order) {
		const list = [...byJob.get(key)!].sort((a, b) => a.slotStart - b.slotStart)
		const total = list.reduce((n, e) => n + e.minutes, 0)
		// Even chunks, with the remainder spread a minute at a time rather than
		// dumped on the last row, so the total never changes.
		const parts = maxMinutes > 0 && total > maxMinutes ? Math.ceil(total / maxMinutes) : 1
		const base = Math.floor(total / parts)
		const spare = total - base * parts
		const sizes = Array.from({ length: parts }, (_, i) => base + (i < spare ? 1 : 0))

		// The grouping key is not the job any more — a meeting has its own — so
		// the job is read from the entries in the group.
		const jobId = list[0]?.jobId || ''
		const row = (minutes: number, texts: string[]): ReviewRow => ({
			jobId: jobId || undefined,
			jobName: jobId ? (names.get(jobId) ?? jobId) : 'No job',
			minutes,
			hours: round2(minutes / 60),
			description: texts.join('; '),
		})

		let at = 0
		let left = sizes[0]
		let texts: string[] = []
		for (const e of list) {
			let rest = e.minutes
			const text = e.text.trim()
			while (rest > 0) {
				if (text && !texts.includes(text)) texts.push(text)
				const take = Math.min(rest, left)
				rest -= take
				left -= take
				if (left === 0 && at < parts - 1) {
					out.push(row(sizes[at], texts))
					texts = []
					at++
					left = sizes[at]
				} else if (left === 0) {
					break // the last row takes whatever is left over
				}
			}
		}
		out.push(row(sizes[at], texts))
	}
	return out
}

/** Every entry as its own line, for people whose reviewers want the detail. */
export function rowsPerEntry(entries: Entry[], jobs: Job[]): ReviewRow[] {
	const names = new Map(jobs.map((j) => [j.id, j.name]))
	return entries
		.filter((e) => e.kind === 'work' && e.minutes > 0)
		.map((e) => ({
			jobId: e.jobId || undefined,
			jobName: e.jobId ? names.get(e.jobId) ?? e.jobId : 'No job',
			minutes: e.minutes,
			hours: round2(e.minutes / 60),
			description: e.text.trim(),
		}))
}

export interface DayReport {
	date: string
	status: string
	firstIn: string
	lastOut: string
	totalHours: string
}

/** Zoho uses "", "-" or "--" for "no punch". */
export const blank = (s: string | undefined) => ['', '-', '--', '00:00'].includes((s ?? '').trim())

/**
 * Returns the issue for a day that needs regularising. Leave types appear as
 * their own status (e.g. "Sick"), so anything not present/absent is an off day.
 */
export function classify(day: DayReport, minHours: number, workDays: number[]): { kind: IssueKind; detail: string } | null {
	if (!isWorkDay(day.date, workDays)) return null
	const status = day.status.toLowerCase()
	const punchedIn = !blank(day.firstIn)
	const punchedOut = !blank(day.lastOut)
	const present = status.includes('present')
	const absent = status.includes('absent')
	if (!present && !absent && !punchedIn) return null
	if (punchedIn && !punchedOut) return { kind: 'missing_checkout', detail: `Checked in ${day.firstIn.trim()} with no check-out` }
	if (absent && !punchedIn) return { kind: 'absent', detail: 'Marked absent with no leave or holiday' }
	const hours = hoursFromHHMM(day.totalHours)
	if (hours < minHours) return { kind: 'short_hours', detail: `${hours.toFixed(1)}h of ${minHours.toFixed(0)}h` }
	return null
}

/**
 * The same three rules against WorkPulse's own record of a day, for roles Zoho
 * refuses the attendance report to. Less authoritative than Zoho's report — it
 * only knows the days you used WorkPulse — but it catches the ones that cost
 * you, which is the point.
 */
export function classifyLocal(
	day: { date: string; checkedInAt?: number; checkedOutAt?: number; isOff: boolean },
	loggedMinutes: number,
	minHours: number,
	workDays: number[],
	istTimeOf: (at: number) => string,
): { kind: IssueKind; detail: string } | null {
	if (day.isOff || !isWorkDay(day.date, workDays)) return null
	if (day.checkedInAt == null) {
		// Never checked in but worked: that is the worst kind to leave unfixed.
		return loggedMinutes > 0 ? { kind: 'absent', detail: `${fmtHours(loggedMinutes)} logged with no check-in` } : null
	}
	if (day.checkedOutAt == null) return { kind: 'missing_checkout', detail: `Checked in ${istTimeOf(day.checkedInAt)} with no check-out` }
	const minutes = Math.round((day.checkedOutAt - day.checkedInAt) / 60_000)
	// A check-out before the check-in is not a short day, it is a wrong time —
	// and reporting it as "-1h -35m of 8h" tells nobody anything they can act on.
	if (minutes < 0) return { kind: 'missing_checkout', detail: `Checked out ${istTimeOf(day.checkedOutAt)}, before the ${istTimeOf(day.checkedInAt)} check-in` }
	if (minutes < minHours * 60) return { kind: 'short_hours', detail: `${fmtHours(minutes)} of ${minHours}h on the clock` }
	return null
}

const fmtHours = (min: number) => {
	const m = Math.max(0, Math.round(min))
	return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

/** 1st of this month → yesterday; in the first 5 days, from the previous month's 1st. */
export function scanRange(today: string): [string, string] {
	const end = addDays(today, -1)
	const [y, m, d] = today.split('-').map(Number)
	const first = `${y}-${String(m).padStart(2, '0')}-01`
	if (d > 5) return [first, end]
	const prev = addDays(first, -1)
	return [`${prev.slice(0, 7)}-01`, end]
}

export type Span = [number, number]

export function mergeSpans(spans: Span[]): Span[] {
	const v = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1])
	const out: Span[] = []
	for (const [a, b] of v) {
		const last = out[out.length - 1]
		if (last && a <= last[1]) last[1] = Math.max(last[1], b)
		else out.push([a, b])
	}
	return out
}

export function awayMinutes(spans: Span[], from: number, to: number): number {
	return mergeSpans(spans).reduce((sum, [a, b]) => {
		const s = Math.max(a, from)
		const e = Math.min(b, to)
		return sum + (e > s ? Math.floor((e - s) / 60_000) : 0)
	}, 0)
}

export function awayNote(spans: Span[], from: number, to: number): string | null {
	const hits = spans.filter(([a, b]) => b > from && a < to)
	if (!hits.length) return null
	const first = Math.min(...hits.map(([a]) => Math.max(a, from)))
	const last = Math.max(...hits.map(([, b]) => Math.min(b, to)))
	return `Away ${istTime(first)}–${istTime(last)}`
}

/** Zoho punch times come in several formats depending on org settings. Returns epoch ms or null. */
export function parseZohoDateTime(s: string): number | null {
	const t = (s ?? '').trim()
	const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
	const p2 = (n: number) => String(n).padStart(2, '0')
	const make = (y: number, mo: number, d: number, h: number, mi: number, sec = 0) =>
		atIst(`${y}-${p2(mo)}-${p2(d)}`, `${p2(h)}:${p2(mi)}`) + sec * 1000
	const to24 = (h: number, ampm: string) => (ampm.toUpperCase() === 'PM' ? (h % 12) + 12 : h % 12)
	let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
	if (m) return make(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0))
	m = t.match(/^(\d{2})[-/](\d{2})[-/](\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/)
	if (m) return make(+m[3], +m[2], +m[1], +m[4], +m[5], +(m[6] ?? 0))
	m = t.match(/^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{1,2}):(\d{2}) ?(AM|PM)$/i)
	if (m && months[m[2].toLowerCase()]) return make(+m[3], months[m[2].toLowerCase()], +m[1], to24(+m[4], m[6]), +m[5])
	m = t.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}) ?(AM|PM)$/i)
	if (m) return make(+m[1], +m[2], +m[3], to24(+m[4], m[6]), +m[5])
	return null
}
