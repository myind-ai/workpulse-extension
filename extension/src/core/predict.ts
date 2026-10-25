// What the card already knows, before you type anything.
//
// The blank field is where this product dies. Somebody who cannot remember
// what they did at eleven skips the card, and skipping once is how every tool
// anybody has ever tried quietly stopped being used. So the card must never
// arrive empty — and the guess has to be good enough that pressing Enter is
// the honest answer rather than the lazy one.
//
// A ladder, cheapest first. The model is the last rung and an optional one:
// somebody with no key gets a slightly worse guess, never a blank box.
//
//   1. a focus block that just ended — you already said what it was for
//   2. a running timer on a task — you already named it
//   3. the desk agrees with your last entry — you are still on it
//   4. the desk has moved to another ticket — you are on that now
//   5. your last entry, unchanged — the single most likely answer there is
//
// Every rung carries **why**, because a suggestion somebody cannot audit is a
// suggestion they will accept wrongly. "Still on LEAP-19" is checkable at a
// glance. A sentence from nowhere is not.

import { keysIn } from './context'
import { MIN } from './time'

export interface PredictInput {
	/** What you wrote for the previous slot, if anything. */
	lastText?: string
	lastKeys?: string[]
	/** What the block that just ended was for. */
	focusIntent?: string
	/** The task a timer is running against. */
	timerTitle?: string
	/** Titles and urls of what was open during the slot. */
	tabs: { title: string; url: string }[]
	/** A meeting that covered most of the slot. */
	meeting?: string
}

export interface Prediction {
	text: string
	/** Why this, in the second person, short enough to sit under the field. */
	why: string
	/** Whether this is a real reading or only the last entry repeated. */
	strong: boolean
}

/** The ticket most of the open tabs are about, if any one of them is. */
export function deskKey(tabs: { title: string; url: string }[]): string | null {
	const counts = new Map<string, number>()
	for (const t of tabs) {
		if (!/^https?:/.test(t.url)) continue
		for (const k of keysIn(`${t.title} ${t.url}`)) counts.set(k, (counts.get(k) ?? 0) + 1)
	}
	let best: string | null = null
	for (const [k, n] of counts) if (n >= 2 && (best === null || n > counts.get(best)!)) best = k
	return best
}

/**
 * The guess, without a model.
 *
 * Never returns an empty string: the bottom rung is the last entry repeated,
 * which is both the most likely answer and the one that costs nothing to
 * correct.
 */
export function predict(i: PredictInput): Prediction {
	// A meeting covered the slot. Nothing else competes with that.
	if (i.meeting) return { text: `Meeting: ${i.meeting}`, why: 'this slot was mostly a meeting', strong: true }

	if (i.focusIntent?.trim()) {
		return { text: i.focusIntent.trim(), why: 'what you said the block was for', strong: true }
	}
	if (i.timerTitle?.trim()) {
		return { text: i.timerTitle.trim(), why: 'the task your timer is running against', strong: true }
	}

	const desk = deskKey(i.tabs)
	const last = i.lastText?.trim() ?? ''
	const lastKeys = i.lastKeys?.length ? i.lastKeys : keysIn(last)

	if (desk && lastKeys.includes(desk) && last) {
		return { text: last, why: `still on ${desk}`, strong: true }
	}
	if (desk && last && lastKeys.length && !lastKeys.includes(desk)) {
		// The desk moved. Name the ticket and nothing else — inventing what was
		// done on it would be putting words in somebody's mouth.
		return { text: `${desk} — `, why: `your tabs moved to ${desk}`, strong: true }
	}
	if (desk && !last) {
		return { text: `${desk} — `, why: `most of your tabs are ${desk}`, strong: true }
	}
	if (last) return { text: last, why: 'same as last hour', strong: false }
	return { text: '', why: '', strong: false }
}

/**
 * The prompt, for somebody who brought a key.
 *
 * Given page titles and the last few entries, a model writes a better sentence
 * than any rule can. The instructions are the same as everywhere else in this
 * app: use what is there, invent nothing, and if the evidence is thin say
 * something thin rather than something confident.
 */
