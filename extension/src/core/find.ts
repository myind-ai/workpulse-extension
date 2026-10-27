// One search across everything you have written.
//
// You know you wrote it down. You do not know whether it was a ticket note, a
// learning, an hourly entry, a label on a link, or a comment on a page — and
// each of those has its own search box, which is five boxes and four wrong
// guesses. "Where have I seen this error before" is the most common question
// anyone asks their own notes, and it had no answer.

export type HitKind = 'entry' | 'note' | 'learning' | 'ticket' | 'link' | 'task' | 'page' | 'brain'

export interface Hit {
	kind: HitKind
	/** What to show: the line itself, trimmed. */
	text: string
	/** Where it came from, in words: "PAY-2433", "13 Oct". */
	where: string
	date?: string
	at: number
	/** Where clicking takes you. */
	hash?: string
	url?: string
	score: number
}

export interface Haystack {
	entries: { date: string; text: string; slotStart: number }[]
	notes: { ticketId: string; ticketName: string; date: string; text: string; at: number }[]
	learnings: { id: string; date: string; text: string; kind?: string; at?: number }[]
	tickets: { id: string; name: string; at: number }[]
	links: { ticketId: string; ticketName: string; title: string; url: string; note?: string; addedAt?: number }[]
	tasks: { uid: string; title: string; key?: string; status: string; createdAt: number }[]
	pages?: { number: number; title: string; text: string; url: string; at: number }[]
	/** The Brain: what Claude Code and this browser recorded, by any device. */
	brain?: { id: string; title: string; subtitle?: string; kind: string; ticket?: string; more: string; at: number }[]
}

export const KIND_LABEL: Record<HitKind, string> = {
	entry: 'Logged',
	note: 'Ticket note',
	learning: 'Learning',
	ticket: 'Ticket',
	link: 'Link',
	task: 'Task',
	page: 'Note on a page',
	brain: 'Brain',
}

/**
 * Everything matching, best first.
 *
 * Every word has to appear somewhere in the item — an AND, because searching
 * your own notes is a search for one thing you half remember, and an OR buries
 * it. A whole-phrase match and a match at the start both count for more, which
 * is enough ranking to put the obvious answer on top without a scoring game.
 */
export function findAll(query: string, hay: Haystack, limit = 60): Hit[] {
	const q = query.trim().toLowerCase()
	if (q.length < 2) return []
	const words = q.split(/\s+/).filter(Boolean)
	const out: Hit[] = []

	const add = (kind: HitKind, text: string, where: string, at: number, extra: Partial<Hit> = {}, more = '') => {
		const hay = `${text} ${where} ${more}`.toLowerCase()
		if (!words.every((w) => hay.includes(w))) return
		let score = 1
		if (hay.includes(q)) score += 6
		if (text.toLowerCase().startsWith(q)) score += 3
		score += words.filter((w) => text.toLowerCase().includes(w)).length
		out.push({ kind, text: text.trim(), where, at, score, ...extra })
	}

	for (const e of hay.entries) add('entry', e.text, e.date, e.slotStart, { date: e.date, hash: `#/review/${e.date}` })
	for (const n of hay.notes) add('note', n.text, n.ticketName, n.at, { date: n.date, hash: `#/links/${n.ticketId}` })
	for (const l of hay.learnings) add('learning', l.text, l.kind === 'mistake' ? 'Mistake' : 'Learning', l.at ?? 0, { date: l.date, hash: '#/journal' })
	for (const t of hay.tickets) add('ticket', t.name, 'Ticket', t.at, { hash: `#/links/${t.id}` })
	for (const l of hay.links) add('link', l.note || l.title, l.ticketName, l.addedAt ?? 0, { hash: `#/links/${l.ticketId}`, url: l.url })
	for (const t of hay.tasks) add('task', t.title, t.key ?? (t.status === 'done' ? 'Done' : 'Task'), t.createdAt, { hash: '#/tasks' })
	for (const p of hay.pages ?? []) add('page', p.text, p.title, p.at, { url: p.url })
	// Searched in full — body, root cause, next action — but shown by title,
	// which is what a Brain entry is written to be found by.
	for (const b of hay.brain ?? []) add('brain', b.subtitle ? `${b.title} — ${b.subtitle}` : b.title, [b.kind, b.ticket].filter(Boolean).join(' · '), b.at, { hash: b.ticket ? `#/brain/${b.ticket}` : '#/brain' }, b.more)

	return out.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, limit)
}

/** How many of each kind matched, for the filter row. */
export function countKinds(hits: Hit[]): { kind: HitKind; count: number }[] {
	const by = new Map<HitKind, number>()
	for (const h of hits) by.set(h.kind, (by.get(h.kind) ?? 0) + 1)
	return [...by.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count)
}
