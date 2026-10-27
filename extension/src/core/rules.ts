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
	/** When the row's entries are one unbroken stretch that fills its time: from and to (epoch ms), for Zoho's fromTime/toTime. */
	from?: number
	to?: number
}

/**
 * From and to, when these entries are one unbroken stretch and every minute of
 * it is claimed: 10:00–11:00 and 11:00–12:00 at 60 min each are 10:00–12:00.
 * A gap, or an hour only partly claimed (45 of 60 min — which 45?), has no
 * honest start and end, so it gets none and goes as hours.
 */
export function spanOf(list: Entry[]): { from: number; to: number } | undefined {
	const work = list.filter((e) => e.kind === 'work' && e.minutes > 0).sort((a, b) => a.slotStart - b.slotStart)
	if (!work.length) return undefined
	for (let i = 1; i < work.length; i++) if (work[i].slotStart - work[i - 1].slotEnd > 60_000) return undefined
	const from = work[0].slotStart
	const to = work[work.length - 1].slotEnd
	const claimed = work.reduce((n, e) => n + e.minutes, 0)
	return Math.abs((to - from) / 60_000 - claimed) <= 1 ? { from, to } : undefined
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

/**
 * Two lines that say the same thing are one task: "Fix retry bug." and
 * "fix  retry bug" differ only in case, spacing and the full stop.
 */
export function taskKey(text: string): string {
	return text
		.normalize('NFKC')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/^[\s\-–—•*·]+|[\s.,;:!…]+$/g, '')
		.trim()
}

/** What people type in the hourly box to mean "still the task before". */
const CONTINUES = /^(same|same task|same as (before|above|previous|earlier|last( hour| one| time)?)|continued?|continuing|cont'?d|contd\.?|cont\.?|ditto|still on (it|that|this)|"|〃|\.{2,3}|-{1,2})$/i
export const continues = (text: string): boolean => CONTINUES.test(text.trim())

/**
 * Each work entry's task in words, in time order, with "same" or "continued"
 * replaced by the task it continues: the last one in the same row (job or
 * meeting), or else the last one at all. A task is worded as it was first written.
 */
export function resolveTasks(entries: Entry[]): Map<string, string> {
	const out = new Map<string, string>()
	const lastIn = new Map<string, string>()
	// One wording per task: the way it was first written that day.
	const first = new Map<string, string>()
	let last = ''
	for (const e of [...entries].sort((a, b) => a.slotStart - b.slotStart)) {
		if (e.kind !== 'work') continue
		let text = e.text.trim()
		if (text && continues(text)) text = lastIn.get(rowKey(e)) ?? (last || text)
		if (text && !first.has(taskKey(text))) first.set(taskKey(text), text)
		text = first.get(taskKey(text)) ?? text
		out.set(e.uid, text)
		if (text && !continues(text)) {
			lastIn.set(rowKey(e), text)
			last = text
		}
	}
	return out
}

/** Groups `work` entries by job in order of first appearance, meetings apart. */
export function groupEntries(entries: Entry[], jobs: Job[]): ReviewRow[] {
	const names = new Map(jobs.map((j) => [j.id, j.name]))
	const tasks = resolveTasks(entries)
	const groups = new Map<string, { jobId?: string; minutes: number; texts: string[]; seen: Set<string>; list: Entry[] }>()
	for (const e of entries) {
		if (e.kind !== 'work' || e.minutes <= 0) continue
		const key = rowKey(e)
		let g = groups.get(key)
		if (!g) {
			g = { jobId: e.jobId || undefined, minutes: 0, texts: [], seen: new Set(), list: [] }
			groups.set(key, g)
		}
		g.minutes += e.minutes
		g.list.push(e)
		// The same task logged in three hours is named once.
		const text = tasks.get(e.uid) ?? e.text.trim()
		if (text && !g.seen.has(taskKey(text))) (g.seen.add(taskKey(text)), g.texts.push(text))
	}
	return [...groups.values()].map((g) => ({
		jobId: g.jobId,
		jobName: g.jobId ? names.get(g.jobId) ?? g.jobId : 'No job',
		minutes: g.minutes,
		hours: round2(g.minutes / 60),
		description: g.texts.join('; '),
		...spanOf(g.list),
	}))
}

/**
 * A job's time in rows of at most `maxMinutes`, **without ever cutting a task**.
 *
 * Rows are filled with whole tasks in the order they were started: when the
 * next task would take a row over the cap, it starts a new row. A task that
 * is longer than the cap on its own is one row anyway — three hours on the
 * webhook retry are one line of 3:00, not three lines saying the same thing,
 * which is what cutting the total used to do. With no cap, one row per job
 * (a meeting apart). Every task is named once.
 */
export function splitRows(entries: Entry[], jobs: Job[], maxMinutes: number): ReviewRow[] {
	const names = new Map(jobs.map((j) => [j.id, j.name]))
	const tasks = resolveTasks(entries)
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
		// The grouping key is not the job any more — a meeting has its own — so
		// the job is read from the entries in the group.
		const jobId = list[0]?.jobId || ''
		// The job's tasks, in the order started, each with all of its entries.
		const byTask = new Map<string, { text: string; list: Entry[]; minutes: number }>()
		for (const e of list) {
			const text = tasks.get(e.uid) ?? e.text.trim()
			const k = taskKey(text)
			const t = byTask.get(k) ?? { text, list: [], minutes: 0 }
			t.list.push(e)
			t.minutes += e.minutes
			byTask.set(k, t)
		}
		let row: { texts: string[]; list: Entry[]; minutes: number } | null = null
		const flush = () => {
			if (!row) return
			out.push({
				jobId: jobId || undefined,
				jobName: jobId ? (names.get(jobId) ?? jobId) : 'No job',
				minutes: row.minutes,
				hours: round2(row.minutes / 60),
				description: row.texts.filter(Boolean).join('; '),
				...spanOf(row.list),
			})
			row = null
		}
		for (const t of byTask.values()) {
			if (row && maxMinutes > 0 && row.minutes + t.minutes > maxMinutes) flush()
			row ??= { texts: [], list: [], minutes: 0 }
			row.texts.push(t.text)
			row.list.push(...t.list)
			row.minutes += t.minutes
		}
		flush()
	}
	return out
}

