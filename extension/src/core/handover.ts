// "Can you cover my tickets?"
//
// You go on leave on Friday, or you wake up ill on a Tuesday. Someone has to
// pick up four tickets and has no idea where any of them stands. What they need
// is not a list of ticket numbers — they can get that from Jira. It is the
// links you collected, the thing you found out on Wednesday that is written
// nowhere else, and the sentence that begins "the bit that will catch you out".
//
// All of that is already here: the ticket, its labelled links, its notes by
// day, what you logged against it this week, and what is open. This assembles
// it into the document nobody has time to write on the morning they need it.

import { fmtMinutes } from './time'

export interface HandoverTicket {
	id: string
	name: string
	/** Minutes logged against it in the window, and when you last touched it. */
	minutes: number
	lastAt?: number
	/** What you said about it, most recent first. */
	said: string[]
	links: { title: string; url: string; note?: string }[]
	/** The latest notes under the ticket, newest first. */
	notes: { date: string; text: string }[]
	/** Open tasks that carry this ticket's key. */
	open: string[]
	/** Anything written down as a mistake or a gotcha against it. */
	watchOut: string[]
}

export interface Handover {
	from: string
	to: string
	/** Who is away, if they said. */
	who?: string
	tickets: HandoverTicket[]
	/** Open work that belongs to no ticket. */
	loose: string[]
	/** Meetings someone will have to attend. */
	meetings: { name: string; time: string; days: number[] }[]
}

/** Newest first, and the ones you actually touched first of all. */
export function handover(input: Omit<Handover, 'from' | 'to'> & { from: string; to: string }): Handover {
	return {
		...input,
		tickets: [...input.tickets].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || b.minutes - a.minutes),
	}
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * The document, in the order the person covering reads it: what it is, where it
 * got to, what will catch them out, and then the links. Not the order it
 * happened in — that is a log, and they have twenty minutes.
 */
export function handoverText(h: Handover): string {
	const out: string[] = []
	out.push(`# Cover notes${h.who ? ` — ${h.who}` : ''}`, '', `Away ${h.from === h.to ? h.from : `${h.from} to ${h.to}`}. Everything below was written at the time, while the work was happening.`, '')

	if (!h.tickets.length && !h.loose.length) {
		out.push('Nothing open. Enjoy it.')
		return out.join('\n')
	}

	for (const t of h.tickets) {
		out.push(`## ${t.name}`, '')
		if (t.minutes) out.push(`${fmtMinutes(t.minutes)} on it recently.`, '')
		if (t.said.length) {
			out.push('**Where it got to**', '')
			for (const s of t.said.slice(0, 6)) out.push(`- ${s}`)
			out.push('')
		}
		if (t.watchOut.length) {
			out.push('**What will catch you out**', '')
			for (const w of t.watchOut.slice(0, 6)) out.push(`- ${w}`)
			out.push('')
		}
		if (t.open.length) {
			out.push('**Still to do**', '')
			for (const o of t.open) out.push(`- ${o}`)
			out.push('')
		}
		if (t.links.length) {
			out.push('**Links**', '')
			for (const l of t.links) out.push(`- [${l.note || l.title}](${l.url})`)
			out.push('')
		}
		if (t.notes.length) {
			out.push('**Notes**', '')
			for (const n of t.notes.slice(0, 3)) out.push(`- _${n.date}_ — ${firstLines(n.text)}`)
			out.push('')
		}
	}

	if (h.loose.length) {
		out.push('## Not under a ticket', '')
		for (const l of h.loose) out.push(`- ${l}`)
		out.push('')
	}

	if (h.meetings.length) {
		out.push('## Meetings someone should be at', '')
		for (const m of h.meetings) out.push(`- ${m.name} · ${m.time} · ${m.days.map((d) => DAYS[d - 1]).join(', ')}`)
		out.push('')
	}

	out.push('<sub>From WorkPulse.</sub>')
	return out.join('\n')
}

/** A note can be a page of markdown; cover notes want the first two lines. */
function firstLines(text: string, lines = 2): string {
	const got = text
		.split('\n')
		.map((l) => l.replace(/^#+\s*/, '').trim())
		.filter(Boolean)
		.slice(0, lines)
	return got.join(' · ').slice(0, 240)
}
