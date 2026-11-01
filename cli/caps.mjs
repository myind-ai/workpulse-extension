// Hard token caps on what the Brain puts in front of Claude: the SessionStart brief and the per-prompt recall.
// Node built-ins only. Used by wp-brain.mjs (hooks, `brief`, `recall`, `show`) and by `budget`, which measures the same text.
//
//   capBrief(units, opts)   the brief as text, within CAPS.brief tokens, ending with how to get the rest
//   recallText(lessons, pointers)   { text, kept, keptPointers }: the recall hook's context within CAPS.recall, and how many lessons and pointers made it
//   recallLine(e)           one lesson on one line: kind, title, and where it came from or how to open it
//   showText(e, headline)   the whole entry, for `wp-brain show`
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAPS, capLines, tokensOf } from './budget.mjs'

const { shortId, sourceOf } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'src', 'core', 'bridge.ts'))

const TITLE_CHARS = 140
const INBOX_CHARS = 200

/** `text` cut at a code point (never through a Devanagari letter or an emoji) to at most `n` of them, with `…` when cut. */
export function clip(text, n) {
	const chars = Array.from(String(text))
	return chars.length <= n ? chars.join('') : `${chars.slice(0, n - 1).join('').trimEnd()}…`
}

const RECALL_LINE_TOKENS = 150 // one lesson alone, with the header and the "more" line, must fit CAPS.recall

/**
 * `- [kind] title (source type; source URL) [id8]`: one lesson, no body and no root cause. A URL that would make the line longer
 * than RECALL_LINE_TOKENS is not clipped (half a URL opens nothing): the line says `wp-brain show <id8>` instead. A lesson with no
 * source says the same. The title is cut at a code point.
 */
export function recallLine(e, maxTokens = RECALL_LINE_TOKENS) {
	const src = sourceOf(e)
	const id = shortId(e.id)
	const head = `- [${e.kind}] ${clip(e.title, TITLE_CHARS)} (${src ? `${src.type}; ` : ''}`
	const show = `${head}wp-brain show ${id})`
	if (!src?.url) return show
	const withId = `${head}${src.url}) [${id}]`
	if (tokensOf(withId) <= maxTokens) return withId
	const bare = `${head}${src.url})`
	return tokensOf(bare) <= maxTokens ? bare : show
}

const RECALL_HEADER = 'WorkPulse Brain, lessons that may apply (ignore if not; wp-brain show ID opens one):'

const RECALL_HEADER_MORE = 'WorkPulse Brain, rules, skills and lessons that may apply (ignore if not; wp-brain show ID opens a lesson):'
const RECALL_HEADER_POINTERS = 'WorkPulse Brain, rules and skills that may apply (ignore if not):'

/**
 * The recall hook's context for these lessons and the rule or skill pointers (lines, first in the text), within CAPS.recall.
 * `kept` is how many lessons it holds and `keptPointers` how many pointers (what the cap drops is not marked seen).
 */
export function recallText(got, pointers = []) {
	const header = !pointers.length ? RECALL_HEADER : got.length ? RECALL_HEADER_MORE : RECALL_HEADER_POINTERS
	const more = (n) => `… ${n} more: wp-brain search`
	let lessons = got.map((e) => recallLine(e))
	let { lines, dropped } = capLines([header, ...pointers, ...lessons], CAPS.recall, more)
	let shown = Math.max(0, lines.length - 1 - (dropped ? 1 : 0))
	if (got.length && shown - pointers.length < 1) {
		// The pointers left no room for even one lesson: say the lesson in its short form rather than print a header and "… N more".
		lessons = got.map((e) => `- [${e.kind}] ${clip(e.title, 80)} (wp-brain show ${shortId(e.id)})`)
		;({ lines, dropped } = capLines([header, ...pointers, ...lessons], CAPS.recall, more))
		shown = Math.max(0, lines.length - 1 - (dropped ? 1 : 0))
	}
	return { text: lines.join('\n'), kept: Math.max(0, shown - pointers.length), keptPointers: Math.min(pointers.length, shown) }
}

/** A section: its heading glued to its first item, so a heading never stands alone. Empty without items. */
export function section(heading, items) {
	return items.length ? [`${heading}\n${items[0]}`, ...items.slice(1)] : []
}

