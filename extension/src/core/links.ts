// Ticket keys, link labels and search over saved work. Pure, so the one thing
// that matters — finding a ticket's links a fortnight later — is testable.

/** PAY-2433, ENG-12, ABC-7 — a key as people write it, anywhere in the text. */
export function ticketKey(text: string): string | null {
	// Two letters at least, so "v1-2" and a date are not mistaken for tickets.
	const m = (text ?? '').toUpperCase().match(/\b([A-Z]{2,10})-(\d{1,6})\b/)
	return m ? `${m[1]}-${m[2]}` : null
}

// The service is checked before the path: sentry.io/issues/1 is somewhere you
// read logs, not a ticket, even though every tracker uses /issues/ too.
const KINDS: [RegExp, string][] = [
	[/figma\.com/, 'Design'],
	[/sentry|datadog|newrelic|grafana|kibana|logz\.io/, 'Logs'],
	[/docs\.google|notion\.so|confluence|\/wiki\//, 'Doc'],
	[/jenkins|circleci|argocd|\/actions\/|\/pipelines?\/|\/job\/|\/builds?\//, 'Build'],
	[/\/pull\/|\/merge_requests\/|\/pull-requests\//, 'PR'],
	[/\/commit\/|\/compare\//, 'Commit'],
	[/\/browse\/[a-z]+-\d+|\/issues?\//, 'Ticket'],
]

const ENVS: [RegExp, string][] = [
	[/localhost|127\.0\.0\.1|\.local\b/, 'Local'],
	[/\bdev\b|\bdevelop\b/, 'Dev'],
	[/\bstag(e|ing)\b/, 'Stage'],
	[/\bqa\b|\btest\b/, 'Test'],
	[/\bprod\b|\bproduction\b/, 'Prod'],
]

/**
 * A first guess at what a link is, from its address — "PR", "Stage", "Build".
 * Yours to overwrite; the point is that a link saved in a hurry still says
 * something in ten days' time.
 */
export function labelFor(url: string): string | undefined {
	const u = (url ?? '').toLowerCase()
	if (!u) return undefined
	const kind = KINDS.find(([re]) => re.test(u))
	const env = ENVS.find(([re]) => re.test(u))
	if (kind && env) return `${kind[1]} · ${env[1]}`
	return (kind ?? env)?.[1]
}

export interface Searchable {
	name: string
	note?: string
	tabs: { title: string; url: string; note?: string }[]
}

/** Matches on the ticket key, the name, your note, and the links themselves. */
export function matches(space: Searchable, query: string): boolean {
	const q = query.trim().toLowerCase()
	if (!q) return true
	const hay = [space.name, space.note ?? '', ...space.tabs.flatMap((t) => [t.title, t.url, t.note ?? ''])].join(' ').toLowerCase()
	return q.split(/\s+/).every((word) => hay.includes(word))
}

/**
 * Which saved ticket a page probably belongs to: its key in the address or the
 * title. Opening a PR for PAY-2433 should offer PAY-2433, not a list of thirty.
 */
export function suggest<T extends { id: string; name: string }>(url: string, title: string, list: T[]): T[] {
	return byKey(`${url} ${title}`, list)
}

/** Tickets whose key appears in some text. The one matcher, used by both. */
function byKey<T extends { id: string; name: string }>(haystack: string, list: T[]): T[] {
	const key = ticketKey(haystack)
	if (!key) return []
	return list.filter((w) => ticketKey(w.name) === key)
}

/**
 * Which ticket a page most likely belongs to, and why.
 *
 * A key in the address is proof. Failing that, a ticket that already holds a
 * link to this exact page is nearly proof, and one that holds a link to the
 * same site is a reasonable guess — a bug found on `stage.acme.com/orders` is
 * almost always about the ticket whose stage link you saved last week.
 *
 * It says *why*, because a suggestion you cannot check is one you either accept
 * blindly or ignore entirely.
 *
 * `text` is what you wrote about the page, and it outranks everything else: a
 * note reading "Tested PAY-3110 on production" names its ticket outright, and
 * the fact that production's address says nothing about PAY-3110 does not make
 * it any less true. You typed that key on purpose.
 */
export function ticketForPage<T extends { id: string; name: string; tabs?: { url: string }[] }>(
	url: string,
	title: string,
	list: T[],
	text = '',
): { ticket: T; why: string } | null {
	const written = text.trim() ? byKey(text, list)[0] : undefined
	if (written) return { ticket: written, why: 'you named it in the note' }

	const inAddress = suggest(url, title, list)[0]
	if (inAddress) return { ticket: inAddress, why: `its key is in the address` }

	const exact = list.find((w) => w.tabs?.some((t) => sameUrl(t.url, url)))
	if (exact) return { ticket: exact, why: 'this exact page is saved under it' }

	const host = hostOf(url)
	if (!host) return null
	const sameSite = list.find((w) => w.tabs?.some((t) => hostOf(t.url) === host))
	return sameSite ? { ticket: sameSite, why: `you saved a ${host} link under it` } : null
}

const hostOf = (u: string) => {
	try {
		return new URL(u).hostname.toLowerCase().replace(/^www\./, '')
	} catch {
		return ''
	}
}

const sameUrl = (a: string, b: string) => {
	const strip = (u: string) => u.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()
	return strip(a) === strip(b)
}

/** "today", "yesterday", "9 days ago" — the day-10 question is always "how old?". */
export function ago(at: number, now: number): string {
	const days = Math.floor((now - at) / 86_400_000)
	if (days <= 0) return 'today'
	if (days === 1) return 'yesterday'
	if (days < 30) return `${days} days ago`
	const months = Math.round(days / 30)
	return months <= 1 ? 'a month ago' : `${months} months ago`
}

/**
 * Every ticket key in the text. With prefixes configured, only those count —
 * your team writes `PAY-2433`, another writes `LEAP-18`, and a version string
 * or a date should never be mistaken for either. Without any, the general shape
 * is accepted.
 */
export function keysIn(text: string, prefixes: string[] = []): string[] {
	const re = new RegExp(keyPattern(prefixes), 'g')
	return [...new Set([...(text ?? '').toUpperCase().matchAll(re)].map((m) => `${m[1]}-${m[2]}`))]
}

/**
 * The pattern behind `keysIn`, as source. The page scan runs inside the page,
 * where nothing can be imported, so it is handed this string and builds its own
 * regex — one definition of what a key looks like, used in both places.
 */
export function keyPattern(prefixes: string[] = []): string {
	const live = prefixes.map(cleanPrefix).filter(Boolean)
	return live.length ? `\\b(${live.join('|')})-(\\d{1,6})\\b` : `\\b([A-Z]{2,10})-(\\d{1,6})\\b`
}

/** `PAY-` / ` pay ` / `PAY` all mean the prefix PAY. */
export const cleanPrefix = (s: string) => (s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')

export interface MenuItem {
	/** `wp-add:<ticketId>`, `wp-new:<KEY>`, or a parent with no action. */
	id: string
	title: string
	parentId?: string
}

export const MENU_ROOT = 'wp-root'
export const MENU_MORE = 'wp-more'

/**
 * The right-click menu for a page: the ticket its key points at first, then any
 * ticket by hand, then making one from the key. Built from the tab's title and
 * address, so the menu is already right before the click.
 */
export function pageMenu(page: { title?: string; url?: string; keys?: string[] }, prefixes: string[], spaces: { id: string; name: string }[], limit = 8): MenuItem[] {
	// Keys from the title and the address, then any found in the page itself —
	// a Confluence page or a PR description often names the ticket nowhere else.
	const keys = [...new Set([...keysIn(`${page.title ?? ''} ${page.url ?? ''}`, prefixes), ...(page.keys ?? []).flatMap((k) => keysIn(k, prefixes))])]
	const out: MenuItem[] = [{ id: MENU_ROOT, title: 'WorkPulse' }]

	// A ticket whose name carries one of this page's keys: the likely answer.
	const hit = spaces.filter((w) => keys.some((k) => keysIn(w.name, prefixes).includes(k)))
	for (const w of hit) out.push({ id: `wp-add:${w.id}`, title: `Add this page to ${w.name}`, parentId: MENU_ROOT })

	// A key with no ticket yet — one click to start it.
	for (const key of keys.filter((k) => !hit.some((w) => keysIn(w.name, prefixes).includes(k)))) {
		out.push({ id: `wp-new:${key}`, title: `New ticket ${key} with this page`, parentId: MENU_ROOT })
	}

	const rest = spaces.filter((w) => !hit.includes(w)).slice(0, limit)
	if (rest.length) {
		out.push({ id: MENU_MORE, title: hit.length || keys.length ? 'Add to another ticket' : 'Add this page to a ticket', parentId: MENU_ROOT })
		for (const w of rest) out.push({ id: `wp-add:${w.id}`, title: w.name, parentId: MENU_MORE })
	}
	if (!hit.length && !keys.length && !rest.length) out.push({ id: 'wp-new:', title: 'Save this page as a new ticket…', parentId: MENU_ROOT })

	// The things worth doing with a page or a sentence on it, without leaving
	// the page to do them. Each is one click from the thought that prompted it,
	// which is the only moment any of them will actually get done.
	out.push({ id: MENU_SEP, title: '—', parentId: MENU_ROOT })
	out.push({ id: 'wp-do:note', title: 'Note this page…', parentId: MENU_ROOT })
	out.push({ id: 'wp-do:todo', title: 'Add as a to-do', parentId: MENU_ROOT })
	out.push({ id: 'wp-do:remind', title: 'Remind me about this page tomorrow', parentId: MENU_ROOT })
	out.push({ id: 'wp-do:learn', title: 'Save as a learning', parentId: MENU_ROOT })
	out.push({ id: 'wp-do:log', title: 'Log this as what I am doing', parentId: MENU_ROOT })
	out.push({ id: 'wp-do:focus', title: 'Start a 50-minute block on this', parentId: MENU_ROOT })
	return out
}

export const MENU_SEP = 'wp-sep'

/** The one-click actions, as opposed to filing the page under a ticket. */
export type MenuDo = 'note' | 'todo' | 'remind' | 'learn' | 'log' | 'focus'

export function menuDo(id: string): MenuDo | null {
	return id.startsWith('wp-do:') ? (id.slice(6) as MenuDo) : null
}

/** The action behind a menu id. */
export function menuAction(id: string): { kind: 'add'; ticketId: string } | { kind: 'new'; key: string } | null {
	if (id.startsWith('wp-add:')) return { kind: 'add', ticketId: id.slice(7) }
	if (id.startsWith('wp-new:')) return { kind: 'new', key: id.slice(7) }
	return null
}

// ── a hundred tickets ───────────────────────────────────────────────────────

export type TicketSort = 'activity' | 'opened' | 'created' | 'name'

export const SORT_LABEL: Record<TicketSort, string> = {
	activity: 'Last changed',
	opened: 'Last opened',
	created: 'Newest',
	name: 'Name',
}

/**
 * One row of the ticket list. Deliberately small: the list ships on every
 * change, and a hundred tickets with every note and link in them is a payload
 * nobody needs to draw a list. `hay` is what search reads — the names, labels
 * and addresses, flattened once in the background rather than in the page.
 */
export interface TicketRow {
	id: string
	name: string
	links: number
	notes: number
	at: number
	updatedAt: number
	lastOpenedAt?: number
	/** Finished with: out of the list unless you ask for it. */
	archived?: boolean
	/** The newest note's first line, for the one line of context on the row. */
	latestNote?: string
	hay: string
}

export function sortTickets<T extends TicketRow>(rows: T[], sort: TicketSort): T[] {
	const by = [...rows]
	if (sort === 'name') return by.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
	if (sort === 'created') return by.sort((a, b) => b.at - a.at)
	// Never opened sorts last rather than first, which `?? 0` would do backwards.
	if (sort === 'opened') return by.sort((a, b) => (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1) || b.updatedAt - a.updatedAt)
	return by.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Search over the flattened row. Every word has to match. */
export function matchesRow(row: TicketRow, query: string): boolean {
	const q = query.trim().toLowerCase()
	if (!q) return true
	const hay = `${row.name} ${row.hay} ${row.latestNote ?? ''}`.toLowerCase()
	return q.split(/\s+/).every((word) => hay.includes(word))
}

// ── two tickets that turned out to be one ───────────────────────────────────

export interface MergeInput {
	id: string
	name: string
	at: number
	updatedAt?: number
	lastOpenedAt?: number
	note?: string
	tabs: { url: string; title: string; note?: string; addedAt?: number }[]
	notes?: { id: string; date: string; at: number; text: string; editedAt?: number }[]
}

/**
 * Folds `from` into `into`. It happens: you save `PAY-2433` on Monday, someone
 * sends you a link on Thursday and you save `PAY-2433 financing`, and now the
 * ticket is in two halves.
 *
 * The one you merged into keeps its name — you chose it as the survivor — and
 * everything else is added rather than replaced. A link in both keeps the label
 * you wrote, whichever side it was on: a label is work, and the duplicate is an
 * accident.
 */
/**
 * The links that went in together.
 *
 * "Add every tab in this window" puts twenty of them in at the same instant,
 * and a minute later they are indistinguishable from the four you collected
 * deliberately over a fortnight. They are not, though: they share a timestamp.
 * This finds the most recent burst, so it can be offered back as one thing —
 * which is the only way to undo it once the undo window has gone.
 */
export function addedTogether(tabs: { url: string; addedAt?: number }[], within = 60_000): { urls: string[]; at: number } | null {
	const stamped = tabs.filter((t) => t.addedAt != null).sort((a, b) => b.addedAt! - a.addedAt!)
	if (stamped.length < 3) return null

	// Every cluster, not only the newest: add twenty by mistake and two on
	// purpose afterwards, and the newest cluster is the two — which would hide
	// the mistake exactly when it is being looked for.
	const clusters: (typeof stamped)[] = []
	for (const t of stamped) {
		const last = clusters.at(-1)
		if (last && last[last.length - 1].addedAt! - t.addedAt! <= within) last.push(t)
		else clusters.push([t])
	}
	// Three is a burst; two is a Tuesday. And offering to remove every link in
	// the ticket is offering to empty it.
	const burst = clusters.find((c) => c.length >= 3 && c.length < tabs.length)
	return burst ? { urls: burst.map((t) => t.url), at: burst[0].addedAt! } : null
}

export function mergeWorkspaces<T extends MergeInput>(from: T, into: T, now: number): T {
	const seen = new Map(into.tabs.map((t) => [t.url, t]))
	for (const tab of from.tabs) {
		const had = seen.get(tab.url)
		if (!had) seen.set(tab.url, tab)
		// Keep whichever side bothered to label it, and the earlier "added" date,
		// because that is when the link really arrived.
		else seen.set(tab.url, { ...had, note: had.note ?? tab.note, addedAt: Math.min(had.addedAt ?? now, tab.addedAt ?? now) })
	}

	const notes = [...(into.notes ?? []), ...(from.notes ?? [])]
		.filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i)
		.sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at)

	return {
		...into,
		tabs: [...seen.values()],
		notes,
		// The merged ticket is as old as its oldest half and as fresh as its newest.
		at: Math.min(into.at, from.at),
		updatedAt: now,
		lastOpenedAt: Math.max(into.lastOpenedAt ?? 0, from.lastOpenedAt ?? 0) || undefined,
		note: into.note ?? from.note,
	}
}

/** What a merge would do, for saying so before it is done. */
export function mergePreview(from: MergeInput, into: MergeInput): { links: number; notes: number; duplicates: number } {
	const have = new Set(into.tabs.map((t) => t.url))
	const duplicates = from.tabs.filter((t) => have.has(t.url)).length
	return { links: from.tabs.length - duplicates, notes: (from.notes ?? []).length, duplicates }
}
