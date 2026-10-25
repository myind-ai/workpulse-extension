// Reconstructing an hour from the pages that were open in it.
//
// The hourly prompt asks "what did you work on?" and the honest answer is often
// "I cannot remember, it was an hour ago". The browser does remember. This turns
// a list of visits into a few lines you can accept, edit or ignore — it never
// writes an entry by itself, because a page you had open is evidence of what you
// were doing, not a statement of it.
//
// Nothing here touches chrome.history: it takes visits and returns groups, so
// what counts as "working on PAY-2433" is testable without a browser.

import { keysIn } from './links'

export interface Visit {
	url: string
	title: string
	/** When the visit started. */
	at: number
}

export interface Activity {
	/** A ticket key where one was found, otherwise the site. */
	label: string
	/** Estimated minutes, from the gap to the next visit. */
	minutes: number
	/** Page titles, most time first, de-duplicated. */
	titles: string[]
	urls: string[]
	/** True when the label came from a ticket key rather than a host name. */
	ticket: boolean
}

/**
 * A tab left open overnight is not eight hours of work. Half an hour is as long
 * as one page can honestly claim: longer than that and you were almost certainly
 * somewhere else with it still open.
 */
export const MAX_VISIT_MIN = 30

const IGNORE =
	/^(chrome|chrome-extension|about|edge|brave|file|devtools):|^https?:\/\/(localhost:\d+\/__|www\.google\.[a-z.]+\/(search|url)|duckduckgo\.com|mail\.google\.com\/chat)/i

export function site(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '')
	} catch {
		return url.slice(0, 40)
	}
}

/**
 * The hour, grouped. A visit is worth the gap to the next one, capped — the
 * browser records when you arrived, never when you left, and treating the last
 * visit of a slot as "until the end" is the only honest reading of it.
 */
export function activity(visits: Visit[], from: number, to: number, prefixes: string[] = []): Activity[] {
	const inSlot = visits
		.filter((v) => v.at >= from && v.at < to && !IGNORE.test(v.url))
		.sort((a, b) => a.at - b.at)
	const groups = new Map<string, Activity>()

	for (const [i, v] of inSlot.entries()) {
		const next = inSlot[i + 1]?.at ?? to
		const minutes = Math.min(MAX_VISIT_MIN, Math.max(1, Math.round((next - v.at) / 60_000)))
		const key = keysIn(`${v.title} ${v.url}`, prefixes)[0]
		const label = key ?? site(v.url)
		const g = groups.get(label) ?? { label, minutes: 0, titles: [], urls: [], ticket: !!key }
		g.minutes += minutes
		const title = (v.title || v.url).trim()
		if (title && !g.titles.includes(title)) g.titles.push(title)
		if (!g.urls.includes(v.url)) g.urls.push(v.url)
		groups.set(label, g)
	}

	return [...groups.values()]
		// A ticket beats a site at the same weight: it is the more useful answer.
		.sort((a, b) => b.minutes - a.minutes || Number(b.ticket) - Number(a.ticket))
		.filter((g) => g.minutes >= 2)
}

/**
 * A first draft of the entry text. Deliberately plain, and deliberately short:
 * it is a prompt for your own sentence, not a replacement for it.
 */
export function draft(groups: Activity[], limit = 3): string {
	const parts = groups.slice(0, limit).map((g) => (g.ticket ? g.label : g.titles[0] ?? g.label))
	return parts.join('; ')
}

/** Ticket keys the hour touched, for offering to file the links under them. */
export const ticketsIn = (groups: Activity[]) => groups.filter((g) => g.ticket).map((g) => g.label)