/** `- [id] rest`: a unit's request line with its text cut to `n` code points, the id and any heading kept. */
function shortenRequest(unit, n) {
	const at = unit.startsWith('## ') ? unit.indexOf('\n') : -1 // a glued heading, found by its own marker
	const head = at >= 0 ? unit.slice(0, at + 1) : ''
	const line = at >= 0 ? unit.slice(at + 1) : unit
	const m = /^(- \[[^\]]*\] )([\s\S]*)$/.exec(line)
	return m ? `${head}${m[1]}${n > 0 ? clip(m[2], n) : '…'}` : unit
}

/**
 * The brief from its sections (each an array of units; a unit is a line or an entry with its detail lines) in the order
 * they matter: they are dropped from the end. `header` stays, and so does every inbox request and the saved-pages count (`sections.inbox`
 * says the first section holds them): the cap drops everything else first and only then cuts each request's text, never its id.
 * Without `full` the text is within CAPS.brief and ends with how to get the rest.
 */
export function capBrief(sections, { key, project, header, full = false } = {}) {
	const units = sections.flatMap((s, i) => s.map((u, j) => (j === 0 && i > 0 ? `\n${u}` : u)))
	const all = header ? [header, ...units] : units
	if (full) return all.join('\n')
	const rest = `${key ? `${key} ` : ''}${project ? `--project ${project} ` : ''}--full`
	const more = (n) => `… ${n} more: wp-brain brief ${rest}`
	const inbox = sections.inbox ? sections[0].length : 0
	if (!inbox) return capLines(all, CAPS.brief, more).lines.join('\n').replace(/^\n+/, '')
	const keep = (header ? 1 : 0) + inbox
	const tail = all.slice(keep)
	const fits = (lines) => tokensOf(lines.join('\n')) <= CAPS.brief
	let prot = all.slice(0, keep)
	for (let k = tail.length; k >= 0; k--) {
		const lines = [...prot, ...tail.slice(0, k), ...(k < tail.length ? [more(tail.length - k)] : [])]
		if (fits(lines)) return lines.join('\n').replace(/^\n+/, '')
	}
	// The requests alone are over the cap (ids stay even if they alone exceed it: a request is never dropped): shorten each one's text, evenly, until they fit with the "more" line.
	const shorten = (n) => prot.map((u, i) => (i < (header ? 1 : 0) ? u : shortenRequest(u, n)))
	const tailLine = tail.length ? [more(tail.length)] : []
	let lo = 0
	let hi = INBOX_CHARS
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		if (fits([...shorten(mid), ...tailLine])) lo = mid
		else hi = mid - 1
	}
	return [...shorten(lo), ...tailLine].join('\n').replace(/^\n+/, '')
}

/** Inbox requests are asked for first and kept short, so one long request cannot push the others out. */
export const inboxItem = (m) => `- [${m.id}] ${m.ticket ? `${m.ticket}: ` : ''}${clip(String(m.text ?? '').replace(/\s+/g, ' '), INBOX_CHARS)}`

/** Every field of one entry, for `wp-brain show`. */
export function showText(e, headline) {
	const lines = [headline, '']
	const field = (name, v) => v && lines.push(`${name}: ${v}`)
	field('id', e.id)
	field('kind', `${e.kind}${e.scope === 'personal' ? ' (personal)' : ''}${e.archived ? ' (archived)' : ''}`)
	field('title', e.title)
	field('subtitle', e.subtitle)
	field('ticket', e.ticket)
	field('project', e.project)
	field('status', e.status)
	const src = sourceOf(e)
	field('source', src && [src.type, src.title, src.by, src.url].filter(Boolean).join(' · '))
	field('tags', e.tags?.length && e.tags.map((t) => `#${t}`).join(' '))
	field('asked', e.asked)
	field('done', e.done)
	field('root cause', e.rootCause)
	field('next', e.next?.length && e.next.join(' · '))
	field('pr', e.links?.pr)
	field('commits', e.links?.commits?.join(' '))
	field('related', e.links?.related?.join(', '))
	field('links', e.links?.urls?.join(' '))
	if (e.body) lines.push('', e.body)
	return lines.join('\n')
}
