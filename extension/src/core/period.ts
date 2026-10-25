// What you did over a week, a month, or the last six months.
//
// This is the question nobody can answer. Appraisal season, a promo packet, a
// new CV, a skip-level: "what have you been working on?" and March is a blank.
// A tracker knows which tickets moved. Your manager knows what they remember.
// You wrote the real answer down nine hundred times, an hour at a time, in your
// own words — and then never read it back.
//
// One shape for all three periods. A week is the thing you paste into a 1:1, a
// month is the status update, six months is the document you dread writing.
// Nothing here is generated or guessed: every line is a line you typed.

import { ticketKey } from './links'
import { addDays, fmtMinutes, istDate } from './time'
import type { Entry, Job, Task } from './types'

export type Span = 'week' | 'month' | 'quarter' | 'half' | 'year' | 'custom'

export const SPAN_DAYS: Record<Exclude<Span, 'custom'>, number> = { week: 7, month: 30, quarter: 90, half: 182, year: 365 }

export const SPAN_LABEL: Record<Span, string> = {
	week: 'This week',
	month: 'This month',
	quarter: 'Last three months',
	half: 'Last six months',
	year: 'The last year',
	custom: 'Chosen dates',
}

export interface PeriodLine {
	/** The ticket key, or the job, or "Other". */
	label: string
	minutes: number
	days: number
	/** What you said about it, in the order you said it, de-duplicated. */
	said: string[]
	first: string
	last: string
	/** The ticket's own name, when one is saved under that key. */
	name?: string
}

export interface PeriodReport {
	from: string
	to: string
	span: Span
	/** Everything worked on, biggest first. */
	lines: PeriodLine[]
	minutes: number
	/** Days with anything logged at all. */
	daysWorked: number
	/** What you learned and what you would not repeat, over the period. */
	learnings: { date: string; text: string; kind?: string }[]
	/** Things finished in the period, newest first. */
	finished: { title: string; key?: string; at: string }[]
	/** The handful that took the most time — what the period was really about. */
	headline: PeriodLine[]
}

export interface PeriodInput {
	entries: Entry[]
	jobs: Job[]
	tasks: Task[]
	tickets: { name: string }[]
	learnings: { date: string; text: string; kind?: string }[]
}

/** The first date of a span ending today (inclusive of both ends). */
export function spanFrom(today: string, span: Exclude<Span, 'custom'>): string {
	return addDays(today, -(SPAN_DAYS[span] - 1))
}

/**
 * The period, assembled.
 *
 * Grouped by what the work was about rather than by day, because "six months"
 * answered day by day is a log, and what anyone asking wants is a shape.
 */
export function periodReport(input: PeriodInput, from: string, to: string, span: Span = 'custom'): PeriodReport {
	const names = new Map(input.jobs.map((j) => [j.id, j.name]))
	// A saved ticket's own name says more than its key: "PAY-2433 financing
	// button" rather than "PAY-2433".
	const titles = new Map<string, string>()
	for (const t of input.tickets) {
		const key = ticketKey(t.name)
		if (key && !titles.has(key)) titles.set(key, t.name)
	}

	const lines = new Map<string, PeriodLine & { dates: Set<string> }>()
	let minutes = 0
	const days = new Set<string>()

	for (const e of input.entries
		.filter((x) => x.kind === 'work' && x.minutes > 0 && x.date >= from && x.date <= to)
		.sort((a, b) => a.slotStart - b.slotStart)) {
		const label = ticketKey(e.text) ?? (e.jobId ? (names.get(e.jobId) ?? e.jobId) : 'Other')
		const line = lines.get(label) ?? { label, minutes: 0, days: 0, said: [], first: e.date, last: e.date, name: titles.get(label), dates: new Set<string>() }
		line.minutes += e.minutes
		line.dates.add(e.date)
		if (e.date < line.first) line.first = e.date
		if (e.date > line.last) line.last = e.date
		const said = clean(e.text, label)
		if (said && !line.said.includes(said)) line.said.push(said)
		lines.set(label, line)
		minutes += e.minutes
		days.add(e.date)
	}

	const out = [...lines.values()]
		.map(({ dates, ...l }) => ({ ...l, days: dates.size }))
		.sort((a, b) => b.minutes - a.minutes)

	return {
		from,
		to,
		span,
		lines: out,
		minutes,
		daysWorked: days.size,
		learnings: input.learnings.filter((l) => l.date >= from && l.date <= to).sort((a, b) => b.date.localeCompare(a.date)),
		finished: input.tasks
			.filter((t) => t.status === 'done' && t.doneAt != null && istDate(t.doneAt) >= from && istDate(t.doneAt) <= to)
			.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
			.map((t) => ({ title: t.title, key: t.key, at: istDate(t.doneAt!) })),
		// Where the time actually went. Three is enough to be an answer and few
		// enough to be remembered.
		headline: out.slice(0, 3),
	}
}

/** The key is already the heading; repeating it in every line is noise. */
function clean(text: string, label: string): string {
	return text
		.replace(new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:·—-]*\\s*`, 'i'), '')
		.replace(/\s*\n+\s*/g, ' ')
		.trim()
}

export type PeriodStyle = 'markdown' | 'plain'

/**
 * The document. Written to be pasted into an appraisal form, a 1:1 doc or a
 * message — so the headline comes first and the detail is underneath, which is
 * the order someone reads it in and the opposite of the order it happened.
 */
export function periodText(r: PeriodReport, style: PeriodStyle = 'markdown', who?: string): string {
	const h1 = (t: string) => (style === 'markdown' ? `# ${t}` : t.toUpperCase())
	const h2 = (t: string) => (style === 'markdown' ? `## ${t}` : `\n${t}`)
	const b = (t: string) => (style === 'markdown' ? `**${t}**` : t)
	const out: string[] = []

	out.push(h1(`${SPAN_LABEL[r.span]}${who ? ` — ${who}` : ''}`), '', `${r.from} to ${r.to} · ${fmtMinutes(r.minutes)} logged over ${r.daysWorked} day${r.daysWorked === 1 ? '' : 's'}`, '')

	if (r.headline.length) {
		out.push(h2('What it was mostly about'), '')
		for (const l of r.headline) out.push(`- ${b(l.name ?? l.label)} — ${fmtMinutes(l.minutes)} across ${l.days} day${l.days === 1 ? '' : 's'}`)
		out.push('')
	}

	out.push(h2('Everything, by what it was about'), '')
	if (!r.lines.length) out.push('- Nothing logged in this period.')
	for (const l of r.lines) {
		out.push(`- ${b(l.name ?? l.label)} · ${fmtMinutes(l.minutes)} · ${l.first === l.last ? l.first : `${l.first} → ${l.last}`}`)
		// Capped: an appraisal is read, and forty lines under one ticket is a log.
		for (const s of l.said.slice(0, 6)) out.push(`  - ${s}`)
		if (l.said.length > 6) out.push(`  - …and ${l.said.length - 6} more entries`)
	}

	if (r.finished.length) {
		out.push('', h2('Finished'), '')
		for (const t of r.finished.slice(0, 20)) out.push(`- ${t.key ? `${t.key} — ` : ''}${t.title} (${t.at})`)
	}

	if (r.learnings.length) {
		out.push('', h2('What I learned'), '')
		for (const l of r.learnings.slice(0, 20)) out.push(`- ${l.text}${l.kind === 'mistake' ? ' _(would not repeat)_' : ''}`)
	}

	out.push('', style === 'markdown' ? '<sub>From WorkPulse — every line written at the time, by me.</sub>' : 'From WorkPulse — every line written at the time, by me.')
	return out.join('\n')
}
