// Putting it back.
//
// The accident this exists for: "add every tab in this window" on the wrong
// ticket, and now twenty-three links sit among the four you actually collected
// with no way to tell them apart. Nothing was deleted, so nothing felt
// dangerous — and that is exactly the kind of mistake software should be able
// to take back, because the person who made it cannot.
//
// Undo here is a snapshot, not a replayed inverse. Inverses are clever and
// wrong at the edges: the inverse of "add these links" is "remove these links",
// unless one of them was already there, in which case removing it loses
// something you had. A snapshot of the record before the change has no edges.

export type UndoKind = 'ticket' | 'tickets' | 'learning' | 'pageNote' | 'entry'

export interface Undoable<T = unknown> {
	kind: UndoKind
	/** What to say on the button: "Undo adding 23 links". */
	label: string
	at: number
	/** The record as it was. `null` means it did not exist and should go again. */
	before: T
	/** Which record, for the kinds that are addressed by id. */
	id?: string
}

import { ticketKey } from './links'

/** Nothing older than this is worth offering to put back. */
export const UNDO_WINDOW = 10 * 60_000

export function undoOffered(u: Undoable | undefined, now: number): Undoable | null {
	if (!u) return null
	return now - u.at <= UNDO_WINDOW ? u : null
}

/**
 * What the button says. Plain, and about the thing rather than the mechanism —
 * "Undo" on its own leaves you guessing which of the last three things it
 * means.
 */
export function undoLabel(u: Undoable): string {
	return `Undo ${u.label}`
}

/**
 * A ticket, short enough to sit in a button.
 *
 * A saved ticket is usually named by pasting a Jira tab's title, so the name
 * runs to a sentence — "[PAY-2398] SP - Create info icon in CRM pending
 * balance to show which payments make up that balance - Jira". Putting that
 * inside "Undo adding 1 link to …" produced a button three lines deep that
 * squeezed everything beside it.
 *
 * So a name is kept whole while it fits in a button, and falls back to the
 * key — which is what identifies the ticket — once it does not.
 */
export const MAX_TICKET_IN_LABEL = 32

export function shortTicket(name: string): string {
	const one = name.trim().replace(/\s+/g, ' ')
	// A name that already fits is the most useful thing to say: "PAY-2433
	// financing" tells you more than "PAY-2433" and costs nothing.
	if (one.length <= MAX_TICKET_IN_LABEL) return one
	return ticketKey(one) ?? `${one.slice(0, MAX_TICKET_IN_LABEL - 1)}…`
}

/** "23 links added", "the merge", "deleting PAY-2433" — said at the time it happens. */
export function describeAdd(count: number, name: string): string {
	return `adding ${count} link${count === 1 ? '' : 's'} to ${shortTicket(name)}`
}
