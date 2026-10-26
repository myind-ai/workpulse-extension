// The bridge: one folder in your backup repository that the extension, the
// Claude Code CLI and anything else you write can all read and write.
//
//   bridge/entries/<YYYY-MM>/<device>.jsonl   one entry per line, append-only
//   bridge/inbox/to-cli/<ts>-<id>.json        a request from the extension
//
// Every file has exactly one writer — a device — so two machines never edit the
// same file and there is nothing to merge. The backup's own folder (`workpulse/`
// by default) is never written here, and nothing here is written by the backup.
//
// An entry is anything worth keeping about the work: what a ticket asked and
// what was done, the mistake and its root cause, a debugging session, a report,
// the code that shipped, a skill that was learned — for work and for your own
// side projects alike. Pure: no chrome, no fetch.

export const SCHEMA = 'workpulse.bridge.entry/1'

export const KINDS = ['ticket', 'learning', 'mistake', 'debug', 'report', 'code', 'skill', 'note'] as const
export type EntryKind = (typeof KINDS)[number]

export const KIND_LABEL: Record<EntryKind, string> = {
	ticket: 'Ticket',
	learning: 'Learning',
	mistake: 'Mistake',
	debug: 'Debugging',
	report: 'Report',
	code: 'Code',
	skill: 'Skill',
	note: 'Note',
}

export type Scope = 'work' | 'personal'

export interface BridgeEntry {
	schema: typeof SCHEMA
	id: string
	/** Epoch ms. */
	at: number
	device: string
	kind: EntryKind
	scope: Scope
	title: string
	/** Markdown. */
	body?: string
	/** PAY-2433, when it belongs to one. */
	ticket?: string
	/** The repository or side project, e.g. `acme/payments-web` or `workpulse`. */
	project?: string
	tags?: string[]
	/** For a ticket: asked, done, root cause, mistakes, what is next. */
	asked?: string
	done?: string
	rootCause?: string
	status?: string
	next?: string[]
	links?: { pr?: string; commits?: string[]; related?: string[]; urls?: string[] }
}

/** A request from the extension for the CLI to pick up. */
export interface InboxMessage {
	schema: 'workpulse.bridge.msg/1'
	id: string
	at: number
	from: string
	text: string
	ticket?: string
	project?: string
}

export const ROOT = 'bridge'
export const entriesPath = (at: number, device: string) => `${ROOT}/entries/${new Date(at).toISOString().slice(0, 7)}/${device}.jsonl`
export const inboxPath = (msg: InboxMessage) => `${ROOT}/inbox/to-cli/${new Date(msg.at).toISOString().replace(/[:.]/g, '-')}-${msg.id}.json`

// ── secrets ─────────────────────────────────────────────────────────────────
// Agent sessions see terminal output, .env files and stack traces. Nothing that
// looks like a credential is written, by either side.

