// What you did, said the way a standup wants to hear it.
//
// This is the thing WorkPulse can do that a tracker and a ticket system cannot.
// A tracker knows you had GitHub open for three hours; Jira knows a ticket moved.
// Neither knows what you *did*, because only you know that — and you already
// said it, an hour at a time, all day. This turns that into the paragraph
// somebody asks you for every morning.

import type { Entry, Job, Task } from './types'
import { addDays, fmtMinutes, istDate } from './time'
import { ticketKey } from './links'
import { resolveTasks, taskKey } from './rules'

export interface StandupLine {
	/** The ticket key or job name this belongs to. */
	label: string
	minutes: number
	/** What you said about it, in the order you said it. */
	said: string[]
}

export interface Standup {
	date: string
	yesterday: StandupLine[]
	today: string[]
	blocked: string[]
	/** Minutes of work the day held, meetings and all. */
	minutes: number
}

export interface StandupInput {
	entries: Entry[]
	jobs: Job[]
	tasks: Task[]
	/** Ticket names, so a key in an entry can be shown as the ticket it is. */
	tickets: { name: string }[]
}

/**
 * Yesterday grouped the way a standup is spoken: by the thing worked on, not by
 * the hour. An entry's ticket key wins over its job — "PAY-2433" says more to
 * the people listening than "Platform".
 */
export function standup(input: StandupInput, date: string): Standup {
	const names = new Map(input.jobs.map((j) => [j.id, j.name]))
	const lines = new Map<string, StandupLine>()
	let minutes = 0
	// "same" and "continued" are the task before, and one task is said once.
	const day = input.entries.filter((x) => x.date === date && x.kind === 'work' && x.minutes > 0).sort((a, b) => a.slotStart - b.slotStart)
	const tasks = resolveTasks(day)

	for (const e of day) {
		const said = tasks.get(e.uid) ?? e.text
		const key = ticketKey(said) ?? (e.jobId ? (names.get(e.jobId) ?? e.jobId) : 'Other')
		const line = lines.get(key) ?? { label: key, minutes: 0, said: [] }
		line.minutes += e.minutes
		const text = cleanSaid(said, key)
		if (text && !line.said.some((x) => taskKey(x) === taskKey(text))) line.said.push(text)
		lines.set(key, line)
		minutes += e.minutes
	}

	const open = input.tasks.filter((t) => t.kind !== 'note' && t.status !== 'done')
	return {
		date,
		yesterday: [...lines.values()].sort((a, b) => b.minutes - a.minutes),
		today: open.filter((t) => !t.blocked).sort(byPriority).slice(0, 3).map(taskLine),
		blocked: open.filter((t) => t.blocked).map(taskLine),
		minutes,
	}
}

const taskLine = (t: Task) => (t.key ? `${t.key} — ${t.title}` : t.title)
const RANK = { high: 0, normal: 1, low: 2 } as const
const byPriority = (a: Task, b: Task) => RANK[a.priority ?? 'normal'] - RANK[b.priority ?? 'normal']

/** The key is already the heading; repeating it in every line is noise. */
function cleanSaid(text: string, key: string): string {
	return text
		.replace(new RegExp(`^\\s*${key}\\s*[:·—-]*\\s*`, 'i'), '')
		.replace(/\s*\n+\s*/g, ' ')
		.trim()
}

export type StandupStyle = 'slack' | 'plain' | 'markdown'

/**
 * The text to paste. Slack wants `*bold*` and bullets; a document wants
 * Markdown; some people just want lines.
 */
export function standupText(s: Standup, style: StandupStyle = 'slack', heading = 'Yesterday'): string {
	const bold = (t: string) => (style === 'slack' ? `*${t}*` : style === 'markdown' ? `**${t}**` : t)
	const bullet = style === 'markdown' ? '-' : '•'
	const out: string[] = []

	out.push(bold(heading))
	if (!s.yesterday.length) out.push(`${bullet} Nothing logged.`)
	for (const line of s.yesterday) {
		out.push(`${bullet} ${line.label} · ${fmtMinutes(line.minutes)}${line.said.length ? ` — ${line.said.join('; ')}` : ''}`)
	}

	out.push('', bold('Today'))
	if (!s.today.length) out.push(`${bullet} Nothing planned yet.`)
	for (const t of s.today) out.push(`${bullet} ${t}`)

	if (s.blocked.length) {
		out.push('', bold('Blocked'))
		for (const t of s.blocked) out.push(`${bullet} ${t}`)
	}
	return out.join('\n')
}

/** Which day a standup should be about: yesterday, or Friday on a Monday. */
export function standupDate(today: string, workDays: number[], weekdayOf: (date: string) => number): string {
	let date = addDays(today, -1)
	for (let i = 0; i < 7; i++) {
		if (workDays.includes(weekdayOf(date))) return date
		date = addDays(date, -1)
	}
	return addDays(today, -1)
}

export const yesterdayOf = (now: number) => addDays(istDate(now), -1)
