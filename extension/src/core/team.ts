// A team, without a server.
//
// A team is one private GitHub repository everyone on it can write to. Each
// member writes only their own file; everyone reads the others'. That is the
// whole mechanism: no accounts to make, no service to trust, nothing running
// anywhere, and the repository is one the team already owns and can delete.
//
// Two rules hold the privacy promise:
//   1. Nothing is shared unless you turn it on. Solo is the default, and
//      "share" is per-kind — the hours you logged, the lines you wrote about
//      them, the learnings. Each off until you say so.
//   2. What leaves is built here, in one function, from an allow-list. Not
//      "everything except the secrets" — only the fields named below. A new
//      field somewhere else in WorkPulse cannot leak by being forgotten about.

export interface TeamSettings {
	/** owner/name of the shared repository. Empty means no team. */
	repo: string
	branch?: string
	/** How you appear to the others. Defaults to the GitHub login. */
	member: string
	/** What you let the others see. All off until chosen. */
	shareHours: boolean
	shareWhat: boolean
	shareLearnings: boolean
}

export const NO_TEAM: TeamSettings = { repo: '', member: '', shareHours: false, shareWhat: false, shareLearnings: false }

/** One member's day, as it appears to everyone else. */
export interface SharedDay {
	date: string
	/** Minutes logged, when hours are shared. */
	minutes?: number
	in?: string
	out?: string
	/** What was worked on, grouped — when that is shared. */
	lines?: { label: string; minutes: number }[]
	/** Learnings, when those are shared. */
	learnings?: { text: string; kind?: string }[]
}

export interface SharedMember {
	member: string
	/** When this file was last written, so a stale member is obvious. */
	at: number
	days: SharedDay[]
}

/** Where a member's file lives. One file each: two people never write the same path. */
export function memberPath(folder: string, member: string): string {
	return `${(folder || 'team').replace(/^\/+|\/+$/g, '')}/members/${slug(member)}.json`
}

export const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'member'

export interface ShareInput {
	member: string
	now: number
	/** Days, newest first, already trimmed to the window being shared. */
	days: {
		date: string
		minutes: number
		in?: string
		out?: string
		lines: { label: string; minutes: number }[]
		learnings: { text: string; kind?: string }[]
	}[]
}

/**
 * What this member publishes — built field by field from what was turned on.
 *
 * Nothing else in WorkPulse reaches the shared repository, which is why this is
 * an allow-list rather than a redaction: no ticket URLs, no note text, no
 * settings, no token, no Zoho anything.
 */
export function shareFile(input: ShareInput, set: TeamSettings): SharedMember {
	return {
		member: input.member,
		at: input.now,
		days: input.days.map((d) => ({
			date: d.date,
			...(set.shareHours ? { minutes: d.minutes, in: d.in, out: d.out } : {}),
			...(set.shareWhat ? { lines: d.lines } : {}),
			...(set.shareLearnings && d.learnings.length ? { learnings: d.learnings } : {}),
		})),
	}
}

export interface BoardRow {
	member: string
	/** Yours is marked, so the board reads as "the team" and not "a list". */
	you: boolean
	minutes?: number
	in?: string
	out?: string
	lines: { label: string; minutes: number }[]
	learnings: { text: string; kind?: string }[]
	/** Nothing written for this date — away, or not sharing. */
	quiet: boolean
	/** When their file was last written at all. */
	at: number
}

/** The team's day, in the order a standup goes round: you first, then by name. */
export function board(files: SharedMember[], date: string, me: string): BoardRow[] {
	const mine = slug(me)
	return files
		.map((f) => {
			const day = f.days.find((d) => d.date === date)
			return {
				member: f.member,
				you: slug(f.member) === mine,
				minutes: day?.minutes,
				in: day?.in,
				out: day?.out,
				lines: day?.lines ?? [],
				learnings: day?.learnings ?? [],
				quiet: !day || (day.minutes == null && !day.lines?.length),
				at: f.at,
			}
		})
		.sort((a, b) => Number(b.you) - Number(a.you) || a.member.localeCompare(b.member))
}

