// One desk, one job — made mechanical.
//
// The failure this exists for is not "too many tabs". It is **context
// collision**: you are on task A with twelve tabs, something interrupts, you
// start task B and open eight more, and now neither task has a desk. You come
// back to A and cannot tell which tabs were A's. By six o'clock there are
// forty tabs, four half-finished jobs, and no answer to what you did.
//
// It costs three separate things, and only the first is ever talked about:
//
//   - the switch itself, which everyone knows about
//   - the **recovery**, rebuilding the state you had before the switch
//   - the **outcome**, because nothing finishes when everything is half-open
//
// The fix is not fewer tabs. It is that a context is a thing with a name, and
// only one of them is on the desk at a time. Park the one you are leaving —
// its tabs are kept under it and taken off the screen — and resume it later,
// whole. The tabs were never the problem; losing which ones belonged together
// was.
//
// Pure. What belongs to a context, and what is drifting from it, is decided
// here and tested without a browser.

import { hostOf } from './deepwork'

export interface Tab {
	id: number
	title: string
	url: string
	pinned?: boolean
}

export interface Context {
	id: string
	name: string
	/** What this context is for, in your words. The intent of the block. */
	intent?: string
	/** The links it already owns — a ticket's PR, its stage page, its doc. */
	urls: string[]
	/** When it was last on the desk. */
	lastAt?: number
	/**
	 * Whether somebody said this is what they are doing, or whether it is only
	 * what the desk looks like.
	 *
	 * The distinction decides what may be said out loud. A `stated` context is
	 * a promise, so naming a tab that breaks it is holding somebody to their
	 * own word. An `observed` one is an inference the app made — it has no
	 * standing to call anything a departure, only to describe the room.
	 */
	kind?: 'stated' | 'observed'
}

export type Verdict = 'belongs' | 'drifting' | 'unknown'

/** Ticket keys, which are the strongest signal a tab belongs to a context. */
export function keysIn(s: string): string[] {
	return [...new Set((s.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g) ?? []))]
}

/**
 * Does this tab belong to this context?
 *
 * Three signals, in order of how much they are worth:
 *
 *   1. a ticket key shared with the context's name, intent or links — decisive
 *   2. a host the context already owns — strong, because a context's links are
 *      the ones somebody deliberately collected
 *   3. nothing — **unknown, not drifting**
 *
 * That last distinction is the whole honesty of this function. A tab it cannot
 * place is a tab it cannot place; calling it a distraction would make the
 * feature a nag, and a nag that is wrong a third of the time gets switched off
 * in a week.
 */
export function verdictFor(tab: Tab, c: Context): Verdict {
	if (!/^https?:/.test(tab.url)) return 'unknown'
	const mine = new Set([...keysIn(c.name), ...keysIn(c.intent ?? ''), ...c.urls.flatMap((u) => keysIn(u))])
	const theirs = keysIn(`${tab.title} ${tab.url}`)
	if (theirs.length && theirs.some((k) => mine.has(k))) return 'belongs'
	// A key that belongs to a *different* ticket is the clearest drift there is.
	if (theirs.length && mine.size) return 'drifting'
	const hosts = new Set(c.urls.map(hostOf).filter(Boolean))
	if (hosts.has(hostOf(tab.url))) return 'belongs'
	return 'unknown'
}

export interface Spread {
	belongs: Tab[]
	drifting: Tab[]
	unknown: Tab[]
	/** How much of what is on screen is placeable at all. */
	placed: number
}

export function spread(tabs: Tab[], c: Context): Spread {
	const belongs: Tab[] = []
	const drifting: Tab[] = []
	const unknown: Tab[] = []
	for (const t of tabs) {
		const v = verdictFor(t, c)
		;(v === 'belongs' ? belongs : v === 'drifting' ? drifting : unknown).push(t)
	}
	const total = tabs.length || 1
	return { belongs, drifting, unknown, placed: Math.round(((belongs.length + drifting.length) / total) * 100) }
}

