// Your own data, in your own repository. WorkPulse keeps everything on this
// machine; this writes a readable copy to a GitHub repo you own so a reinstall,
// a new laptop or a lost profile does not take your year's notes with it.
//
// Pure: what the files are called and what is in them is decided here, so it can
// be tested without a network. lib/github.ts does the talking.

import { learningsCsv, learningsMarkdown, timesheetCsv } from './export'
import { withoutTags, type Learning } from './learn'
import { firstLine } from './markdown'
import { ticketKey } from './links'
import { hhmm, istDate, istTime } from './time'
import type { Entry, Job, Settings } from './types'

/** Everything worth keeping, as the backup sees it. */
export interface Backup {
	version: 1
	exportedAt: number
	settings: Partial<Settings>
	learnings: Learning[]
	tickets: unknown[]
	/** Zoho's job list, so a restored timesheet still names the jobs. */
	jobs: Job[]
	/** Weekly and monthly goals, and each day's goal, plan and verdict. */
	goals: unknown[]
	plans: unknown[]
	/** Regularisation: which days needed fixing, and which you have dealt with. */
	issues: unknown[]
	meetings: unknown[]
	tasks: unknown[]
	entries: Record<string, Entry[]>
	days: unknown[]
	/** What you wrote on a page, kept against its address. */
	pageNotes?: unknown[]
}

/**
 * Settings that are safe to write to a repository. A token, a client id and an
 * email are not: a backup that leaks a credential is worse than no backup.
 */
const SECRET = new Set(['oauthClientId', 'email', 'syncToken', 'syncRepo'])

export function safeSettings(s: Settings): Partial<Settings> {
	return Object.fromEntries(Object.entries(s).filter(([k]) => !SECRET.has(k))) as Partial<Settings>
}

export interface SyncFile {
	path: string
	content: string
	/** The content is already base64: a screenshot, not a document. */
	raw?: boolean
}

/**
 * What a screenshot is called in the repository.
 *
 * `2026-10-16-stage-acme-com-orders-a1b2.jpg` — the day it was taken, the page
 * it is of, and enough of the note's id to be unique. A folder of
 * `screenshot-1.png` tells nobody anything six months later, and six months
 * later is the only time anyone opens it.
 */
export function shotName(n: { id: string; at: number; url: string; title?: string; ticket?: string }, ext = 'jpg'): string {
	let host = ''
	try {
		host = new URL(n.url).hostname.replace(/^www\./, '')
	} catch {
		host = n.url
	}
	// The ticket leads when there is one, so a folder listing groups everything
	// about PAY-3092 together and the date inside that group keeps it in order.
	// Then the name you gave it, because that is the only part of a filename
	// ever written by a person — rename a note to "discount rounding" and the
	// file in the repository is called that too. The site says where, and four
	// characters of the id keep two notes on one page apart.
	return [n.ticket ? slug(n.ticket, 16).toUpperCase() : '', istDate(n.at), slug(host, 28), slug(n.title ?? '', 40), n.id.slice(0, 4)]
		.filter(Boolean)
		.join('-') + `.${ext}`
}

const slug = (s: string, max: number) =>
	(s ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max)
		.replace(/-+$/, '')

/** What the repository holds, so a restore knows what to read back. */
export interface Manifest {
	version: 2
	exportedAt: number
	counts: { days: number; entries: number; learnings: number; tickets: number }
	shards: { meta: string; days: string[]; learnings: string[]; tickets: string[]; plans?: string[]; pageNotes?: string[] }
	/** Where the screenshots are, when they were written. */
	shots?: string
	/** And the recordings, which are their own decision. */
	clips?: string
}

