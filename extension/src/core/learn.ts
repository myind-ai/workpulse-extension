// The day's learnings and mistakes. Markdown, tagged, and private: this is the
// one record that cannot live in Jira, because everything in Jira is read by
// your manager, your PM and the audit trail. A mistake written down honestly is
// worth keeping; a mistake written down publicly is a performance review.

export type LearnKind = 'learning' | 'mistake' | 'howto'

export interface Learning {
	id: string
	/** IST date it belongs to — not always the day it was typed. */
	date: string
	at: number
	editedAt?: number
	kind: LearnKind
	text: string
	/** Lower-cased, from #hashtags in the text. */
	tags: string[]
	/** The ticket it came out of, when it came out of one. */
	ticketId?: string
}

export const KIND_LABEL: Record<LearnKind, string> = {
	learning: 'Learned',
	mistake: 'Mistake',
	howto: 'How-to',
}

/** `#flaky-test`, `#ci`, `#mysql_lock` — what makes a month's notes searchable. */
export function tagsOf(text: string): string[] {
	const found = (text ?? '').match(/(?:^|\s)#([a-z0-9][a-z0-9_-]{0,30})/gi) ?? []
	return [...new Set(found.map((t) => t.trim().slice(1).toLowerCase()))]
}

/** Strips the hashtags from a line, for showing text and tags separately. */
export const withoutTags = (text: string) => (text ?? '').replace(/(?:^|\s)#[a-z0-9][a-z0-9_-]{0,30}/gi, '').replace(/\s{2,}/g, ' ').trim()

export interface Repeat {
	tag: string
	count: number
	/** When it was last written down. */
	lastAt: number
}

/**
 * Tags that keep coming back within `days`. The point of writing a mistake down
 * is noticing the third time: a count is a fact, and a fact is harder to argue
 * with than a feeling that this has happened before.
 */
export function repeats(items: Learning[], now: number, days = 30, least = 2): Repeat[] {
	const since = now - days * 86_400_000
	const counts = new Map<string, Repeat>()
	for (const item of items) {
		if (item.at < since || item.kind !== 'mistake') continue
		for (const tag of item.tags) {
			const seen = counts.get(tag)
			counts.set(tag, { tag, count: (seen?.count ?? 0) + 1, lastAt: Math.max(seen?.lastAt ?? 0, item.at) })
		}
	}
	return [...counts.values()].filter((r) => r.count >= least).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
}

/** Every word has to match, so two words narrow the list instead of widening it. */
export function matchLearning(item: Learning, query: string): boolean {
	const q = query.trim().toLowerCase()
	if (!q) return true
	const hay = `${item.text} ${item.tags.join(' ')} ${item.kind} ${item.date}`.toLowerCase()
	return q.split(/\s+/).every((word) => hay.includes(word.replace(/^#/, '')))
}

export interface TagCount {
	tag: string
	count: number
	lastAt: number
}

/** Every tag you have used, most used first — the list to pick from. */
export function allTags(items: Learning[]): TagCount[] {
	const seen = new Map<string, TagCount>()
	for (const item of items) {
		for (const tag of item.tags) {
			const had = seen.get(tag)
			seen.set(tag, { tag, count: (had?.count ?? 0) + 1, lastAt: Math.max(had?.lastAt ?? 0, item.at) })
		}
	}
	return [...seen.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
}

/**
 * Adds or removes `#tag` from the text, so a chip and a typed hashtag are the
 * same thing — one place the tags live, and it is the note itself.
 */
export function toggleTag(text: string, tag: string): string {
	const clean = tag.trim().toLowerCase().replace(/^#/, '')
	if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(clean)) return text
	if (tagsOf(text).includes(clean)) {
		// `\b` would also match inside "#ci-flaky": a tag ends where tag
		// characters end, hyphens and underscores included.
		return (text ?? '')
			.replace(new RegExp(`(^|\\s)#${clean}(?![a-z0-9_-])`, 'gi'), '$1')
			.replace(/[ \t]{2,}/g, ' ')
			.replace(/[ \t]+$/gm, '')
			.replace(/^[ \t]+/, '')
	}
	const body = (text ?? '').replace(/\s+$/, '')
	return body ? `${body} #${clean}` : `#${clean}`
}

/** The notes behind a repeat, oldest first — what you wrote the last two times. */
export function taggedMistakes(items: Learning[], tag: string): Learning[] {
	return items.filter((l) => l.kind === 'mistake' && l.tags.includes(tag)).sort((a, b) => a.at - b.at)
}

/** What a ticket has taught you, newest first. */
export function forTicket(items: Learning[], ticketId: string): Learning[] {
	return items.filter((l) => l.ticketId === ticketId)
}
