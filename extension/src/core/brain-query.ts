// Search filters for the Brain, and which entries belong to the page you are on.
//
//   ticket:PAY-2433  type:debug  status:open  repo:payments  tag:retry  #retry
//   after:2026-10-01  before:7d  has:next-action  has:pr  has:root-cause  scope:personal
//
// Whatever is not a filter is the words, searched as before. One parser for the
// CLI (`wp-brain search`), the one search and the Brain page, so a query means
// the same thing everywhere. Only type imports, so Node loads this directly.

import type { BridgeEntry } from './bridge'

export interface BrainFilters {
	ticket?: string
	type?: string
	status?: string
	project?: string
	tags: string[]
	after?: number
	before?: number
	has: string[]
	scope?: string
}

export interface BrainQuery {
	/** What is left once the filters are taken out. */
	text: string
	filters: BrainFilters
	/** Any filter at all: the search is then about the Brain only. */
	filtered: boolean
}

const DAY = 86_400_000
const KIND_ALIAS: Record<string, string> = { debugging: 'debug', bug: 'debug', mistakes: 'mistake', learned: 'learning', learnings: 'learning', tickets: 'ticket', notes: 'note', decisions: 'decision' }
const HAS_ALIAS: Record<string, string> = { next: 'next-action', 'next-actions': 'next-action', 'rootcause': 'root-cause', cause: 'root-cause', link: 'links', url: 'links', urls: 'links', 'pull-request': 'pr' }

/** `2026-10-01` is that day; `7d` and `2w` count back from `now`. Anything else is no date. */
export function whenOf(value: string, now = Date.now()): number | undefined {
	const rel = value.match(/^(\d{1,4})([dw])$/i)
	if (rel) return now - Number(rel[1]) * (rel[2].toLowerCase() === 'w' ? 7 : 1) * DAY
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
	const t = Date.parse(`${value}T00:00:00Z`)
	return Number.isNaN(t) ? undefined : t
}