const month = (date: string) => date.slice(0, 7)
const year = (date: string) => date.slice(0, 4)
const json = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`

/**
 * The files to write, split so that a day's backup rewrites a day's worth of
 * bytes.
 *
 * One `backup.json` holding everything is fine on the first day and ruinous on
 * the thousandth: git keeps every version of every file, so rewriting one large
 * document daily grows the repository by its whole size each time. Sharded by
 * month — and by ticket — a normal day touches the current month, the tickets
 * that moved, and nothing else. Last March is written once and never again.
 */
export function filesFor(
	backup: Backup,
	prefix = 'workpulse',
	now = backup.exportedAt,
	withShots = false,
	clips: { id: string; at: number; url: string; title?: string; ticketId?: string; data: string }[] = [],
): SyncFile[] {
	const dir = prefix.replace(/^\/+|\/+$/g, '') || 'workpulse'
	const today = istDate(now)
	const files: SyncFile[] = []

	// ── the machine-readable half, sharded ──────────────────────────────────
	const days = (backup.days as { date?: string }[]).filter((d) => d?.date)
	const months = [...new Set([...Object.keys(backup.entries), ...days.map((d) => d.date!)].map(month))].sort()
	for (const m of months) {
		files.push({
			path: `${dir}/data/days/${m}.json`,
			content: json({
				month: m,
				days: days.filter((d) => month(d.date!) === m),
				entries: Object.fromEntries(Object.entries(backup.entries).filter(([date]) => month(date) === m)),
			}),
		})
	}

	// Notes left on a page, by month like everything else. The screenshots are
	// not in here: a picture belongs in a file of its own, named so that
	// somebody browsing the repository can tell what it is a picture of.
	const notes = (backup.pageNotes ?? []) as { id: string; at: number; url: string; title: string; shot?: string; ticketId?: string; clip?: { id: string } }[]

	// A note filed under a ticket carries its key into every file it owns, so
	// `PAY-3092` finds the lot — in a folder listing, in GitHub's search, in
	// `grep`. The tickets are already in the backup, so nothing extra is read.
	const keyOf = new Map((backup.tickets as { id: string; name: string }[]).map((t) => [t.id, ticketKey(t.name) ?? '']))
	const named = <T extends { ticketId?: string }>(n: T) => ({ ...n, ticket: n.ticketId ? keyOf.get(n.ticketId) || undefined : undefined })
	const noteMonths = [...new Set(notes.map((n) => month(istDate(n.at))))].sort()
	for (const m of noteMonths) {
		files.push({
			path: `${dir}/data/page-notes/${m}.json`,
			content: json(
				notes
					.filter((n) => month(istDate(n.at)) === m)
					// The name goes in only when the file goes in. A record pointing at
					// a picture that was never written is worse than one that admits
					// there is no picture: the first wastes somebody's afternoon.
					.map(({ shot, ...rest }) => ({
						...rest,
						shot: shot && withShots ? shotName(named(rest)) : undefined,
						shotDropped: !!shot && !withShots,
						// Same rule for a recording: named only when it was written.
						clip: rest.clip && clips.some((c) => c.id === rest.clip!.id) ? { ...rest.clip, file: shotName(named(rest), 'webm') } : undefined,
					})),
			),
		})
	}

	// The pictures, each in a file of its own, only when asked for: a few
	// megabytes of JPEG in a repository is a deliberate choice, not a default.
	if (withShots) {
		for (const n of notes) {
			if (!n.shot) continue
			const base64 = n.shot.replace(/^data:image\/\w+;base64,/, '')
			if (base64) files.push({ path: `${dir}/shots/${shotName(named(n))}`, content: base64, raw: true })
		}
	}

	// Recordings are twenty times the size of a picture, so they are their own
	// decision — and the caller hands over only the ones it has already decided
	// to keep.
	for (const c of clips) {
		const base64 = c.data.replace(/^data:[^,]+,/, '')
		if (base64) files.push({ path: `${dir}/clips/${shotName(named(c), 'webm')}`, content: base64, raw: true })
	}

	const learnMonths = [...new Set(backup.learnings.map((l) => month(l.date)))].sort()
	for (const m of learnMonths) {
		files.push({ path: `${dir}/data/learnings/${m}.json`, content: json(backup.learnings.filter((l) => month(l.date) === m)) })
	}

	// One file per ticket: a ticket you have not touched is not rewritten.
	const tickets = backup.tickets as { id: string }[]
	for (const t of tickets) files.push({ path: `${dir}/data/tickets/${t.id}.json`, content: json(t) })

	// Plans are dated, so they shard with everything else dated; goals and issues
	// are small enough to live whole.
	const plans = (backup.plans ?? []) as { date: string }[]
	for (const m of [...new Set(plans.map((p) => month(p.date)))].sort()) {
		files.push({ path: `${dir}/data/plans/${m}.json`, content: json(plans.filter((p) => month(p.date) === m)) })
	}
	files.push({
		path: `${dir}/data/meta.json`,
		content: json({ settings: backup.settings, jobs: backup.jobs, meetings: backup.meetings, tasks: backup.tasks, goals: backup.goals ?? [], issues: backup.issues ?? [] }),
	})

	const manifest: Manifest = {
		version: 2,
		exportedAt: now,
		counts: {
			days: days.length,
			entries: Object.values(backup.entries).reduce((n, list) => n + list.length, 0),
			learnings: backup.learnings.length,
			tickets: tickets.length,
		},
		shards: {
			meta: `${dir}/data/meta.json`,
			days: months.map((m) => `${dir}/data/days/${m}.json`),
			learnings: learnMonths.map((m) => `${dir}/data/learnings/${m}.json`),
			tickets: tickets.map((t) => `${dir}/data/tickets/${t.id}.json`),
			plans: [...new Set(plans.map((p) => month(p.date)))].sort().map((m) => `${dir}/data/plans/${m}.json`),
			pageNotes: noteMonths.map((m) => `${dir}/data/page-notes/${m}.json`),
		},
		// Named in the manifest so a restore knows where to go looking; absent
		// when the pictures were not written, so it does not go looking in vain.
		shots: withShots && notes.some((n) => n.shot) ? `${dir}/shots` : undefined,
		clips: clips.length ? `${dir}/clips` : undefined,
	}
	files.push({ path: `${dir}/index.json`, content: json(manifest) })
	files.push({ path: `${dir}/README.md`, content: readme(backup, now, manifest) })

	// ── the readable half ───────────────────────────────────────────────────
	// Also by month, for the same reason, and under a year so no folder on
	// GitHub ever holds more than a year of files.
	for (const m of learnMonths) {
		const of = backup.learnings.filter((l) => month(l.date) === m)
		files.push({ path: `${dir}/learnings/${m}.md`, content: learningsMarkdown(of, `Learnings — ${m}`) })
	}
	if (backup.learnings.length) files.push({ path: `${dir}/learnings/all.csv`, content: learningsCsv(backup.learnings) })
	if (tickets.length) files.push({ path: `${dir}/tickets.md`, content: ticketsMarkdown(tickets) })

	const thisMonth = Object.values(backup.entries).flat().filter((e) => month(e.date) === month(today))
	if (thisMonth.length) files.push({ path: `${dir}/timesheets/${month(today)}.csv`, content: timesheetCsv(thisMonth, backup.jobs ?? []) })

	const page = dayPage(backup, today)
	if (page) files.push({ path: `${dir}/days/${year(today)}/${today}.md`, content: page })
	return files
}

/**
 * A day, as a page: when you were on the clock, what you logged, what you
 * learned and which tickets moved. Written for the day the backup runs, so the
 * folder fills up one file at a time and `days/` reads as a diary.
 */
export function dayPage(b: Backup, date: string): string | null {
	const entries = (b.entries[date] ?? []).slice().sort((x, y) => x.slotStart - y.slotStart)
	const learned = b.learnings.filter((l) => l.date === date)
	const day = (b.days as { date: string; checkedInAt?: number; checkedOutAt?: number }[]).find((d) => d?.date === date)
	const tickets = (b.tickets as { name: string; updatedAt?: number; at: number }[]).filter((t) => istDate(t.updatedAt ?? t.at) === date)
	if (!entries.length && !learned.length && !tickets.length && !day?.checkedInAt) return null

	const names = new Map((b.jobs ?? []).map((j) => [j.id, j.name]))
	const minutes = entries.filter((e) => e.kind === 'work').reduce((n, e) => n + e.minutes, 0)
	const out = [`# ${date}`, '']

	if (day?.checkedInAt) {
		out.push(`**On the clock** ${istTime(day.checkedInAt)}–${day.checkedOutAt ? istTime(day.checkedOutAt) : '…'} · **logged** ${hhmm(minutes)}`, '')
	}

	if (entries.length) {
		out.push('## Time log', '')
		for (const e of entries) {
			const job = e.jobId ? ` · ${names.get(e.jobId) ?? e.jobId}` : ''
			out.push(`- **${istTime(e.slotStart)}–${istTime(e.slotEnd)}** (${hhmm(e.minutes)})${job} — ${e.text.replace(/\s*\n+\s*/g, ' ')}`)
		}
		out.push('')
	}

	if (learned.length) {
		out.push('## Learned', '')
		for (const l of learned) out.push(`### ${l.kind === 'mistake' ? 'Mistake' : l.kind === 'howto' ? 'How-to' : 'Learned'}${l.tags.length ? ` · ${l.tags.map((t) => `#${t}`).join(' ')}` : ''}`, '', l.text.trim(), '')
	}

	if (tickets.length) {
		out.push('## Tickets that moved', '')
		for (const t of tickets) out.push(`- ${t.name}`)
		out.push('')
	}
	return out.join('\n')
}

