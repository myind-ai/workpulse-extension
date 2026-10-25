// A note on a page, for the people you work with.
//
// You find a bug on a staging page at four o'clock. Today that becomes a
// message in a chat window, which means a screenshot pasted somewhere, a URL
// pasted next to it, and a conversation nobody can find next week when someone
// else opens the same page. The page is where the problem is, so the page is
// where the note should be.
//
// It is kept as a GitHub issue in the team's repository, because that is a
// place the team already looks, already has notifications for, and can close.
// The extension's part is knowing which issue belongs to which page.

/**
 * The address two people would agree is "the same page".
 *
 * A tracking parameter, a session id and a fragment are all noise someone
 * copied by accident; without stripping them, two people looking at the same
 * screen file their notes in two different places.
 */
export function canonicalUrl(raw: string): string {
	let u: URL
	try {
		u = new URL(raw)
	} catch {
		return raw.trim()
	}
	u.hash = ''
	u.username = ''
	u.password = ''
	for (const k of [...u.searchParams.keys()]) {
		if (/^(utm_|fbclid|gclid|mc_|_ga|ref|referrer|session|sid|token)/i.test(k)) u.searchParams.delete(k)
	}
	u.protocol = u.protocol.toLowerCase()
	u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
	let out = u.toString()
	// A trailing slash on a path is the same page; on the root it is the root.
	if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1)
	return out
}

/** Short, stable, filename-safe — and the same on every machine. */
export function urlKey(raw: string): string {
	const s = canonicalUrl(raw)
	let h1 = 0x811c9dc5
	let h2 = 0x01000193
	for (let i = 0; i < s.length; i++) {
		h1 = ((h1 ^ s.charCodeAt(i)) * 0x01000193) >>> 0
		h2 = ((h2 + s.charCodeAt(i) * (i + 1)) * 0x85ebca6b) >>> 0
	}
	return (h1.toString(36) + h2.toString(36)).padEnd(12, '0').slice(0, 12)
}

/** What the page is called, in as few words as a title bar allows. */
export function pageTitle(title: string, url: string): string {
	const t = title.replace(/\s+/g, ' ').trim()
	if (t) return t.length > 70 ? `${t.slice(0, 67)}…` : t
	try {
		const u = new URL(url)
		return `${u.hostname}${u.pathname}`.slice(0, 70)
	} catch {
		return url.slice(0, 70)
	}
}

/**
 * A note you left for yourself on a page.
 *
 * Local first, and local on its own: this works on the first day, with no
 * GitHub, no team and no account — because "what was wrong with this screen"
 * is a thing worth writing down whether or not anyone else ever reads it.
 * Sharing is a separate, later, deliberate act.
 */
export interface LocalNote {
	id: string
	key: string
	url: string
	title: string
	text: string
	at: number
	/** What you had selected when you wrote it. */
	where?: string
	/** A screenshot, as a data URL, kept on this machine. */
	shot?: string
	/**
	 * A recording. The video itself lives in the blob store; `url` is where it
	 * was uploaded to, once somebody chose to put it somewhere others can see.
	 */
	clip?: { id: string; ms: number; bytes: number; at: number; type: string; url?: string }
	/** It had one, and the picture was let go to keep the disk sane. */
	shotDropped?: boolean
	/** Dealt with. Kept, because "I already looked at this" is the useful part. */
	doneAt?: number
	/** Once shared, the issue it became — so it is never shared twice. */
	shared?: { number: number; url: string; at: number }
	/**
	 * The ticket it belongs to, when it belongs to one. A bug found on a
	 * staging page is nearly always about something you are already working on,
	 * and the note is no use filed away from it.
	 */
	ticketId?: string
}

/**
 * How many notes keep their screenshot, and the ceiling on the lot.
 *
 * A full-screen PNG data URL is one to three megabytes. Capping the *count* at
 * four hundred — which is what this used to do — is a cap of about a gigabyte
 * on somebody's disk, and `unlimitedStorage` means nothing would ever have
 * complained. The pictures are what is expensive, so the pictures are what is
 * counted: the newest keep theirs, older notes keep their words.
 */
export const KEEP_SHOTS = 40
export const KEEP_NOTES = 400

/** Trim the list: every note's words, the newest notes' pictures. */
export function trimNotes(list: LocalNote[]): LocalNote[] {
	const kept = list.slice(-KEEP_NOTES)
	const withShots = kept.filter((n) => n.shot).slice(-KEEP_SHOTS)
	const keepShot = new Set(withShots.map((n) => n.id))
	return kept.map((n) => (n.shot && !keepShot.has(n.id) ? { ...n, shot: undefined, shotDropped: true } : n))
}

export function newNote(input: { url: string; title?: string; text: string; where?: string; shot?: string }, now: number, id: string): LocalNote {
	return {
		id,
		key: urlKey(input.url),
		url: canonicalUrl(input.url),
		title: pageTitle(input.title ?? '', input.url),
		text: input.text.trim(),
		at: now,
		where: input.where?.slice(0, 300),
		shot: input.shot,
	}
}

/** Everything written on this page, newest first. */
export function notesFor(list: LocalNote[], url: string, includeDone = true): LocalNote[] {
	const key = urlKey(url)
	return list.filter((n) => n.key === key && (includeDone || n.doneAt == null)).sort((a, b) => b.at - a.at)
}

