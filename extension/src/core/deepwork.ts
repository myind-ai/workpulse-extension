// Deep work: a block of time with one thing in it.
//
// The timer was never the hard part. What makes a block deep rather than merely
// long is that you decided what it was for before it started, nothing else was
// allowed to speak during it, and you said what came of it at the end. The
// timer is just what holds those three together.
//
// What this does not do is lock you out of anything. A blocker you can turn off
// is theatre, and a blocker you cannot is a thing you uninstall at the worst
// possible moment. It says "you are in a block, this is not it" and gets out of
// the way — which is all a person who has caught themselves needs.

import { fmtMinutes, MIN } from './time'

export interface Session {
	startedAt: number
	endsAt: number
	/** What this block is for, in your words. The single best predictor of it working. */
	intent?: string
	taskUid?: string
	/** Hosts you opened mid-block that you had said were not work. */
	strayed?: { host: string; at: number }[]
	/**
	 * What pulled you out, when you said.
	 *
	 * Recorded at the time or not at all: nobody can recall, a week later,
	 * what broke a Tuesday afternoon — and you cannot defend a desk whose
	 * attacker you cannot name.
	 */
	broke?: { what: string; at: number }[]
	/** Times it was extended, so "25 minutes" does not quietly become three hours. */
	extended?: number
}

export const LENGTHS = [25, 50, 90] as const

/** Minutes left, never negative. */
export const leftOf = (s: Session, now: number) => Math.max(0, Math.round((s.endsAt - now) / MIN))

/** How far through, for a ring or a bar. */
export const progressOf = (s: Session, now: number) => {
	const whole = s.endsAt - s.startedAt
	return whole <= 0 ? 1 : Math.min(1, Math.max(0, (now - s.startedAt) / whole))
}

/**
 * The hosts a focus block should quietly object to.
 *
 * Defaults nobody will argue with, and a list of your own on top. Matching is
 * on the registrable-ish tail of the host so `www.reddit.com` and
 * `old.reddit.com` are the same place.
 */
export const DEFAULT_STRAY = ['facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'reddit.com', 'youtube.com', 'netflix.com', 'tiktok.com', 'news.ycombinator.com', 'linkedin.com']

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
	} catch {
		return ''
	}
}

/**
 * Which entry on the list this is, or nothing.
 *
 * The matched entry rather than the host, because `old.reddit.com` and
 * `www.reddit.com` are one place you keep going back to — and a nudge that
 * fires again for every subdomain is a nudge that gets switched off.
 */
export function strayMatch(url: string, list: string[] = DEFAULT_STRAY): string | null {
	const host = hostOf(url)
	if (!host) return null
	for (const d of list) {
		const want = d.trim().toLowerCase().replace(/^www\./, '')
		if (want && (host === want || host.endsWith(`.${want}`))) return want
	}
	return null
}

/** Is this somewhere you said was not work? */
export const isStray = (url: string, list: string[] = DEFAULT_STRAY) => strayMatch(url, list) != null

/**
 * What the nudge says. It is one line, it never blocks, and it does not tell
 * you off — the point is to make the decision conscious, and you have already
 * made it conscious by reading this far.
 */
export function strayLine(session: Session, now: number, host: string): string {
	const left = leftOf(session, now)
	const what = session.intent ? `“${session.intent}”` : 'a focus block'
	return `${host} — you are ${left} minutes into ${what}.`
}

/**
 * A block on the calendar, not on your willpower.
 *
 * This is the change that makes deep work actually happen: the people who get
 * it reliably are not the ones with more discipline, they are the ones for whom
 * 10:00 on a Tuesday was already spoken for. A booked block behaves exactly
 * like a recurring meeting — because that is what it is, one with yourself.
 */
export interface Booked {
	id: string
	/** "10:00" IST. */
	time: string
	minutes: number
	/** 1 = Monday … 7 = Sunday. */
	days: number[]
	/** What it is usually for. Asked once, reused every day. */
	intent?: string
	enabled: boolean
	/** The day it last spoke, so it is offered once. */
	offeredOn?: string
}

/** Past this long after the start, offering it is pointless. */
const BLOCK_STALE = 15 * MIN