function readme(b: Backup, now: number, m: Manifest): string {
	return [
		'# WorkPulse',
		'',
		`Last backup: ${new Date(now).toISOString()}`,
		'',
		`- ${m.counts.learnings} learnings and mistakes`,
		`- ${m.counts.tickets} tickets`,
		`- ${m.counts.days} days, ${m.counts.entries} time log entries`,
		`- ${b.tasks.length} tasks`,
		'',
		'## What is where',
		'',
		'| Path | What |',
		'| --- | --- |',
		'| `days/<year>/<date>.md` | One page per day: hours, what you logged, what you learned |',
		'| `learnings/<month>.md` | Learnings and mistakes, by month |',
		'| `tickets.md` | Every ticket with its links and notes |',
		'| `timesheets/<month>.csv` | The month as logged, for a spreadsheet |',
		'| `data/` | The machine-readable copy WorkPulse restores from |',
		'| `index.json` | Lists what is in `data/` |',
		'',
		'`data/` is split by month, and by ticket, so a day\'s backup rewrites a day\'s',
		'worth of bytes rather than the whole history. Older months are written once',
		'and left alone.',
		'',
		'No tokens, credentials or email addresses are written here.',
		'',
		'---',
		'',
		'Written by [WorkPulse](https://github.com/myind-ai/workpulse-extension) — a free, open-source',
		'Chrome extension that reconstructs your day into timesheets, standups and notes. No server,',
		'no account, nothing leaves your machine except this folder.',
		'',
	].join('\n')
}

