// The day, laid out end to end — including the parts nobody wrote anything for.
//
// The review screen shows what you logged. It cannot show what you did not,
// which is exactly the thing somebody is looking for on a Friday: the two
// hours on Tuesday afternoon that are simply missing. A list of entries hides
// a gap, because a gap is an absence of rows and an absence of rows looks like
// the end of the list.
//
// So this builds the whole span from the first punch to the last, and names
// every stretch in it — worked, break, away, or nothing at all. A gap is a
// first-class thing here, with a start and an end, because it is the only kind
// of segment anybody needs to act on.

import { MIN } from './time'

export type SegmentKind = 'work' | 'break' | 'away' | 'gap'

export interface Segment {
	kind: SegmentKind
	from: number
	to: number
	minutes: number
	/** What was written against it, where anything was. */
	text?: string
	jobId?: string
}

export interface TimelineInput {
	/** The day's bounds. Both ends are known by the time this is drawn. */
	from: number
	to: number
	entries: { slotStart: number; slotEnd: number; text: string; kind: 'work' | 'break' | 'skipped'; jobId?: string; minutes: number }[]
	/** Stretches the machine was quiet, as [from, to]. */
	away: [number, number][]
}

/** Anything shorter than this is noise between two things, not a gap. */
export const MIN_GAP = 10 * MIN

/**
 * The day as a list of segments that touch end to end.
 *
 * Entries win over away-spans where they overlap: being away from the keyboard
 * while thinking about a problem you then wrote down is still work, and the
 * person who wrote it down is the better witness than the idle detector.
 */
export function timeline(i: TimelineInput): Segment[] {
	const spans: Segment[] = []

	for (const e of i.entries) {
		if (e.kind === 'skipped' || e.slotEnd <= e.slotStart) continue
		spans.push({
			kind: e.kind === 'break' ? 'break' : 'work',
			from: Math.max(e.slotStart, i.from),
			to: Math.min(e.slotEnd, i.to),
			minutes: e.minutes,
			text: e.text.trim() || undefined,
			jobId: e.jobId,
		})
	}

	// Away only where nothing was logged: the entry is the better witness.
	for (const [a, b] of i.away) {
		const from = Math.max(a, i.from)
		const to = Math.min(b, i.to)
		if (to - from < MIN_GAP) continue
		const clear = spans.every((s) => s.to <= from || s.from >= to)
		if (clear) spans.push({ kind: 'away', from, to, minutes: Math.round((to - from) / MIN) })
	}

	spans.sort((a, b) => a.from - b.from || a.to - b.to)

	// Everything between the known spans, which is the part worth seeing.
	const out: Segment[] = []
	let at = i.from
	for (const s of spans) {
		if (s.from - at >= MIN_GAP) out.push({ kind: 'gap', from: at, to: s.from, minutes: Math.round((s.from - at) / MIN) })
		if (s.from >= at) out.push(s)
		at = Math.max(at, s.to)
	}
	if (i.to - at >= MIN_GAP) out.push({ kind: 'gap', from: at, to: i.to, minutes: Math.round((i.to - at) / MIN) })
	return out
}

/** The one number somebody is looking for: how much of the day is unaccounted. */
export function unaccounted(segs: Segment[]): number {
	return segs.filter((s) => s.kind === 'gap').reduce((a, s) => a + s.minutes, 0)
}

export function accountedFor(segs: Segment[]): { logged: number; gap: number; share: number } {
	const logged = segs.filter((s) => s.kind === 'work' || s.kind === 'break').reduce((a, s) => a + s.minutes, 0)
	const gap = unaccounted(segs)
	const total = logged + gap
	return { logged, gap, share: total ? Math.round((logged / total) * 100) : 100 }
}

/** What to say about a gap, which depends entirely on how long it is. */
export function gapLabel(minutes: number): string {
	if (minutes >= 180) return 'Nothing logged — most of an afternoon'
	if (minutes >= 90) return 'Nothing logged'
	if (minutes >= 45) return 'Nothing logged — about an hour'
	return 'A short gap'
}