const SECRET_SHAPES: [string, RegExp][] = [
	['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
	['API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\bsk_(live|test)_[A-Za-z0-9]{16,}/],
	['Supabase token', /\bsbp_[A-Za-z0-9]{20,}|service_role/],
	['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
	['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
	['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
]

/** What in this text looks like a secret, by name — never the value. */
export function secretsIn(text: string): string[] {
	return SECRET_SHAPES.filter(([, re]) => re.test(text)).map(([name]) => name)
}

// ── reading ─────────────────────────────────────────────────────────────────

const TAG = /(^|\s)#([\w-]+)/g
export const tagsOf = (text: string): string[] => [...new Set([...text.matchAll(TAG)].map((m) => m[2].toLowerCase()))]

/** A line that is not an entry is skipped, not fatal: one bad line must not hide a month. */
export function parseEntry(line: string): BridgeEntry | null {
	let o: Partial<BridgeEntry>
	try {
		o = JSON.parse(line)
	} catch {
		return null
	}
	if (!o || typeof o !== 'object' || typeof o.id !== 'string' || typeof o.title !== 'string') return null
	if (!KINDS.includes(o.kind as EntryKind)) return null
	const at = typeof o.at === 'number' ? o.at : Date.parse(String(o.at))
	if (!Number.isFinite(at)) return null
	return {
		...o,
		schema: SCHEMA,
		id: o.id,
		at,
		device: String(o.device ?? 'unknown'),
		kind: o.kind as EntryKind,
		scope: o.scope === 'personal' ? 'personal' : 'work',
		title: o.title,
		tags: Array.isArray(o.tags) ? o.tags.map(String) : tagsOf(`${o.title} ${o.body ?? ''}`),
	}
}

export function parseJsonl(text: string): BridgeEntry[] {
	return text
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.map(parseEntry)
		.filter((e): e is BridgeEntry => !!e)
}

/** Every entry from every file, once each, newest first. */
export function fold(files: Record<string, string>): BridgeEntry[] {
	const byId = new Map<string, BridgeEntry>()
	for (const [path, text] of Object.entries(files)) {
		if (!path.endsWith('.jsonl')) continue
		for (const e of parseJsonl(text)) {
			const had = byId.get(e.id)
			if (!had || had.at <= e.at) byId.set(e.id, e)
		}
	}
	return [...byId.values()].sort((a, b) => b.at - a.at)
}

export interface Filter {
	kind?: EntryKind | 'all'
	scope?: Scope | 'all'
	query?: string
	ticket?: string
	project?: string
}

export function filter(entries: BridgeEntry[], f: Filter): BridgeEntry[] {
	const q = f.query?.trim().toLowerCase()
	return entries.filter(
		(e) =>
			(!f.kind || f.kind === 'all' || e.kind === f.kind) &&
			(!f.scope || f.scope === 'all' || e.scope === f.scope) &&
			(!f.ticket || e.ticket === f.ticket) &&
			(!f.project || e.project === f.project) &&
			(!q || [e.title, e.body, e.ticket, e.project, e.rootCause, e.asked, e.done, ...(e.tags ?? [])].some((s) => s?.toLowerCase().includes(q))),
	)
}

export interface Summary {
	total: number
	byKind: Record<EntryKind, number>
	tickets: { key: string; count: number; last: number; title: string }[]
	projects: { name: string; scope: Scope; count: number; last: number }[]
	/** Mistakes whose tag came up more than once: the ones worth a habit. */
	repeats: { tag: string; count: number }[]
}

export function summarise(entries: BridgeEntry[]): Summary {
	const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<EntryKind, number>
	const tickets = new Map<string, Summary['tickets'][number]>()
	const projects = new Map<string, Summary['projects'][number]>()
	const mistakeTags = new Map<string, number>()
	for (const e of entries) {
		byKind[e.kind]++
		if (e.ticket) {
			const t = tickets.get(e.ticket) ?? { key: e.ticket, count: 0, last: 0, title: '' }
			t.count++
			if (e.at >= t.last) t.last = e.at
			if (e.kind === 'ticket' || !t.title) t.title = e.title
			tickets.set(e.ticket, t)
		}
		if (e.project) {
			const p = projects.get(e.project) ?? { name: e.project, scope: e.scope, count: 0, last: 0 }
			p.count++
			p.last = Math.max(p.last, e.at)
			projects.set(e.project, p)
		}
		if (e.kind === 'mistake') for (const t of e.tags ?? []) mistakeTags.set(t, (mistakeTags.get(t) ?? 0) + 1)
	}
	return {
		total: entries.length,
		byKind,
		tickets: [...tickets.values()].sort((a, b) => b.last - a.last),
		projects: [...projects.values()].sort((a, b) => b.last - a.last),
		repeats: [...mistakeTags.entries()]
			.filter(([, n]) => n > 1)
			.map(([tag, count]) => ({ tag, count }))
			.sort((a, b) => b.count - a.count),
	}
}

/**
 * A report of everything between two moments, as Markdown: what shipped per
 * ticket and project, then what was learned and what went wrong — the part a
 * timesheet never holds.
 */
export function reportMarkdown(entries: BridgeEntry[], from: number, to: number, title = 'Report'): string {
	const inRange = entries.filter((e) => e.at >= from && e.at < to).sort((a, b) => a.at - b.at)
	const day = (t: number) => new Date(t).toISOString().slice(0, 10)
	const out = [`# ${title}`, '', `${day(from)} → ${day(to - 1)} · ${inRange.length} entries`, '']
	const section = (heading: string, list: BridgeEntry[], line: (e: BridgeEntry) => string) => {
		if (!list.length) return
		out.push(`## ${heading}`, '', ...list.map(line), '')
	}
	const where = (e: BridgeEntry) => [e.ticket, e.project, e.scope === 'personal' ? 'personal' : ''].filter(Boolean).join(' · ')
	section('Tickets and code', inRange.filter((e) => e.kind === 'ticket' || e.kind === 'code'), (e) => `- **${where(e) || e.kind}** — ${e.title}${e.done ? `: ${e.done}` : ''}${e.links?.pr ? ` ([PR](${e.links.pr}))` : ''}`)
	section('Debugging', inRange.filter((e) => e.kind === 'debug'), (e) => `- ${e.title}${e.rootCause ? ` — root cause: ${e.rootCause}` : ''}`)
	section('Learned', inRange.filter((e) => e.kind === 'learning' || e.kind === 'skill'), (e) => `- ${e.title}`)
	section('Mistakes', inRange.filter((e) => e.kind === 'mistake'), (e) => `- ${e.title}${e.rootCause ? ` — ${e.rootCause}` : ''}`)
	section('Notes and reports', inRange.filter((e) => e.kind === 'note' || e.kind === 'report'), (e) => `- ${e.title}`)
	return `${out.join('\n').trimEnd()}\n`
}

// ── writing ─────────────────────────────────────────────────────────────────

const rand = () => Math.random().toString(36).slice(2, 10)

export function newEntry(input: Omit<BridgeEntry, 'schema' | 'id' | 'at' | 'device' | 'tags'> & { tags?: string[] }, device: string, at: number): BridgeEntry {
	const found = secretsIn(JSON.stringify(input))
	if (found.length) throw new Error(`Not saved: it contains what looks like a ${found.join(', ')}. Take it out and try again.`)
	return {
		...input,
		schema: SCHEMA,
		id: `e_${at.toString(36)}_${rand()}`,
		at,
		device,
		title: input.title.trim(),
		tags: input.tags?.length ? input.tags : tagsOf(`${input.title} ${input.body ?? ''}`),
	}
}

/** The device's file with one more line on the end. */
export const appendLine = (existing: string | null, e: BridgeEntry) => `${existing ? existing.replace(/\n*$/, '\n') : ''}${JSON.stringify(e)}\n`

// ── linking ─────────────────────────────────────────────────────────────────

export interface Device {
	device: string
	/** `cli` for Claude Code and the wp-brain tool, `ext` for a browser. */
	kind: 'cli' | 'ext' | 'other'
	count: number
	last: number
}

/** Every device that has written to the bridge, most recent first: the proof that linking worked. */
export function devicesOf(entries: BridgeEntry[]): Device[] {
	const by = new Map<string, Device>()
	for (const e of entries) {
		const d = by.get(e.device) ?? { device: e.device, kind: e.device.startsWith('cli-') ? 'cli' : e.device.startsWith('ext-') ? 'ext' : 'other', count: 0, last: 0 }
		d.count++
		d.last = Math.max(d.last, e.at)
		by.set(e.device, d)
	}
	return [...by.values()].sort((a, b) => b.last - a.last)
}

/** Where the open-source CLI and skill live, for a machine that has neither yet. */
export const SOURCE_REPO = 'https://github.com/myind-ai/workpulse-extension'

/**
 * The commands that link Claude Code on a machine to this repository and
 * branch. `setup` asks for everything else (device name, hooks, the global
 * rule) and installs it; `doctor` says what is and is not linked.
 */
export function setupCommands(repo: string, branch: string, dir = '~/workpulse-extension'): { connect: string; clone: string; setup: string; doctor: string } {
	const cli = `node ${dir}/cli/wp-brain.mjs`
	const flags = `--repo ${repo}${branch ? ` --branch ${branch}` : ''}`
	return {
		// One line for macOS / Linux: checks Node, git and the gh login, installs or
		// updates the CLI, then runs setup. clone + setup are the same by hand.
		connect: `curl -fsSL ${INSTALL_URL} | bash -s -- ${flags}`,
		clone: `git clone ${SOURCE_REPO}.git ${dir}`,
		setup: `${cli} setup ${flags}`,
		doctor: `${cli} doctor`,
	}
}

/** The installer behind setupCommands().connect. */
export const INSTALL_URL = 'https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/install.sh'

/** The name the extension and the CLI both suggest for a new Brain repository. */
export const DEFAULT_REPO_NAME = 'workpulse-notes'

/**
 * The fine-grained token page with everything GitHub lets a link fill in:
 * name, note, 90-day expiry and Contents: Read and write. Which repository it
 * may touch cannot be pre-filled — the person picks only the Brain repository.
 */
export function tokenUrl(owner = ''): string {
	const q = new URLSearchParams({
		name: 'WorkPulse Brain',
		description: 'WorkPulse extension: back up and read the Brain. Select only your Brain repository.',
		expires_in: '90',
		contents: 'write',
		...(owner ? { target_name: owner } : {}),
	})
	return `https://github.com/settings/personal-access-tokens/new?${q}`
}

/** Which files under bridge/ moved since last time, by blob sha. */
export function changedFiles(seen: Record<string, string>, tree: { path: string; sha: string }[]): { fetch: string[]; shas: Record<string, string> } {
	const shas: Record<string, string> = {}
	const fetch: string[] = []
	for (const f of tree) {
		if (!f.path.startsWith(`${ROOT}/entries/`) || !f.path.endsWith('.jsonl')) continue
		shas[f.path] = f.sha
		if (seen[f.path] !== f.sha) fetch.push(f.path)
	}
	return { fetch, shas }
}