function ticketsMarkdown(tickets: unknown[]): string {
	type T = { name: string; tabs?: { title: string; url: string; note?: string }[]; notes?: { date: string; text: string }[]; updatedAt?: number; at?: number }
	const out = ['# Tickets', '']
	for (const t of tickets as T[]) {
		const key = ticketKey(t.name)
		out.push(`## ${t.name}${key ? '' : ''}`, '')
		for (const link of t.tabs ?? []) out.push(`- ${link.note ? `**${link.note}** · ` : ''}[${link.title}](${link.url})`)
		if (t.tabs?.length) out.push('')
		for (const note of t.notes ?? []) out.push(`### ${note.date}`, '', note.text.trim(), '')
	}
	return out.join('\n')
}

/** Enough of a hash to tell "changed" from "unchanged" without storing the file. */
export function digest(text: string): string {
	let h = 5381
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
	return `${(h >>> 0).toString(36)}:${text.length}`
}

/** Only the files whose contents differ from the last push. */
export function changedFiles(files: SyncFile[], seen: Record<string, string> = {}): SyncFile[] {
	return files.filter((f) => seen[f.path] !== digest(f.content))
}

export const digestsOf = (files: SyncFile[]): Record<string, string> => Object.fromEntries(files.map((f) => [f.path, digest(f.content)]))

/**
 * What the recorded hashes belong to. Point the backup at a different
 * repository, branch or folder and they describe files that are not there, so
 * the next push would skip everything it thinks is unchanged. Keying them this
 * way makes that heal itself rather than depending on something clearing them.
 */
export const syncTarget = (repo: string, branch: string, path: string) => `${repo}|${branch || 'default'}|${path || 'workpulse'}`

