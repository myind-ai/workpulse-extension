// Work that is not moving, and what that costs.
//
// Two kinds, and they feel different.
//
// **Waiting** is work you finished. The PR is up, the review has not happened,
// and three days later somebody asks why PAY-3092 is not done. The honest
// answer — "four of those six days I was here, working on other things, waiting
// on you" — has never had any evidence behind it. A tracker knows the ticket sat
// in a column; it does not know you were available the whole time. WorkPulse
// knows both, and this is the only number in the app that is really about
// somebody else.
//
// **Started and stopped** is work you did not finish. A ticket with three saved
// links, half a note and a screenshot, and nothing logged against it for a
// fortnight. Each one is a small unpaid debt you have forgotten, and one of them
// is about to become urgent.
//
// Neither is a telling-off. Both are facts with dates on them.

import { ticketKey } from './links'
import { addDays } from './time'

export interface WaitingItem {
	/** The task, as you wrote it. */
	title: string
	key?: string
	/** Days since it was marked blocked, or since it was last worked on. */
	days: number
	/** Of those days, the ones you were actually at work. */
	hereDays: number
	/** Minutes you had already put into it before it stopped. */
	minutes: number
	since?: string
}

export interface WaitingInput {
	today: string
	tasks: { uid: string; title: string; key?: string; status: string; kind?: string; blocked?: boolean; blockedAt?: number; createdAt: number }[]
	/** Work logged, by date, with the text — for matching a ticket key. */
	entries: { date: string; text: string; minutes: number }[]
	/** The working days you were present, most recent first. */
	workedDays: string[]
	dateOf: (at: number) => string
}

const between = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000))

/**
 * What is blocked, how long, and how much of that time you were here for.
 *
 * "Here for" is the part that matters. Three days blocked over a weekend is not
 * the same complaint as three days blocked while you sat at your desk with
 * nothing to do about it.
 */
export function waitingOn(i: WaitingInput): WaitingItem[] {
	const open = i.tasks.filter((t) => t.kind !== 'note' && t.status !== 'done' && t.blocked)
	return open
		.map((t) => {
			const since = i.dateOf(t.blockedAt ?? t.createdAt)
			// The key as it was stored, or as it is written in the title — a task
			// captured as "PAY-3092 master-key ACL" carries its key in plain sight
			// whether or not anything parsed it at the time.
			const key = t.key ?? ticketKey(t.title) ?? undefined
			const mine = key ? i.entries.filter((e) => ticketKey(e.text) === key) : []
			return {
				title: t.title,
				key,
				days: between(since, i.today),
				hereDays: i.workedDays.filter((d) => d >= since && d <= i.today).length,
				minutes: mine.reduce((n, e) => n + e.minutes, 0),
				since,
			}
		})
		.sort((a, b) => b.days - a.days)
}

/** The one line worth saying about all of it. Nothing when there is nothing. */
export function waitingLine(items: WaitingItem[]): string | null {
	if (!items.length) return null
	const worst = items[0]
	const days = worst.hereDays || worst.days
	const rest = items.length - 1
	return `${worst.key ?? worst.title} has been waiting ${days} working day${days === 1 ? '' : 's'}${rest ? ` · ${rest} more waiting` : ''}.`
}

export interface StaleTicket {
	id: string
	name: string
	/** What is already invested in it: links, notes, a screenshot. */
	links: number
	notes: number
	/** Days since anything was logged against it. */
	quietDays: number
	/** Minutes ever logged — zero means it was collected and never started. */
	minutes: number
}

export interface StaleInput {
	today: string
	tickets: { id: string; name: string; at: number; updatedAt?: number; archivedAt?: number; tabs: unknown[]; notes?: unknown[] }[]
	entries: { date: string; text: string; minutes: number }[]
	dateOf: (at: number) => string
	/** How long is long enough to count as stopped. */
	after?: number
}

/**
 * Tickets you collected material on and then walked away from.
 *
 * The test is deliberately "has something in it" rather than "exists": a ticket
 * with nothing saved under it is not abandoned work, it is a name. Something
 * saved, and then silence, is the thing worth a second look.
 */
export function startedAndStopped(i: StaleInput): StaleTicket[] {
	const after = i.after ?? 10
	return i.tickets
		.filter((t) => !t.archivedAt && (t.tabs.length > 0 || (t.notes?.length ?? 0) > 0))
		.map((t) => {
			const key = ticketKey(t.name)
			const mine = key ? i.entries.filter((e) => ticketKey(e.text) === key) : []
			const lastLogged = mine.map((e) => e.date).sort().at(-1)
			const touched = lastLogged ?? i.dateOf(t.updatedAt ?? t.at)
			return {
				id: t.id,
				name: t.name,
				links: t.tabs.length,
				notes: t.notes?.length ?? 0,
				quietDays: between(touched, i.today),
				minutes: mine.reduce((n, e) => n + e.minutes, 0),
			}
		})
		.filter((t) => t.quietDays >= after)
		.sort((a, b) => b.quietDays - a.quietDays)
}

/**
 * A saved link that has gone quiet — the no-API version of "that PR has been
 * open for nine days".
 *
 * Reading a pull request's state would mean a token for every repository
 * anybody works in, which is a price not worth paying for a reminder. The
 * useful half needs nothing: *you saved this nine days ago and have not logged
 * against its ticket for six*.
 */
export function quietLinks(i: StaleInput & { kinds?: string[] }): { ticket: string; ticketId: string; title: string; url: string; days: number; quietDays: number }[] {
	const stale = new Map(startedAndStopped({ ...i, after: 0 }).map((t) => [t.id, t.quietDays]))
	const out: { ticket: string; ticketId: string; title: string; url: string; days: number; quietDays: number }[] = []
	for (const t of i.tickets) {
		if (t.archivedAt) continue
		for (const tab of t.tabs as { title: string; url: string; note?: string; addedAt?: number }[]) {
			// Only the kinds of link that are supposed to move: a PR, a build.
			// A doc sitting still is a doc.
			const label = `${tab.note ?? ''} ${tab.url}`.toLowerCase()
			if (!(i.kinds ?? ['pull', 'merge_request', '/pr/']).some((k) => label.includes(k))) continue
			if (!tab.addedAt) continue
			const days = between(i.dateOf(tab.addedAt), i.today)
			const quiet = stale.get(t.id) ?? days
			if (days >= 3 && quiet >= 3) out.push({ ticket: t.name, ticketId: t.id, title: tab.note || tab.title, url: tab.url, days, quietDays: quiet })
		}
	}
	return out.sort((a, b) => b.days - a.days)
}

/** The working days in a window, for "you were here for all of them". */
export function daysBack(today: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => addDays(today, -i))
}