export const PREDICT_SYSTEM = [
	'You suggest one line for an hourly work log, for an engineer to accept or correct.',
	'',
	'You are given their recent entries and the page titles that were open in the hour.',
	'',
	'Rules:',
	'- ONE short clause. Under 90 characters. No full stop needed.',
	'- Use ONLY what the entries and titles show. Invent no outcome, no result, no progress.',
	'- Keep ticket keys exactly as written.',
	'- If the titles show nothing specific, repeat the most recent entry rather than guessing.',
	'- Never write "worked on" alone. Name the thing.',
	'- No first person. No preamble. No quotes.',
	'',
	'Return ONLY the line.',
].join('\n')

export function predictPrompt(i: PredictInput, recent: string[]): string {
	const titles = i.tabs
		.filter((t) => /^https?:/.test(t.url))
		.slice(0, 12)
		.map((t) => `- ${t.title}`)
		.join('\n')
	return [
		recent.length ? `Recent entries, newest last:\n${recent.map((r) => `- ${r}`).join('\n')}` : '',
		titles ? `Pages open in this hour:\n${titles}` : '',
	]
		.filter(Boolean)
		.join('\n\n')
}

/** A suggestion that came back longer than a log line is not a log line. */
export function usablePrediction(text: string): string | null {
	const one = text.trim().split('\n')[0]?.trim() ?? ''
	if (one.length < 3 || one.length > 120) return null
	// Models like to preface. Strip the preface rather than reject the answer.
	return one.replace(/^(suggestion|line|entry)\s*[:\-—]\s*/i, '').replace(/^["“']|["”']$/g, '').trim() || null
}

// ── the streak, which is a reward and must never become a scold ────────────

export interface Captured {
	/** Hours with something written against them, this week. */
	hours: number
	/** Working days in a row with at least one entry. */
	days: number
	line: string | null
}

/**
 * What answering has actually got you, said once and quietly.
 *
 * Counts what was captured, never what was missed. A streak that reports
 * failures is a guilt trip, and a guilt trip attached to a thing you have to
 * do every hour is uninstalled by Thursday.
 */
export function captured(entries: { date: string; minutes: number; kind: string }[], days: string[]): Captured {
	const work = entries.filter((e) => e.kind === 'work' && e.minutes > 0)
	const hours = Math.round(work.reduce((a, e) => a + e.minutes, 0) / 60)
	const withAny = new Set(work.map((e) => e.date))
	let run = 0
	for (const d of [...days].sort().reverse()) {
		if (!withAny.has(d)) break
		run++
	}
	if (hours < 2) return { hours, days: run, line: null }
	const streak = run >= 3 ? ` · ${run} days running` : ''
	return { hours, days: run, line: `${hours} hour${hours === 1 ? '' : 's'} captured this week${streak}` }
}

// ── when not to ask at all ─────────────────────────────────────────────────

/** Hosts where an interruption lands in front of other people. */
export const CALL_HOSTS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com', 'whereby.com', 'webex.com', 'gather.town']

export interface Moment {
	/** The focused window is fullscreen — a demo, a presentation, a film. */
	fullscreen?: boolean
	/** The active tab, if there is one. */
	activeUrl?: string
	/** A focus block is running. */
	focusing?: boolean
	/** A scheduled meeting is happening now. */
	inMeeting?: boolean
}

/**
 * Why now is a bad time, or null when it is fine.
 *
 * The card is forced and covers the page, which is exactly right at 11am and
 * exactly wrong while somebody is sharing their screen. Deferring costs one
 * slot; landing on a presentation costs the install.
 */
export function badMoment(m: Moment): string | null {
	if (m.fullscreen) return 'fullscreen — a demo or a presentation'
	if (m.activeUrl && CALL_HOSTS.some((h) => safeHost(m.activeUrl!).endsWith(h))) return 'on a call'
	if (m.inMeeting) return 'in a meeting'
	if (m.focusing) return 'in a focus block'
	return null
}

function safeHost(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase()
	} catch {
		return ''
	}
}

/** How long to wait before trying again. Long enough to be out of the way. */
export const DEFER_MINUTES = 10
export const deferUntil = (now: number) => now + DEFER_MINUTES * MIN
