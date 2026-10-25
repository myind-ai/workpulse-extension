// The two ends of a day, built from what actually happened in the last one.
//
// A morning briefing that asks you to maintain it is a second to-do list, and
// nobody keeps two. Everything here is derived: yesterday from your entries,
// what is unfinished from your tasks, and the first thing to do from signals
// that already exist — what you set last night, what you spent yesterday on,
// what is overdue, what Zoho is still waiting for.

import { standup, type StandupInput, type StandupLine } from './standup'
import { addDays, fmtMinutes, istDate } from './time'
import type { Entry, Issue, Job, Task } from './types'

/** What you decided about a day. The only part of this anyone types. */
export interface DayPlan {
	date: string
	/** One sentence. "Get the retry fix through review and verified in staging." */
	goal?: string
	/** The thing to start with — the first of `todos`, kept for the briefing. */
	firstTask?: string
	/** What you lined up for the day, in order, the evening before. */
	todos?: string[]
	/** How the day went, answered at the end of it. */
	verdict?: 'done' | 'partly' | 'blocked'
	/** Why, when it was not done. Optional, and never asked twice. */
	why?: string
	/**
	 * The one thing that would make next week better, written on Friday.
	 * Monday's briefing shows it back — a resolution nobody reads again is a
	 * resolution nobody keeps.
	 */
	weekIntention?: string
}

export interface Suggestion {
	title: string
	/** The signal behind it, said plainly. Never a motivational line. */
	why: string
}

export interface Briefing {
	/** The day being briefed — today. */
	date: string
	/** The last day you worked, which is what "yesterday" means on a Monday. */
	about: string
	yesterday: StandupLine[]
	minutes: number
	/** Work that was open before today and still is. */
	unfinished: string[]
	/** One to start with, and at most two others. */
	suggested: Suggestion[]
	/** What you lined up last night, in the order you put them. */
	planned: string[]
	goal?: string
}

export interface BriefingInput extends StandupInput {
	today: string
	/** The last worked day, from `standupDate`. */
	about: string
	/** Days whose time logs never reached Zoho. */
	pendingDays: string[]
	/** Regularisation issues outstanding. */
	issues: Issue[]
	/** Today's plan, which may already hold the first task set last night. */
	plan?: DayPlan
	now: number
}

export function briefing(i: BriefingInput): Briefing {
	const past = standup({ entries: i.entries, jobs: i.jobs, tasks: i.tasks, tickets: i.tickets }, i.about)
	const open = i.tasks.filter((t) => t.kind !== 'note' && t.status !== 'done')
	// "Unfinished" means it was already there yesterday — a task added an hour
	// ago is not something you failed to finish.
	const beforeToday = open.filter((t) => istDate(t.createdAt) < i.today)

	return {
		date: i.today,
		about: i.about,
		yesterday: past.yesterday,
		minutes: past.minutes,
		unfinished: beforeToday.map(label),
		suggested: suggest(i, past.yesterday, open),
		planned: i.plan?.todos ?? (i.plan?.firstTask ? [i.plan.firstTask] : []),
		goal: i.plan?.goal,
	}
}

const label = (t: Task) => (t.key ? `${t.key} — ${t.title}` : t.title)
const RANK = { high: 0, normal: 1, low: 2 } as const

/**
 * What to start with, from signals rather than sentiment. The order is the
 * argument: something you decided last night beats something a computer
 * noticed, and an obligation with a deadline beats a preference.
 */
export function suggest(i: BriefingInput, yesterday: StandupLine[], open: Task[]): Suggestion[] {
	const out: Suggestion[] = []
	const add = (title: string, why: string) => {
		if (title && !out.some((s) => s.title === title)) out.push({ title, why })
	}

	// 1. What you said last night. You already made this decision once.
	const lined = i.plan?.todos ?? (i.plan?.firstTask ? [i.plan.firstTask] : [])
	if (lined[0]) add(lined[0], 'You lined this up as your first task yesterday evening')

	// 2. Something overdue that you asked to be reminded about.
	const due = open.filter((t) => t.remindAt != null && t.remindAt <= i.now).sort((a, b) => (a.remindAt ?? 0) - (b.remindAt ?? 0))[0]
	if (due) add(label(due), 'You asked to be reminded about this, and the time has passed')

	// 3. Picking up what you were in the middle of beats starting something new.
	const biggest = yesterday[0]
	const resuming = biggest && open.find((t) => (t.key && biggest.label === t.key) || t.title.includes(biggest.label))
	if (resuming) add(label(resuming), `You spent ${fmtMinutes(biggest.minutes)} on this yesterday`)

	// 4. Obligations with a deadline, before preferences.
	if (i.pendingDays.length) {
		const n = i.pendingDays.length
		add(`Send ${n === 1 ? 'yesterday’s' : `${n} days of`} time logs to Zoho`, `${n} day${n === 1 ? '' : 's'} logged here but never pushed`)
	}
	if (i.issues.length) add(`Fix ${i.issues.length} attendance ${i.issues.length === 1 ? 'day' : 'days'}`, 'Regularisation is still outstanding')

	// 5. Whatever you marked as most important.
	const top = [...open].filter((t) => !t.blocked).sort((a, b) => RANK[a.priority ?? 'normal'] - RANK[b.priority ?? 'normal'] || a.createdAt - b.createdAt)[0]
	if (top) add(label(top), top.priority === 'high' ? 'Your highest-priority open task' : 'The oldest thing still open')

	// Three at most: a longer list is the overwhelm this is meant to remove.
	return out.slice(0, 3)
}

export interface DayReview {
	date: string
	minutes: number
	/** What the day went on, biggest first. */
	worked: StandupLine[]
	/** Finished today. */
	done: string[]
	/** Still open, and worth carrying. */
	open: string[]
	/** Time on the clock that never made it into an entry. */
	unlogged: number
	/** Days whose logs have still not reached Zoho, today included. */
	pendingDays: string[]
	/** Whether the day has already been closed, so the card knows what to offer. */
	checkedOut: boolean
	goal?: string
	verdict?: DayPlan['verdict']
}

export interface ReviewInput extends StandupInput {
	date: string
	/** Minutes between check-in and now (or check-out). */
	elapsed: number
	checkedOut?: boolean
	pendingDays: string[]
	plan?: DayPlan
}

/** The day, said back to you, so closing it is a decision rather than a drift. */
export function dayReview(i: ReviewInput): DayReview {
	const today = standup({ entries: i.entries, jobs: i.jobs, tasks: i.tasks, tickets: i.tickets }, i.date)
	const done = i.tasks.filter((t) => t.kind !== 'note' && t.status === 'done' && t.doneAt != null && istDate(t.doneAt) === i.date)
	const open = i.tasks.filter((t) => t.kind !== 'note' && t.status !== 'done')
	return {
		date: i.date,
		minutes: today.minutes,
		worked: today.yesterday,
		done: done.map(label),
		open: open.map(label),
		unlogged: Math.max(0, i.elapsed - today.minutes),
		pendingDays: i.pendingDays,
		checkedOut: !!i.checkedOut,
		goal: i.plan?.goal,
		verdict: i.plan?.verdict,
	}
}

/** Tomorrow, for carrying the first task forward. */
export const nextDay = (date: string) => addDays(date, 1)
