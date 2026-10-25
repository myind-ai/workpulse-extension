// Brain entries as Learnings, so the Learnings page and its "keeps coming back"
// count are one list: what you wrote here and what Claude Code recorded.
//
// Kept apart from core/bridge.ts on purpose: the CLI loads that file directly
// with Node's type stripping, which cannot follow extension-less imports, so it
// imports nothing. Pure: no chrome, no fetch.

import type { BridgeEntry } from './bridge'
import type { Learning, LearnKind } from './learn'
import { istDate } from './time'

/** A learning that came from the bridge carries this prefix in its id: read-only here. */
export const BRAIN_ID = 'brain:'
export const fromBrain = (l: Pick<Learning, 'id'>) => l.id.startsWith(BRAIN_ID)

const AS: Partial<Record<BridgeEntry['kind'], LearnKind>> = {
	learning: 'learning',
	mistake: 'mistake',
	skill: 'howto',
	debug: 'howto',
}

/**
 * The entries that read as a learning, a mistake or a how-to. A ticket record,
 * a report or a note is not one — those stay on the Brain page. A ticket key is
 * matched to your saved tickets by the key in their name, so the line links
 * where a local one would.
 */
export function brainLearnings(entries: BridgeEntry[], tickets: { id: string; key: string | null }[] = []): Learning[] {
	const byKey = new Map(tickets.filter((t) => t.key).map((t) => [t.key as string, t.id]))
	const out: Learning[] = []
	for (const e of entries) {
		const kind = AS[e.kind]
		if (!kind) continue
		const why = e.rootCause ? ` — ${e.rootCause}` : ''
		out.push({
			id: `${BRAIN_ID}${e.id}`,
			date: istDate(e.at),
			at: e.at,
			kind,
			text: `${e.title}${why}`,
			tags: e.tags ?? [],
			ticketId: e.ticket ? byKey.get(e.ticket) : undefined,
		})
	}
	return out
}