/**
 * One line per task, for people whose reviewers want the detail.
 *
 * Not one per entry: the hourly box asks every hour, so a task that took three
 * hours is three entries, and three identical lines on a timesheet are the
 * confusion this was meant to avoid. The same task under the same job (or
 * meeting) is one line with its time added up — 1 h, then 2 h, then 3 h as the
 * hours go by — named as it was first written. "Same" or "continued" count as
 * the task before. Lines come in the order the tasks were started.
 */
export function rowsPerTask(entries: Entry[], jobs: Job[]): ReviewRow[] {
	const names = new Map(jobs.map((j) => [j.id, j.name]))
	const tasks = resolveTasks(entries)
	const rows = new Map<string, ReviewRow>()
	const lists = new Map<string, Entry[]>()
	for (const e of [...entries].sort((a, b) => a.slotStart - b.slotStart)) {
		if (e.kind !== 'work' || e.minutes <= 0) continue
		const text = tasks.get(e.uid) ?? e.text.trim()
		const key = `${rowKey(e)}|${taskKey(text)}`
		lists.set(key, [...(lists.get(key) ?? []), e])
		const row = rows.get(key)
		if (row) {
			row.minutes += e.minutes
			row.hours = round2(row.minutes / 60)
			continue
		}
		rows.set(key, {
			jobId: e.jobId || undefined,
			jobName: e.jobId ? names.get(e.jobId) ?? e.jobId : 'No job',
			minutes: e.minutes,
			hours: round2(e.minutes / 60),
			description: text,
		})
	}
	return [...rows].map(([key, row]) => ({ ...row, ...spanOf(lists.get(key)!) }))
}

export interface EntryBlock {
	/** Every entry in it, in time order: ticking or deleting the block is all of them. */
	uids: string[]
	entries: Entry[]
	slotStart: number
	slotEnd: number
	minutes: number
	/** The task, as first written ("same as last hour" resolved). */
	text: string
}

/**
 * The day's log as you would say it: back-to-back hours of the same task,
 * under the same job, are one line — 10:00–13:00 · 3h — not three. Only
 * entries in the same state join: synced with synced, added-for-you with
 * added-for-you. A break, a skip or a different task starts a new line.
 */
export function entryBlocks(entries: Entry[]): EntryBlock[] {
	const tasks = resolveTasks(entries)
	const out: EntryBlock[] = []
	let prev: Entry | undefined
	for (const e of [...entries].sort((a, b) => a.slotStart - b.slotStart)) {
		const text = e.kind === 'work' ? (tasks.get(e.uid) ?? e.text.trim()) : e.text.trim()
		const last = out[out.length - 1]
		const joins =
			!!last && !!prev && e.kind === 'work' && prev.kind === 'work' &&
			rowKey(e) === rowKey(prev) && taskKey(text) === taskKey(last.text) &&
			!!e.synced === !!prev.synced && !!e.auto === !!prev.auto &&
			e.slotStart - prev.slotEnd <= 60_000
		if (joins) {
			last.uids.push(e.uid)
			last.entries.push(e)
			last.slotEnd = Math.max(last.slotEnd, e.slotEnd)
			last.minutes += e.minutes
		} else {
			out.push({ uids: [e.uid], entries: [e], slotStart: e.slotStart, slotEnd: e.slotEnd, minutes: e.kind === 'work' ? e.minutes : 0, text })
		}
		prev = e
	}
	return out
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
