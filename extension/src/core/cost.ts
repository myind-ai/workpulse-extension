// What the week actually costs, and who is spending it.
//
// `weekSplit` already answers "where did the week go" — meetings, deep work,
// switches. It cannot answer the two questions that follow, which are the ones
// somebody can act on:
//
//   WHICH meeting. "Nine hours of meetings" changes nothing; everybody already
//   suspects that. "Sprint review is 46 hours a year" is a thing you can take
//   to the person who runs it.
//
//   WHAT broke the block. You cannot defend a desk whose attacker you cannot
//   name — and nobody can recall, a week later, what pulled them out of a
//   Tuesday afternoon. One tap at the time is the only way this is ever known.
//
// Annualising is the honest multiplier here and not a rhetorical one: a
// recurring meeting genuinely does recur, so the yearly figure is the real
// cost and the weekly one is the understatement everybody quotes.

import { MIN } from './time'

/** Working weeks in a year, with leave and holidays taken off. */
export const WEEKS = 46

export interface MeetingCost {
	id: string
	name: string
	/** Minutes a week, from how it is actually scheduled. */
	perWeek: number
	/** Hours a year, which is the number nobody has worked out. */
	perYear: number
	/** How many people's time it takes, when that is known. */
	heads?: number
	/** Hours a year across everybody in it. */
	teamPerYear?: number
}

export interface Meetingish {
	id: string
	name: string
	logMinutes?: number
	days: number[]
	enabled: boolean
	/** People in the room, if anybody said. */
	heads?: number
}

/**
 * Each recurring meeting, costed.
 *
 * From the schedule rather than from attendance: a meeting you skipped still
 * costs you the hole it leaves in the afternoon, and one you were in but did
 * not log still happened.
 */
export function meetingCosts(list: Meetingish[]): MeetingCost[] {
	return list
		.filter((m) => m.enabled && (m.logMinutes ?? 0) > 0 && m.days.length)
		.map((m) => {
			const perWeek = (m.logMinutes ?? 0) * m.days.length
			const perYear = Math.round(((perWeek * WEEKS) / 60) * 10) / 10
			return {
				id: m.id,
				name: m.name,
				perWeek,
				perYear,
				heads: m.heads,
				teamPerYear: m.heads ? Math.round(perYear * m.heads) : undefined,
			}
		})
		.sort((a, b) => b.perYear - a.perYear)
}

/**
 * The one worth saying out loud, or nothing.
 *
 * One line, about the single most expensive meeting, and only once it is
 * genuinely expensive. A list of every meeting ranked by cost is a thing
 * somebody reads once and resents; one number about one meeting is a thing
 * they can raise on Thursday.
 */
export function meetingLine(costs: MeetingCost[]): string | null {
	const worst = costs[0]
	if (!worst || worst.perYear < 20) return null
	const team = worst.teamPerYear ? ` — ${worst.teamPerYear} hours across everyone in it` : ''
	return `${worst.name} costs you ${worst.perYear} hours a year${team}.`
}

// ── what broke the block ───────────────────────────────────────────────────

/** The handful of things that actually interrupt people, plus a way out. */
export const BREAKERS = ['A message', 'A person', 'A meeting', 'Myself', 'Something broke'] as const
export type Breaker = (typeof BREAKERS)[number]

export interface Interruption {
	what: Breaker
	at: number
	/** The block it happened in, so cost can be attributed. */
	intent?: string
}

export interface Interrupted {
	total: number
	/** Most frequent first. */
	by: { what: Breaker; times: number; share: number }[]
	/** Blocks that ran clean. */
	clean: number
	line: string | null
}

/**
 * What is actually pulling you out, counted.
 *
 * Counts interruptions, never the person — there is no "you were interrupted
 * 14 times, try harder". Most of these are somebody else's doing, and the ones
 * that are not are the only ones worth a decision.
 */
export function interrupted(list: Interruption[], blocks: number): Interrupted {
	const counts = new Map<Breaker, number>()
	for (const i of list) counts.set(i.what, (counts.get(i.what) ?? 0) + 1)
	const total = list.length
	const by = [...counts.entries()]
		.map(([what, times]) => ({ what, times, share: Math.round((times / (total || 1)) * 100) }))
		.sort((a, b) => b.times - a.times)
	const clean = Math.max(0, blocks - new Set(list.map((i) => i.intent ?? '')).size)
	if (total < 3) return { total, by, clean, line: null }
	const top = by[0]
	return {
		total,
		by,
		clean,
		// Named, not scolded. "Myself" is the only one that is a decision.
		line:
			top.what === 'Myself'
				? `${top.times} of ${total} interruptions were you. That is the one you can do something about today.`
				: `${top.what.toLowerCase()} broke ${top.times} of your ${total} interrupted blocks.`,
	}
}

/**
 * What a run of interruptions costs, if a block is worth finishing.
 *
 * Deliberately conservative: fifteen minutes to get back, which is at the low
 * end of every estimate anybody has published. Overstating this would make the
 * number easy to dismiss, and the number is the whole point.
 */
export const RECOVERY_MINUTES = 15

export function recoveryCost(count: number): { minutes: number; line: string | null } {
	const minutes = count * RECOVERY_MINUTES
	if (count < 3) return { minutes, line: null }
	const hours = Math.round((minutes / 60) * 10) / 10
	return { minutes, line: `At a quarter of an hour to get back into it, that is about ${hours} hours of this week spent restarting.` }
}

/** Minutes to instants, for the one place this touches a clock. */
export const recoveryMs = (count: number) => count * RECOVERY_MINUTES * MIN