/**
 * The context the desk itself implies, when nobody has declared one.
 *
 * Outside a focus block there is no promise to check, so the only honest
 * reading is what is actually in front of you: the ticket most of the tabs
 * are about. One tab is not a context — a key has to appear at least twice
 * before the desk can be said to be "about" anything.
 *
 * `recent` breaks a tie, newest first: two tickets with two tabs each is a
 * genuine ambiguity, and the one you wrote about most recently is the better
 * guess than whichever sorts first.
 */
export function inferContext(tabs: Tab[], recent: string[] = []): Context | null {
	const counts = new Map<string, number>()
	for (const t of tabs) {
		if (!/^https?:/.test(t.url)) continue
		for (const k of keysIn(`${t.title} ${t.url}`)) counts.set(k, (counts.get(k) ?? 0) + 1)
	}
	let best: string | null = null
	for (const [k, n] of counts) {
		if (n < 2) continue
		const better =
			best === null ||
			n > counts.get(best)! ||
			// Same count: whichever you touched most recently.
			(n === counts.get(best)! && recent.indexOf(k) !== -1 && (recent.indexOf(best) === -1 || recent.indexOf(k) < recent.indexOf(best)))
		if (better) best = k
	}
	if (!best) return null
	return {
		id: `observed:${best}`,
		name: best,
		kind: 'observed',
		urls: tabs.filter((t) => keysIn(`${t.title} ${t.url}`).includes(best!)).map((t) => t.url),
	}
}

/**
 * What to say about the spread, or nothing at all.
 *
 * Nothing at all is the common case and the correct one. A line that appears
 * every time you glance at the window is furniture within a day.
 *
 * What may be said depends on where the context came from. Against a block
 * somebody declared, a different ticket is a departure from their own stated
 * plan and can be named as one. Against a context the app merely inferred, it
 * is not a departure from anything — so the line describes the room and
 * suggests nothing, and it waits for more evidence before speaking at all.
 */
export function driftLine(s: Spread, c: Context): string | null {
	const observed = c.kind === 'observed'
	// A higher bar when nothing was promised: there is no plan to be off.
	if (s.drifting.length < (observed ? 3 : 2)) return null
	const keys = [...new Set(s.drifting.flatMap((t) => keysIn(`${t.title} ${t.url}`)))].slice(0, 2)
	const what = keys.length ? keys.join(' and ') : 'something else'
	return observed
		? `This desk is mostly ${c.name}. ${s.drifting.length} tabs on it are ${what}.`
		: `${s.drifting.length} tabs here are ${what}, not ${c.name}. Park this and switch, or leave them — but know they are there.`
}

/** Tabs it is safe to take off the screen. Never a pinned one, never ours. */
export function parkable(tabs: Tab[], mine: string): Tab[] {
	return tabs.filter((t) => !t.pinned && /^https?:/.test(t.url) && !t.url.startsWith(mine))
}

/**
 * The number nobody has.
 *
 * Not "you have 40 tabs open" — everybody knows that and it changes nothing.
 * This is how many separate jobs are on one desk, which is the thing that
 * actually predicts a day ending with four half-finished tasks.
 */
export function deskLoad(tabs: Tab[]): { tabs: number; jobs: number; line: string | null } {
	const keys = new Set(tabs.flatMap((t) => keysIn(`${t.title} ${t.url}`)))
	const jobs = keys.size
	if (tabs.length < 12 || jobs < 3) return { tabs: tabs.length, jobs, line: null }
	return {
		tabs: tabs.length,
		jobs,
		line: `${tabs.length} tabs, ${jobs} different tickets. That is ${jobs} jobs on one desk.`,
	}
}

/**
 * The outcome a context closes with.
 *
 * A block that ends by simply stopping teaches nothing and logs nothing. One
 * sentence about what came of it is the entry for that hour and the evidence
 * six months later — and it is the only part of this pattern that makes the
 * work *outcome-based* rather than merely tidy.
 */
export function closingPrompt(c: Context, minutes: number): string {
	const span = minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10} hours` : `${minutes} minutes`
	return c.intent ? `${span} on ${c.name}. You said: “${c.intent}”. What came of it?` : `${span} on ${c.name}. What came of it?`
}
