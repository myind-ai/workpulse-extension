// `wp-brain memory export`: each captured session as one readable Markdown file, in a folder that stays on this machine (and, encrypted
// as a pack, in the vault). Never under the Brain clone. It reads the database only, so it holds masked text only.
//
// Hand edits are safe: one marked block is all this code owns, and text outside it stays. A file whose marks are gone is left alone.
// A file goes in through a temp file and a rename, and one session is read in one transaction, so a capture running beside it never shows.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { realPlace } from './claude-files.mjs'
import { errorCode, showSession } from './memory-db.mjs'

const MARK = '<!-- wp-brain:session'
const NAME_CHARS = 60
const ROLE = { prompt: 'Prompt', answer: 'Answer', note: 'Note' }

const when = (ms) => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown')
const beginOf = (id) => `${MARK} ${id} begin`
const endOf = (id) => `${MARK} ${id} end -->`

/** Plain session text must never be somewhere a git command of the Brain could pick it up. Throws when `root` is inside the clone. */
export function assertOutsideBrain(root, clone) {
	if (typeof clone !== 'string' || !clone) return
	const [folder, brain] = [realPlace(root), realPlace(clone)]
	if (folder === brain || folder.startsWith(`${brain}/`)) throw new Error(`The session Markdown folder ${root} is inside the Brain clone, so nothing was exported: plain session text never goes there. Set WP_SESSIONS_MD to a folder outside it.`)
}

/** A name for a file or folder: letters, numbers, combining marks and a few signs. Nothing can climb out, and a mask leaves no trace. */
export function safeName(text, fallback) {
	const clean = String(text ?? '').replace(/\[masked:[^\]]*\]/g, ' ').normalize('NFC').replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '-').replace(/^[-.]+/, '')
	return [...clean].slice(0, NAME_CHARS).join('').replace(/[-.]+$/, '') || fallback
}

function render(id, s, files) {
	const { facts, summary, next, messages } = s
	const line = (label, value) => (value ? [`- **${label}:** ${value}`] : [])
	const out = [
		`# ${String(facts.title ?? '').replace(/\s+/g, ' ').trim() || `Session ${id.slice(0, 8)}`}`,
		'',
		...line('Project', basename(facts.repo || facts.cwd || '')),
		...line('Repository', facts.repo),
		...line('Folder', facts.cwd),
		...line('Branch', facts.branch),
		...line('Ticket', facts.ticket),
		...line('Started', when(facts.started_at)),
		...line('Last activity', when(facts.last_event_at)),
		...line('Active', `${Math.round(facts.active_ms / 60_000)} min`),
		...line('Counts', `${facts.prompts} prompts, ${facts.answers} answers`),
		...line('Session', id),
		'',
	]
	if (summary) out.push(`**Summary:** ${summary}`, '')
	if (next) out.push(`**Next:** ${next}`, '')
	if (files.length) out.push('## Files changed', '', ...files.map((f) => `- ${f}`), '')
	if (facts.commits.length) out.push('## Commits', '', ...facts.commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.subject ?? ''}`.trimEnd()), '')
	out.push('Tool calls are not stored in the session database, so tool activity shows only as the files and commits above.', '', '---', '')
	for (const m of messages) out.push(`## ${ROLE[m.role]} · ${when(m.at)}`, '', m.text, '')
	// Session text can quote these marks, this very file's included: inside the block they are never live.
	return out.join('\n').replaceAll(MARK, MARK.replace('<', '&lt;'))
}

const blockOf = (id, body) => `${beginOf(id)}: made by wp-brain memory export. This block is replaced on each export, and your text outside it stays. -->\n${body}\n${endOf(id)}`

/** Where a mark starts at the beginning of a line, from `from`, or -1. */
function lineStart(text, mark, from = 0) {
	if (from === 0 && text.startsWith(mark)) return 0
	const at = text.indexOf(`\n${mark}`, Math.max(from - 1, 0))
	return at === -1 ? -1 : at + 1
}

/** The file's text with its block replaced, or null when its marks are not whole. */
function replaceBlock(text, id, block) {
	const start = lineStart(text, beginOf(id))
	if (start === -1) return null
	const end = lineStart(text, endOf(id), start)
	if (end === -1) return null
	return `${text.slice(0, start)}${block}${text.slice(end + endOf(id).length)}`
}

function listFiles(root) {
	if (!existsSync(root)) return []
	const out = []
	for (const project of readdirSync(root, { withFileTypes: true })) {
		if (!project.isDirectory()) continue
		for (const f of readdirSync(join(root, project.name), { withFileTypes: true })) if (f.name.endsWith('.md') && !f.name.startsWith('.')) out.push(join(root, project.name, f.name))
	}
	return out
}

