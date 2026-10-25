// How long things actually take you.
//
// Everyone knows they underestimate. Nobody has the number. Jira knows a ticket
// moved from one column to another; it has no idea you spent eleven hours on
// it, because nothing was ever asked. WorkPulse has the hours against the
// ticket, in your own words, because it asked every hour and you answered.
//
// So: when you save a ticket, it asks once — how long do you think? — and then
// never mentions it again until there is enough to say something true. Nothing
// here judges. "You run about 1.8×" is a fact you can use at planning; "you are
// bad at estimating" is a thing an app has no business saying.

export interface Estimated {
	/** The ticket, by its key or its id. */
	label: string
	/** What you said it would take, in minutes. */
	estimateMinutes: number
	/** What it actually took. */
	actualMinutes: number
	/** When the last of that work happened, for ordering. */
	at: number
}

export interface Calibration {
	/** How many finished tickets this is based on. */
	count: number
	/** actual ÷ estimate, over all of them together. */
	ratio: number
	/** The middle ticket's ratio — which a single disaster cannot drag. */
	median: number
	/** True once there is enough to be worth saying out loud. */
	ready: boolean
	/** The worst and the best, because both are worth seeing. */
	over?: Estimated
	under?: Estimated
}

/** Below this, a ratio is an anecdote. */
export const ENOUGH = 5

/**
 * The ratio, from everything with both an estimate and real hours against it.
 *
 * Two numbers rather than one: the total ratio answers "how much longer does my
 * work take than I say", and the median answers "what is the typical ticket" —
 * one three-day disaster should not become your planning multiplier.
 */
export function calibrate(list: Estimated[]): Calibration {
	const usable = list.filter((e) => e.estimateMinutes > 0 && e.actualMinutes > 0)
	if (!usable.length) return { count: 0, ratio: 1, median: 1, ready: false }

	const estimate = usable.reduce((n, e) => n + e.estimateMinutes, 0)
	const actual = usable.reduce((n, e) => n + e.actualMinutes, 0)
	const ratios = usable.map((e) => e.actualMinutes / e.estimateMinutes).sort((a, b) => a - b)
	const mid = Math.floor(ratios.length / 2)

	const byRatio = [...usable].sort((a, b) => a.actualMinutes / a.estimateMinutes - b.actualMinutes / b.estimateMinutes)
	return {
		count: usable.length,
		ratio: actual / estimate,
		median: ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2,
		ready: usable.length >= ENOUGH,
		under: byRatio[0],
		over: byRatio[byRatio.length - 1],
	}
}

/** What an estimate of `minutes` is likely to really cost, in your hands. */
export function expect_(c: Calibration, minutes: number): number {
	return Math.round(minutes * (c.ready ? c.median : 1))
}

/**
 * The sentence. Said only when it is true and only when there is enough behind
 * it — and never when the ratio is close enough to one that saying anything
 * would be noise dressed as insight.
 */
export function calibrationLine(c: Calibration): string | null {
	if (!c.ready) return `${ENOUGH - c.count} more estimated ticket${ENOUGH - c.count === 1 ? '' : 's'} and WorkPulse can tell you how long your estimates really take.`
	const m = c.median
	if (m >= 0.9 && m <= 1.15) return `Your estimates land. ${c.count} tickets, within about ${Math.round(Math.abs(1 - m) * 100)}%.`
	if (m > 1.15) return `Your work tends to run about ${m.toFixed(1)}× your estimate, over ${c.count} tickets. Say two days, plan for ${twoDays(m)}.`
	return `You tend to finish in about ${Math.round(m * 100)}% of what you estimate, over ${c.count} tickets.`
}

const twoDays = (m: number) => {
	const d = 2 * m
	return d >= 2.75 ? `${Math.round(d)} days` : `${d.toFixed(1)} days`
}