/** What the team did together on a date — for the one line a manager wants. */
export function teamTotals(rows: BoardRow[]): { people: number; logged: number; minutes: number; tickets: { label: string; minutes: number }[] } {
	const by = new Map<string, number>()
	let minutes = 0
	for (const r of rows) {
		minutes += r.minutes ?? 0
		for (const l of r.lines) by.set(l.label, (by.get(l.label) ?? 0) + l.minutes)
	}
	return {
		people: rows.length,
		logged: rows.filter((r) => !r.quiet).length,
		minutes,
		tickets: [...by.entries()].map(([label, m]) => ({ label, minutes: m })).sort((a, b) => b.minutes - a.minutes),
	}
}

// ── keeping it current ──────────────────────────────────────────────────────
//
// "Instant" is the wrong target, and it is worth saying why before building the
// thing that actually works.
//
// A commit per saved entry would be five people × eight entries a day = forty
// commits of noise, a history nobody can read, and four API calls each. Worse,
// every one of those commits moves the same branch, so two people saving at the
// same moment means one of them is rejected and has to start again. The content
// never collides — each person writes only their own file — but the branch
// does.
//
// So: **pushed soon, not instantly.** A change starts a short timer; anything
// else that happens inside it rides along; one commit goes up for the burst.
// Closing the day pushes immediately, because that is the moment the day is
// actually worth reading. The once-a-day push stays as the backstop.
//
// And reading is a poll, which is cheap if it is done properly: one request
// lists the folder with a sha for every file, and only the files whose sha
// moved are fetched. A quiet team costs one request per poll.

/** How long a burst of changes is allowed to gather before it goes up. */
export const SHARE_DEBOUNCE = 2 * 60_000

/** After a failure, how long before trying again. */
const SHARE_RETRY = 10 * 60_000

export function shareDue(s: {
	on: boolean
	now: number
	/** When something last changed that the others would want to see. */
	changedAt?: number
	lastPushAt?: number
	lastTryAt?: number
	/** The day is finished: worth sending at once rather than waiting out the timer. */
	dayClosed?: boolean
}): boolean {
	if (!s.on || s.changedAt == null) return false
	// Nothing has changed since the last push.
	if (s.lastPushAt != null && s.lastPushAt >= s.changedAt) return false
	if (s.lastTryAt != null && s.now - s.lastTryAt < SHARE_RETRY && (s.lastPushAt ?? 0) < (s.lastTryAt ?? 0)) return false
	if (s.dayClosed) return true
	return s.now - s.changedAt >= SHARE_DEBOUNCE
}

/**
 * Which members' files have actually moved, by comparing the shas GitHub hands
 * back with the folder listing. A file whose sha is unchanged is not fetched,
 * so a quiet team costs one request.
 */
export function whoChanged(seen: Record<string, string>, now: { name: string; path: string; sha: string }[]): { fetch: string[]; shas: Record<string, string> } {
	const shas: Record<string, string> = {}
	const fetch: string[] = []
	for (const f of now) {
		if (!f.name.endsWith('.json')) continue
		shas[f.path] = f.sha
		if (seen[f.path] !== f.sha) fetch.push(f.path)
	}
	return { fetch, shas }
}

/** How long to wait between polls, given whether anyone is looking. */
export const POLL_WATCHING = 60_000
export const POLL_BACKGROUND = 15 * 60_000

export function pollDue(s: { now: number; lastPollAt?: number; watching: boolean }): boolean {
	// Never polled: do it now. Waiting a quarter of an hour to find out whether
	// a team exists is the wrong first impression.
	if (s.lastPollAt == null) return true
	return s.now - s.lastPollAt >= (s.watching ? POLL_WATCHING : POLL_BACKGROUND)
}

/** The commit message for a share: short, and about what changed. */
export function shareMessage(member: string, days: number, date: string): string {
	return `team: ${slug(member)} through ${date}${days > 1 ? ` (${days} days)` : ''}`
}