/** `owner/repo`, however it was pasted — a URL, a clone line, or just the name. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
	const t = (input ?? '').trim().replace(/\.git$/, '')
	const m = t.match(/(?:github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/)
	return m ? { owner: m[1], repo: m[2] } : null
}

export const RETRY_AFTER = 30 * 60_000

/**
 * Whether today's backup is owed: once a day, after the day is wrapped up, and
 * never twice. A backup that fires every tick is a repository of noise.
 *
 * `lastTryAt` is set whether the push worked or not, so a GitHub outage is
 * retried a few times across the evening rather than every single minute.
 */
export function backupDue(s: { on: boolean; now: number; lastPushAt?: number; lastTryAt?: number; dayClosed: boolean; after: number }): boolean {
	if (!s.on) return false
	if (s.lastPushAt != null && istDate(s.lastPushAt) === istDate(s.now)) return false
	if (s.lastTryAt != null && s.now - s.lastTryAt < RETRY_AFTER) return false
	return s.dayClosed || s.now >= s.after
}

/**
 * The commit message: a subject that says what the day amounted to, and a body
 * that says what moved. `git log --oneline` on this repository should read like
 * a year of work, not like a thousand lines saying "backup".
 */
export function commitMessage(b: Backup, now: number, changed: SyncFile[] = []): string {
	const date = istDate(now)
	const entries = (b.entries[date] ?? []).filter((e) => e.kind === 'work')
	const minutes = entries.reduce((n, e) => n + e.minutes, 0)
	const learned = b.learnings.filter((l) => l.date === date)
	const moved = (b.tickets as { name: string; updatedAt?: number; at: number }[]).filter((t) => istDate(t.updatedAt ?? t.at) === date)

	const bits: string[] = []
	if (minutes) bits.push(fmtHours(minutes))
	if (learned.length) bits.push(`${learned.length} learning${learned.length === 1 ? '' : 's'}`)
	if (moved.length) bits.push(`${moved.length} ticket${moved.length === 1 ? '' : 's'}`)
	const subject = `WorkPulse ${date}${bits.length ? ` — ${bits.join(', ')}` : ''}`

	const body: string[] = []
	if (entries.length) body.push(`Logged    ${fmtHours(minutes)} across ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`)
	for (const l of learned) body.push(`${l.kind === 'mistake' ? 'Mistake  ' : l.kind === 'howto' ? 'How-to   ' : 'Learned  '} ${firstLine(withoutTags(l.text), 70)}`)
	for (const t of moved.slice(0, 6)) body.push(`Ticket    ${t.name}`)
	if (moved.length > 6) body.push(`Ticket    …and ${moved.length - 6} more`)
	if (changed.length) body.push('', `${changed.length} file${changed.length === 1 ? '' : 's'} written`)
	return body.length ? `${subject}\n\n${body.join('\n')}\n` : subject
}

const fmtHours = (min: number) => (min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`)

/**
 * GitHub's new-repository page, filled in. The user is already signed in there,
 * so creating it is one click on a form that is already correct — which beats
 * any amount of instructions about what to name it.
 */
export function newRepoUrl(name = 'workpulse-notes'): string {
	const q = new URLSearchParams({
		name,
		description: 'My WorkPulse backup — learnings, tickets and time logs.',
		visibility: 'private',
	})
	return `https://github.com/new?${q}`
}

/** The fine-grained token page. The permission itself has to be chosen by hand. */
export const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'

export type SetupStep = 'repo' | 'token' | 'pick' | 'backup' | 'done'

/**
 * Which step the setup is on, from what is actually true rather than from a
 * counter — so closing the page, or doing a step out of order on GitHub, never
 * leaves the wizard lying about where you are.
 *
 * `madeRepo` is the one thing that cannot be checked: until there is a token,
 * nothing here can see whether the repository exists. Saying "I've created it"
 * is taken at face value, and step 3 confirms it against GitHub's own list.
 */
export function setupStep(s: { madeRepo: boolean; hasToken: boolean; repo: string; lastPushAt?: number }): SetupStep {
	if (!s.madeRepo && !s.hasToken && !s.repo) return 'repo'
	if (!s.hasToken) return 'token'
	if (!s.repo) return 'pick'
	return s.lastPushAt != null ? 'done' : 'backup'
}