export function parseBrainQuery(query: string, now = Date.now()): BrainQuery {
	const filters: BrainFilters = { tags: [], has: [] }
	const words: string[] = []
	let filtered = false
	// key:value, key:"two words", or #tag; everything else is a word.
	const tokens = query.match(/[a-z-]+:"[^"]*"|\S+/gi) ?? []
	for (const token of tokens) {
		const tag = token.match(/^#([\w-]+)$/)
		if (tag) {
			filters.tags.push(tag[1].toLowerCase())
			filtered = true
			continue
		}
		const m = token.match(/^([a-z-]+):(.+)$/i)
		const key = m?.[1].toLowerCase()
		const value = m?.[2].replace(/^"|"$/g, '').trim()
		if (!m || !value) {
			words.push(token)
			continue
		}
		const lower = value.toLowerCase()
		let used = true
		if (key === 'ticket' || key === 'key') filters.ticket = value.toUpperCase()
		else if (key === 'type' || key === 'kind') filters.type = KIND_ALIAS[lower] ?? lower
		else if (key === 'status' || key === 'is') filters.status = lower
		else if (key === 'repo' || key === 'project') filters.project = lower
		else if (key === 'tag') filters.tags.push(lower.replace(/^#/, ''))
		else if (key === 'has') filters.has.push(HAS_ALIAS[lower] ?? lower)
		else if (key === 'scope') filters.scope = lower
		else if (key === 'after' || key === 'since') used = (filters.after = whenOf(value, now)) !== undefined
		else if (key === 'before' || key === 'until') used = (filters.before = whenOf(value, now)) !== undefined
		else used = false
		if (used) filtered = true
		else words.push(token)
	}
	return { text: words.join(' '), filters, filtered }
}

/** Does this entry pass every filter? */
export function matchBrain(e: BridgeEntry, f: BrainFilters): boolean {
	if (f.ticket && e.ticket?.toUpperCase() !== f.ticket && !e.links?.related?.some((k) => k.toUpperCase() === f.ticket)) return false
	if (f.type && e.kind !== f.type) return false
	if (f.scope && e.scope !== f.scope) return false
	if (f.status) {
		const done = e.status?.toLowerCase() === 'done'
		if (f.status === 'open' ? done : f.status === 'done' ? !done : !e.status?.toLowerCase().includes(f.status)) return false
	}
	if (f.project && !e.project?.toLowerCase().includes(f.project)) return false
	if (f.tags.length && !f.tags.every((t) => e.tags?.some((x) => x.toLowerCase() === t))) return false
	if (f.after !== undefined && e.at < f.after) return false
	if (f.before !== undefined && e.at >= f.before) return false
	for (const h of f.has) {
		const ok =
			h === 'next-action' ? !!e.next?.some(Boolean)
			: h === 'pr' ? !!e.links?.pr
			: h === 'root-cause' ? !!e.rootCause
			: h === 'links' ? !!(e.links?.pr || e.links?.urls?.length)
			: h === 'subtitle' ? !!e.subtitle
			: h === 'body' ? !!e.body
			: true
		if (!ok) return false
	}
	return true
}

/** The filters as they can be shown back, one chip each. */
export function describeFilters(f: BrainFilters): string[] {
	const day = (t: number) => new Date(t).toISOString().slice(0, 10)
	return [
		f.ticket && `ticket ${f.ticket}`, f.type && `type ${f.type}`, f.status && `status ${f.status}`, f.project && `repo ${f.project}`, f.scope && `scope ${f.scope}`,
		...f.tags.map((t) => `#${t}`), f.after !== undefined && `after ${day(f.after)}`, f.before !== undefined && `before ${day(f.before)}`, ...f.has.map((h) => `has ${h}`),
	].filter((x): x is string => !!x)
}

/** Words that say nothing about the subject: they matched almost every entry and pushed the real ones down. */
const FILLER = new Set(
	`a an and are as at be but by can could did do does for from get got had has have he her him his how i if in into is it its
	just let like make me more most my no not now of on or our out please so some than that the their them then there these they
	this to too up us use was we were what when where which who why will with would yes you your all any also been both each
	every few here new old one only other same should such very way want need know think tell give show check look see about
	after again before being over under while because doing done going thing things work working it's i'm don't`.split(/\s+/),
)

/** One form per word, so script / scripts / scripting / scripted meet: a light suffix strip, not a dictionary. */
export function stem(w: string): string {
	let s = w
	if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3)
	else if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y'
	else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2)
	else if (s.length > 4 && /(s|x|ch|sh)es$/.test(s)) s = s.slice(0, -2)
	else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
	// promise / promised / promising all end as "promis"
	return s.length > 4 && s.endsWith('e') ? s.slice(0, -1) : s
}

const terms = (text?: string) => [...new Set(String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [])]

/** The words that carry meaning, in one form each; hyphenated words count whole and by their parts. */
const keys = (text?: string) =>
	[...new Set(terms(text).flatMap((t) => (t.includes('-') ? [t, ...t.split('-').filter((p) => p.length > 1)] : [t])).filter((t) => !FILLER.has(t)).map(stem))]

/**
 * Past work like this, best first, after the filters (`ticket:`, `type:` …). Title words count most, then the subtitle
 * and tags, then everything else written down. Filler words never count, word forms meet (script ≈ scripting), and an
 * entry that matches more of the words asked for beats one that matches one word many times; ties go to the newer entry.
 * `matched` is how many different words of the query the entry has.
 */
export function searchBrain(entries: BridgeEntry[], query: string, now = Date.now()): { e: BridgeEntry; score: number; matched: number }[] {
	const { text, filters, filtered } = parseBrainQuery(query, now)
	const wanted = keys(text)
	const pool = filtered ? entries.filter((e) => matchBrain(e, filters)) : entries
	// Only filters: everything that passes them, newest first.
	if (!wanted.length) return filtered ? pool.map((e) => ({ e, score: 1, matched: 0 })).sort((a, b) => b.e.at - a.e.at) : []
	return pool
		.map((e) => {
			const title = keys(e.title)
			const subtitle = keys(e.subtitle)
			const tags = keys((e.tags ?? []).join(' '))
			const rest = keys([e.body, e.ticket, e.project, e.rootCause, e.asked, e.done, ...(e.next ?? [])].filter(Boolean).join(' '))
			let matched = 0
			const raw = wanted.reduce((n, w) => {
				const s = (title.includes(w) ? 8 : 0) + (subtitle.includes(w) ? 5 : 0) + (tags.includes(w) ? 5 : 0) + (rest.includes(w) ? 2 : 0)
				if (s) matched++
				return n + s
			}, 0)
			// Coverage counts up to three words: a long question that shares three of its words is a full match.
			return { e, score: Math.round((raw * matched) / Math.min(wanted.length, 3)), matched }
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || b.e.at - a.e.at)
}

/** What recall looks at: lessons, not ticket logs or time entries. */
export const LESSON_KINDS = ['learning', 'mistake', 'debug', 'decision', 'skill']

/**
 * The few lessons worth putting in front of Claude for this prompt, or none. Strict on purpose, because it runs on every
 * prompt: an entry must share at least two meaningful words with it (one when the prompt has only one or two) and score
 * at least `min`. Prompts that are commands, scheduled checks or too short to say what they are about get nothing.
 */
export function recallFor(entries: BridgeEntry[], prompt: string, limit = 3, min = 12): { e: BridgeEntry; score: number; matched: number }[] {
	const text = String(prompt ?? '').trim()
	if (!text || text.startsWith('/')) return []
	// Questions are usually short; a long paste (a log, a cron prompt) is ranked on its start only.
	const head = text.slice(0, 600)
	const words = keys(head).length
	if (words < 2) return []
	const need = words <= 2 ? 1 : 2
	return searchBrain(
		entries.filter((e) => LESSON_KINDS.includes(e.kind)),
		head.replace(/\b[a-z]+:\S+/gi, ' '), // `type:x` and URLs are not filters here
	)
		.filter((x) => x.matched >= need && x.score >= min)
		.slice(0, limit)
}

// ── the page you are on ─────────────────────────────────────────────────────

const KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g

/** A URL without its fragment, query and trailing slash, and a pull request without its tab. */
export function samePage(url: string): string {
	try {
		const u = new URL(url)
		const path = u.pathname.replace(/\/(files|commits|checks|changes|diffs)\/?$/, '').replace(/\/+$/, '')
		return `${u.host.toLowerCase()}${path}`
	} catch {
		return url
	}
}

/** Where code and tickets live: the hosts where a repository or host match means something. */
const DEV_HOST = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|atlassian\.net|linear\.app)$|^(localhost|127\.0\.0\.1)$|(^|[.-])(staging|stage|dev|preview|qa|uat)([.-]|$)|^gitlab\.|^jira\./i

export interface Related {
	/** Ticket keys this page names (URL first, then title). */
	keys: string[]
	/** owner/repo, on a GitHub or GitLab page. */
	repo?: string
	entries: { e: BridgeEntry; why: 'link' | 'ticket' | 'repo' | 'host' }[]
}

/**
 * The Brain entries that belong to this page: ones that link to it, ones for a
 * ticket it names, then — on code and environment hosts only — ones for its
 * repository or that link to the same host. Best first, newest first within.
 */
export function relatedTo(entries: BridgeEntry[], page: { url: string; title?: string }, limit = 8): Related {
	let host = ''
	let path = ''
	try {
		const u = new URL(page.url)
		if (!/^https?:$/.test(u.protocol)) return { keys: [], entries: [] }
		host = u.host.toLowerCase()
		path = u.pathname
	} catch {
		return { keys: [], entries: [] }
	}
	const keys = [...new Set([...decodeURIComponent(page.url).matchAll(KEY), ...(page.title ?? '').matchAll(KEY)].map((m) => m[0].toUpperCase()))]
	const dev = DEV_HOST.test(host.replace(/:\d+$/, ''))
	const repo = /(^|\.)(github\.com|gitlab\.com)$/.test(host) ? path.split('/').filter(Boolean).slice(0, 2).join('/') || undefined : undefined
	const here = samePage(page.url)
	const rank = { link: 0, ticket: 1, repo: 2, host: 3 } as const
	const got: Related['entries'] = []
	for (const e of entries) {
		const urls = [e.links?.pr, ...(e.links?.urls ?? [])].filter((u): u is string => !!u)
		const why: Related['entries'][number]['why'] | null =
			urls.some((u) => samePage(u) === here) ? 'link'
			: e.ticket && keys.includes(e.ticket.toUpperCase()) ? 'ticket'
			: e.links?.related?.some((k) => keys.includes(k.toUpperCase())) ? 'ticket'
			: dev && repo && repo.includes('/') && e.project && (e.project.toLowerCase() === repo.toLowerCase() || e.project.toLowerCase() === repo.split('/')[1].toLowerCase()) ? 'repo'
			: dev && urls.some((u) => { try { return new URL(u).host.toLowerCase() === host } catch { return false } }) ? 'host'
			: null
		if (why) got.push({ e, why })
	}
	got.sort((a, b) => rank[a.why] - rank[b.why] || b.e.at - a.e.at)
	return { keys, repo: repo?.includes('/') ? repo : undefined, entries: got.slice(0, limit) }
}
