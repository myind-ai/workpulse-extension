// Six months, written up — with every claim traceable to the hour it came from.
//
// This is the feature somebody pays for, and it is also the one that could end
// the product's credibility in a single sentence. A self-assessment containing
// an achievement the person did not actually have is not a bad feature, it is
// a career risk they handed to their employer in writing.
//
// So "cite, or do not claim" is enforced here rather than hoped for. The
// evidence is numbered before it is sent; the model is required to reference
// those numbers; and what comes back is checked line by line. A sentence with
// no citation is surfaced as uncited rather than quietly kept — the person
// reading it then knows exactly which parts are theirs and which the model
// reached for.
//
// It cannot catch a claim that misreads cited evidence. Nothing can, short of
// the person reading it, which is why the draft is always shown beside its own
// sources and never saved anywhere on its own.

import type { PeriodReport, PeriodLine } from './period'

export interface Evidence {
	/** The number the model must cite. One-based, because people read these. */
	n: number
	label: string
	hours: number
	days: number
	from: string
	to: string
	/** What you actually wrote, which is the whole of the evidence. */
	said: string[]
}

/** How many of your own lines go into one piece of evidence. */
const SAID_PER_ITEM = 8

/**
 * The period, numbered.
 *
 * Only the lines with real time behind them: a ticket with forty minutes
 * across six months is noise in a review, and including it invites the model
 * to make something of it.
 */
export function evidenceFrom(r: PeriodReport, minMinutes = 60): Evidence[] {
	return r.lines
		.filter((l: PeriodLine) => l.minutes >= minMinutes && l.said.length > 0)
		.slice(0, 14)
		.map((l, i) => ({
			n: i + 1,
			label: l.name ? `${l.label} — ${l.name}` : l.label,
			hours: Math.round((l.minutes / 60) * 10) / 10,
			days: l.days,
			from: l.first,
			to: l.last,
			said: l.said.slice(0, SAID_PER_ITEM),
		}))
}

export const ASSESS_SYSTEM = [
	'You draft a self-assessment for an engineer, from their own hourly work log.',
	'',
	'You are given numbered evidence. Each item is one strand of work: its hours, the days it spanned, and the lines the person wrote at the time.',
	'',
	'RULES. The first is absolute and the draft is rejected without it:',
	'- EVERY sentence that makes a claim must end with a citation like [1] or [2,5].',
	'- Cite only the numbers you were given. Never invent a number.',
	'- Use ONLY what the evidence says. Invent no metric, no percentage, no outcome, no praise, no business impact.',
	'- If the evidence does not show impact, describe the work and stop. Do not reach.',
	'- Never write that something was "successful", "critical" or "key" unless those words are in the evidence.',
	'- Hours and dates may be stated — they are given to you and are facts.',
	'',
	'SHAPE:',
	'- Three to five short sections, each a "## " heading naming a strand of work.',
	'- Under each, two to four sentences. Plain past tense. British English.',
	'- No preamble, no conclusion, no "In summary".',
	'- First person is fine and expected.',
	'',
	'Return Markdown only.',
].join('\n')

export function assessPrompt(items: Evidence[], from: string, to: string): string {
	const body = items
		.map((e) => [`[${e.n}] ${e.label}`, `    ${e.hours} hours over ${e.days} day${e.days === 1 ? '' : 's'}, ${e.from} to ${e.to}`, ...e.said.map((s) => `    · ${s}`)].join('\n'))
		.join('\n\n')
	return `Period: ${from} to ${to}\n\nEvidence:\n\n${body}`
}

export interface Checked {
	/** The draft as it came back. */
	text: string
	/** Lines making a claim with nothing behind them. */
	uncited: string[]
	/** Citations pointing at evidence that was never given. */
	bogus: number[]
	ok: boolean
}

/** A line that is structure rather than a claim needs no citation. */
function structural(line: string): boolean {
	const t = line.trim()
	if (!t || t.startsWith('#') || t.startsWith('---')) return true
	// A fragment is not a claim. A short bullet usually is a heading in disguise.
	return t.replace(/^[-*]\s*/, '').length < 25
}

/**
 * Every claim checked against the evidence it was given.
 *
 * Mechanical, and therefore honest about its own limits: it proves a sentence
 * *points* at something real, never that it reads it correctly. That second
 * job belongs to the person whose review it is, which is why the draft is
 * shown beside its sources.
 */
export function checkCitations(text: string, count: number): Checked {
	const uncited: string[] = []
	const bogus = new Set<number>()
	for (const raw of text.split('\n')) {
		const line = raw.trim()
		const cites = [...line.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(',').map((x) => Number(x.trim())))
		// A line carrying a citation is making a claim by definition, however
		// short it is — so it is always checked. The structural exemption only
		// ever excuses a line from NEEDING one.
		if (cites.length) {
			for (const n of cites) if (!Number.isInteger(n) || n < 1 || n > count) bogus.add(n)
			continue
		}
		if (structural(line)) continue
		uncited.push(line)
	}
	return { text, uncited, bogus: [...bogus].sort((a, b) => a - b), ok: uncited.length === 0 && bogus.size === 0 }
}

// ── what changed, which is what a raise is argued on ───────────────────────

export interface Growth {
	/** Strands present now that were not there before. */
	gained: string[]
	/** Strands that have gone, which is just as true and usually unsaid. */
	left: string[]
	/** Strands in both, with the hours either side. */
	kept: { label: string; then: number; now: number }[]
	thenHours: number
	nowHours: number
	thenSpan: string
	nowSpan: string
	line: string | null
}

/**
 * Two periods, side by side.
 *
 * A raise is argued on scope having grown, and nobody can remember what their
 * scope was a year ago — which is exactly the thing an hourly log can answer
 * and nothing else can. Facts only: what is new, what has gone, and the hours
 * either side. The argument is the person's to make.
 */
export function scopeGrowth(then: PeriodReport, now: PeriodReport, minMinutes = 60): Growth {
	const real = (r: PeriodReport) => r.lines.filter((l) => l.minutes >= minMinutes)
	const a = new Map(real(then).map((l) => [l.label, l.minutes]))
	const b = new Map(real(now).map((l) => [l.label, l.minutes]))
	const gained = [...b.keys()].filter((k) => !a.has(k))
	const left = [...a.keys()].filter((k) => !b.has(k))
	const kept = [...b.keys()]
		.filter((k) => a.has(k))
		.map((k) => ({ label: k, then: Math.round((a.get(k)! / 60) * 10) / 10, now: Math.round((b.get(k)! / 60) * 10) / 10 }))
	const thenHours = Math.round(then.minutes / 60)
	const nowHours = Math.round(now.minutes / 60)
	return {
		gained,
		left,
		kept,
		thenHours,
		nowHours,
		thenSpan: `${then.from} to ${then.to}`,
		nowSpan: `${now.from} to ${now.to}`,
		// Said only when there is something to say, and never spun.
		line: gained.length
			? `${gained.length} strand${gained.length === 1 ? '' : 's'} of work you were not doing in the earlier period: ${gained.slice(0, 4).join(', ')}.`
			: null,
	}
}