/** How many notes this page has, from what is on this machine. */
export function countLocal(list: LocalNote[], url: string): { open: number; done: number } {
	const mine = notesFor(list, url)
	return { open: mine.filter((n) => n.doneAt == null).length, done: mine.filter((n) => n.doneAt != null).length }
}

/**
 * The pages with something on them, most recently written first — so the notes
 * are a list you can read, not only something that ambushes you on a URL you
 * happen to revisit.
 */
export function pagesWithNotes(list: LocalNote[]): { key: string; url: string; title: string; open: number; total: number; at: number }[] {
	const by = new Map<string, LocalNote[]>()
	for (const n of list) by.set(n.key, [...(by.get(n.key) ?? []), n])
	return [...by.entries()]
		.map(([key, notes]) => ({
			key,
			url: notes[0].url,
			title: notes.sort((a, b) => b.at - a.at)[0].title,
			open: notes.filter((n) => n.doneAt == null).length,
			total: notes.length,
			at: Math.max(...notes.map((n) => n.at)),
		}))
		.sort((a, b) => b.at - a.at)
}

export interface PageNote {
	/** The issue number, once GitHub has one. */
	number?: number
	key: string
	url: string
	title: string
	text: string
	author: string
	at: number
	/** Where the screenshot was committed, if one was taken. */
	shot?: string
	state: 'open' | 'closed'
	replies?: { author: string; text: string; at: number }[]
	/** Yours, or somebody else's. The same list holds both once a team exists. */
	source?: 'me' | 'team'
	/** A recording of the tab, when there is one. */
	clip?: { id: string; ms: number; bytes: number; at: number; type: string }
	/** The ticket it is filed under, if any. */
	ticketId?: string
	/** For one of yours: whether it has been shared, and the local id to act on. */
	localId?: string
}

/** The marker that says an issue is one of ours, and which page it is about. */
export const MARK = '<!-- workpulse:page -->'

/**
 * The issue body. The marker and the canonical URL are both in it, so the issue
 * can be found again by searching the repository — and read by a human who has
 * never heard of this extension.
 */
export function issueBody(n: { url: string; text: string; shot?: string; author: string; at: number; where?: string; repo?: string; branch?: string }): string {
	const lines = [MARK, '', n.text.trim(), '', `**Page:** ${canonicalUrl(n.url)}`]
	if (n.where) lines.push(`**On the page:** ${n.where}`)
	if (n.shot) {
		// A path in backticks is something to go and find; a link is something to
		// click. GitHub will not render a private repository's image inline, so
		// the honest version is a link that works for anyone who can see the repo.
		const link = n.repo ? `https://github.com/${n.repo}/blob/${n.branch || 'main'}/${n.shot}` : ''
		lines.push(link ? `**Screenshot:** [${n.shot.split('/').pop()}](${link})` : `**Screenshot:** \`${n.shot}\` (in this repository)`)
	}
	lines.push('', `<sub>Noted by ${n.author} with WorkPulse · ${new Date(n.at).toISOString()}</sub>`)
	return lines.join('\n')
}

/** The page an issue is about, read back out of its body. */
export function pageOf(body: string): string | null {
	const m = /\*\*Page:\*\*\s*(\S+)/.exec(body ?? '')
	return m ? m[1] : null
}

/** The note itself, without the scaffolding the body carries. */
export function textOf(body: string): string {
	return (body ?? '')
		.replace(MARK, '')
		.replace(/\*\*(Page|On the page|Screenshot):\*\*.*$/gm, '')
		.replace(/<sub>.*?<\/sub>/gs, '')
		.trim()
}

/** Where a screenshot is committed. One per note, named by the note. */
export function shotPath(folder: string, key: string, at: number): string {
	return `${(folder || 'team').replace(/^\/+|\/+$/g, '')}/shots/${key}-${at}.png`
}

/**
 * The index: page key → issue numbers. Kept as one small file so opening a page
 * is a single read rather than a search of every issue in the repository, and
 * so a page with no notes costs nothing to check.
 */
export interface NoteIndex {
	/** Key → the issues on that page, with just enough to show a badge. */
	pages: Record<string, { url: string; open: number[]; closed: number[] }>
	at: number
}

export const EMPTY_INDEX: NoteIndex = { pages: {}, at: 0 }

export function indexWith(index: NoteIndex, url: string, number: number, state: 'open' | 'closed', now: number): NoteIndex {
	const key = urlKey(url)
	const page = index.pages[key] ?? { url: canonicalUrl(url), open: [], closed: [] }
	const open = page.open.filter((n) => n !== number)
	const closed = page.closed.filter((n) => n !== number)
	if (state === 'open') open.push(number)
	else closed.push(number)
	return { at: now, pages: { ...index.pages, [key]: { url: page.url, open: open.sort((a, b) => a - b), closed: closed.sort((a, b) => a - b) } } }
}

/** How many notes this page has, for the badge — without fetching any of them. */
export function countFor(index: NoteIndex, url: string): { open: number; closed: number } {
	const page = index.pages[urlKey(url)]
	return { open: page?.open.length ?? 0, closed: page?.closed.length ?? 0 }
}