/**
 * The booked block to offer right now.
 *
 * Offered, never started: a block that begins without you is a timer running in
 * a tab you are not in. It asks, and asking at the right minute is the whole
 * trick.
 */
export function dueBlock(list: Booked[], now: number, at: (time: string) => number, date: string, weekday: number, lead = 2): Booked | null {
	for (const b of list) {
		if (!b.enabled || b.offeredOn === date || !b.days.includes(weekday)) continue
		const starts = at(b.time)
		if (now >= starts - lead * MIN && now < starts + BLOCK_STALE) return b
	}
	return null
}

/** When this block next speaks, so the list can say it out loud. */
export function nextBlockAt(b: Booked, now: number, at: (date: string, time: string) => number, dateOf: (shift: number) => string, weekdayOf: (date: string) => number): number | null {
	if (!b.enabled || !b.days.length) return null
	for (let i = 0; i < 8; i++) {
		const date = dateOf(i)
		if (!b.days.includes(weekdayOf(date))) continue
		const starts = at(date, b.time)
		if (starts + BLOCK_STALE > now && !(i === 0 && b.offeredOn === date)) return starts
	}
	return null
}

/**
 * What to put in a block, when you have not said.
 *
 * Deep work is only deep if it is spent on the thing that matters, and the
 * thing that matters is already written down: today's goal, what you planned
 * last night, the task you marked high. An empty box at the moment you finally
 * have momentum is how a block gets spent on email.
 */
export function suggestIntent(i: {
	goal?: string
	planned?: string[]
	tasks?: { title: string; key?: string; priority?: string; blocked?: boolean }[]
	running?: string
}): { text: string; why: string }[] {
	const out: { text: string; why: string }[] = []
	if (i.running) out.push({ text: i.running, why: 'the timer is already on it' })
	if (i.goal) out.push({ text: i.goal, why: "today's goal" })
	for (const t of i.planned ?? []) out.push({ text: t, why: 'you planned it last night' })
	for (const t of (i.tasks ?? []).filter((t) => !t.blocked && t.priority === 'high')) {
		out.push({ text: t.key ? `${t.key}: ${t.title}` : t.title, why: 'marked high' })
	}
	for (const t of (i.tasks ?? []).filter((t) => !t.blocked && t.priority !== 'high')) {
		out.push({ text: t.key ? `${t.key}: ${t.title}` : t.title, why: 'open' })
	}
	return out.filter((x, n, all) => x.text.trim() && all.findIndex((y) => y.text === x.text) === n).slice(0, 4)
}

export interface DeepStats {
	/** Minutes of focus in the window. */
	minutes: number
	sessions: number
	/** Blocks that ran to the end rather than being stopped early. */
	finished: number
	/** The longest unbroken block. */
	longest: number
	/** Minutes per day, newest last, for a small bar chart. */
	byDay: { date: string; minutes: number }[]
}

export interface DoneSession {
	date: string
	minutes: number
	finished: boolean
	intent?: string
}

export function deepStats(list: DoneSession[], from: string, to: string): DeepStats {
	const inRange = list.filter((s) => s.date >= from && s.date <= to)
	const by = new Map<string, number>()
	for (const s of inRange) by.set(s.date, (by.get(s.date) ?? 0) + s.minutes)
	return {
		minutes: inRange.reduce((n, s) => n + s.minutes, 0),
		sessions: inRange.length,
		finished: inRange.filter((s) => s.finished).length,
		longest: inRange.reduce((n, s) => Math.max(n, s.minutes), 0),
		byDay: [...by.entries()].map(([date, minutes]) => ({ date, minutes })).sort((a, b) => a.date.localeCompare(b.date)),
	}
}

/**
 * One line about the week, said only when there is something in it.
 *
 * Deliberately not a target: nobody knows how many hours of deep work a week
 * should contain, and an app that invents a number and then measures you
 * against it is an app making things up.
 */
export function deepLine(s: DeepStats): string | null {
	if (!s.sessions) return null
	const ran = s.finished === s.sessions ? 'all of them to the end' : `${s.finished} of ${s.sessions} to the end`
	return `${fmtMinutes(s.minutes)} of focus across ${s.sessions} block${s.sessions === 1 ? '' : 's'} — ${ran}. Longest ${fmtMinutes(s.longest)}.`
}