const isLink = (p) => {
	try {
		return lstatSync(p).isSymbolicLink()
	} catch {
		return false
	}
}

/** This session's existing file: { path, text } with its marks, { path, kept: true } when it must be left alone, or null when it has none. */
function existing(files, id) {
	const tails = [`_${safeName(id, 'session').slice(0, 8)}.md`, `_${safeName(id, 'session')}.md`]
	const hits = files.filter((f) => tails.some((tail) => f.endsWith(tail)))
	let bare = null
	for (const path of hits) {
		if (isLink(path)) {
			bare ??= path // never read or written through
			continue
		}
		const text = readFileSync(path, 'utf8')
		if (text.includes(beginOf(id))) return { path, text }
		if (!text.includes(MARK)) bare ??= path
	}
	return bare ? { path: bare, kept: true } : null
}

function ensureFolder(root, dir) {
	for (const d of [root, dir]) {
		mkdirSync(d, { recursive: true, mode: 0o700 })
		chmodSync(d, 0o700)
	}
}

function writeFile(path, text) {
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.partial`)
	rmSync(tmp, { force: true })
	try {
		writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
		renameSync(tmp, path)
	} catch (e) {
		rmSync(tmp, { force: true })
		throw e
	}
}

/** A name for a new file: the short id, or the whole id when another session already has that one. */
function newPath(root, id, facts) {
	const dir = join(root, safeName(basename(facts.repo || facts.cwd || ''), 'no-project'))
	const date = new Date(facts.started_at ?? facts.last_event_at ?? 0).toISOString().slice(0, 10)
	const stem = `${date}_${safeName(String(facts.title ?? '').toLowerCase(), 'session')}`
	const short = join(dir, `${stem}_${safeName(id, 'session').slice(0, 8)}.md`)
	return existsSync(short) ? join(dir, `${stem}_${safeName(id, 'session')}.md`) : short
}

/** The ids to export: one by id or printed prefix, or every session with text, optionally only those active since a time. */
function sessionIds(db, session, since) {
	if (session !== undefined) {
		const found = showSession(db, session)
		if (!found) throw new Error(`No session ${session} in the database.`)
		if (found.ambiguous) throw new Error(`${session} matches more than one session: give more of its id.`)
		return [found.facts.id]
	}
	const hasText = "EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.agent_id IS NULL AND m.role IN ('prompt', 'answer', 'note'))"
	const rows = Number.isFinite(since)
		? db.prepare(`SELECT s.id FROM sessions s WHERE ${hasText} AND s.last_event_at >= ? ORDER BY s.started_at, s.id`).all(since)
		: db.prepare(`SELECT s.id FROM sessions s WHERE ${hasText} ORDER BY s.started_at, s.id`).all()
	return rows.map((r) => r.id)
}

function exportOne(db, id, root, files, onSession) {
	db.exec('BEGIN')
	let s
	let edited
	try {
		edited = db.prepare('SELECT path FROM session_files WHERE session_id = ? ORDER BY path').all(id).map((r) => r.path) // the first read fixes the moment
		onSession?.(id)
		s = showSession(db, id, { text: true })
	} finally {
		db.exec('COMMIT')
	}
	const block = blockOf(id, render(id, s, edited))
	const found = existing(files, id)
	if (found?.kept) return { state: 'kept' }
	if (found) {
		const text = replaceBlock(found.text, id, block)
		if (text === null) return { state: 'kept' }
		ensureFolder(root, dirname(found.path))
		if (text === found.text) {
			chmodSync(found.path, 0o600)
			return { state: 'unchanged' }
		}
		writeFile(found.path, text)
		return { state: 'written', bytes: Buffer.byteLength(text) }
	}
	const path = newPath(root, id, s.facts)
	ensureFolder(root, dirname(path))
	const text = `${block}\n`
	writeFile(path, text)
	files.push(path)
	return { state: 'written', bytes: Buffer.byteLength(text) }
}

/**
 * Writes the files. opts: { root, session, since (ms), onSession (a test's seam, called inside the read) }. One session failing doesn't stop
 * the rest. Returns counts only: { sessions, written, unchanged, kept, errors, lastErrorCode, bytes }.
 */
export function exportSessions(db, { root, session, since, onSession } = {}) {
	const out = { sessions: 0, written: 0, unchanged: 0, kept: 0, errors: 0, lastErrorCode: null, bytes: 0 }
	const files = listFiles(root)
	for (const id of sessionIds(db, session, since)) {
		out.sessions++
		try {
			const r = exportOne(db, id, root, files, onSession)
			out[r.state]++
			out.bytes += r.bytes ?? 0
		} catch (error) {
			out.errors++
			out.lastErrorCode = errorCode(error)
		}
	}
	return out
}
