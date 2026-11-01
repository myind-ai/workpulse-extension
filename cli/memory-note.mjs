// What session memory tells you about itself: the check that capture missed a working session, the warning at session
// start, and `wp-brain memory status`. Silent failure is what this project replaces, so the check errs towards saying so.
// Also the live summary: when to ask for one (summaryAsk), storing it (memorySummary), and the capped note built from it (lastSessionNote).
//
// The Stop and session-start hooks import this file: it stays light. No static node:sqlite (memory-db.mjs is imported on demand, so a
// Node without it reaches a warning instead of crashing), no mask, no wp-brain.mjs, no bridge.ts. Only memorySummary writes, for
// `wp-brain memory summary`, loading the mask on demand. The hooks write no data: the worker logs what they found. Opening a WAL database read-only can leave empty `-wal` and `-shm` files beside it; the main
// file is untouched, and the vault names the database by path and snapshots it through SQLite, so it never lists them.
//
// `files.path` holds a masked key and the mask isn't loaded here, so a path holding a secret won't match by itself. Its main
// file's row is then found by session id. A file nothing matches is missed, never healthy.

import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAPS, capLines, tokensOf } from './budget.mjs'
import { captureLowerBound, mainTranscripts, memoryDbPath, projectsRoot, repoKey, stripWorktree } from './claude-files.mjs'

// A tool call, subagent or permission prompt leaves a live session's file still, with messages unread, as no Stop hook has had
// its chance. So a finished turn nobody read is judged at 10 minutes; anything else is mid-turn or killed, and the sweep
// recovers it without loss, so it waits 2 hours. Replay of 792 real session starts: at most 9 warnings with 10 minutes for all, 3 with 2 hours for all.
const GRACE = 10 * 60_000
const LONG_GRACE = 2 * 60 * 60_000
const MAX_SEARCH = 8 * 1024 * 1024 // more unread than this counts as missed without looking
const SEARCH_BUDGET = 64 * 1024 * 1024 // per check, so a large backlog can't hold up session start
const HOOK_BUSY_MS = 200
const TAIL_BYTES = 4096
const MESSAGE_MARKS = [Buffer.from('"type":"user"'), Buffer.from('"type":"assistant"')]
const TURN_END_MARKS = [Buffer.from('"subtype":"turn_duration"'), Buffer.from('"subtype":"stop_hook_summary"')]
const DAY = 24 * 60 * 60_000
const DEFAULT_WINDOW = '14d'
const NOT_OPENED = new Set(['SQLITE_CANTOPEN', 'SQLITE_NOTADB', 'SQLITE_CORRUPT', 'ERR_MEMORY_SCHEMA_NEWER'])
const NOT_AN_ERROR = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED'])

const isTime = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const minute = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
const safeCode = (code) => (typeof code === 'string' && /^\w{1,32}$/.test(code) ? code : 'ERROR') // only ever a code, whatever status.json holds

/** What complete lines hold: 'none' (no message), 'ended' (a message, then a turn-end marker) or 'open' (a message, and the turn not ended). */
function linesHold(bytes) {
	const firstMessage = MESSAGE_MARKS.map((mark) => bytes.indexOf(mark)).filter((at) => at !== -1).reduce((a, b) => Math.min(a, b), Infinity)
	if (firstMessage === Infinity) return 'none'
	return TURN_END_MARKS.some((mark) => bytes.lastIndexOf(mark) > firstMessage) ? 'ended' : 'open'
}

/** The hash of up to 4 KB before a byte position. A stored offset is good only while this still matches. */
export function tailHash(fd, offset) {
	const length = Math.min(offset, TAIL_BYTES)
	const buffer = Buffer.alloc(length)
	if (length) readSync(fd, buffer, 0, length, offset - length)
	return createHash('sha256').update(buffer).digest('hex')
}

/** A function from a session file to its row in `files`, or null. */
export function storedFiles(db) {
	const columns = 'SELECT offset, inode, tail_hash FROM files'
	const byPath = db.prepare(`${columns} WHERE path = ?`)
	const bySession = db.prepare(`${columns} WHERE session_id = ? AND agent_id IS NULL ORDER BY offset DESC LIMIT 1`)
	return ({ path, sessionId }) => byPath.get(path) ?? bySession.get(sessionId) ?? null
}

/** What the bytes the reader has not taken hold: see linesHold. Same reset rules as the reader. Bookkeeping lines come after
 * the last Stop hook, so `size > offset` alone would warn every time. A partial last line isn't taken yet. What can't be
 * searched or read reads as 'ended': judged now, as nothing says a turn is still running. */
function unreadState(path, stored, budget = { left: Infinity }) {
	let fd
	try {
		fd = openSync(path, 'r')
	} catch (error) {
		return error.code === 'ENOENT' ? 'none' : 'ended' // gone is nothing to read; unreadable is something the reader can't take either
	}
	try {
		const { size, ino } = fstatSync(fd)
		const kept = stored && stored.inode === ino && size >= stored.offset && tailHash(fd, stored.offset) === stored.tail_hash
		const from = kept ? stored.offset : 0
		const unread = size - from
		if (unread === 0) return 'none'
		if (unread > MAX_SEARCH || unread > budget.left) return 'ended'
		budget.left -= unread
		const bytes = Buffer.allocUnsafe(unread)
		let got = 0
		while (got < unread) {
			const n = readSync(fd, bytes, got, unread - got, from + got)
			if (n === 0) break
			got += n
		}
		const end = bytes.subarray(0, got).lastIndexOf(0x0a)
		return end === -1 ? 'none' : linesHold(bytes.subarray(0, end))
	} finally {
		closeSync(fd)
	}
}

/** Whether a whole message line is still unread. */
export const unreadHoldsMessage = (path, stored) => unreadState(path, stored) !== 'none'

/** Main session files changed since `since`, holding unread message lines: a finished turn past the grace period, anything else past the long one. Each entry also carries its mtimeMs, for the warning's date. */
export function missedSessions(db, transcripts, { now, since }) {
	if (!isTime(since)) return []
	const stored = storedFiles(db)
	const budget = { left: SEARCH_BUDGET }
	const out = []
	for (const t of transcripts) {
		const age = now - t.mtimeMs
		if (t.mtimeMs < since || age <= GRACE) continue
		const state = unreadState(t.path, stored(t), budget)
		if (state === 'ended' || (state === 'open' && age > LONG_GRACE)) out.push({ sessionId: t.sessionId, path: t.path, mtimeMs: t.mtimeMs })
	}
	return out
}

/** The reason and when it began, from the status alone. */
function statusReason(status) {
	if (status.drift) return { reason: 'file format changed', at: status.drift.at }
	const error = status.lastError
	if (!error || NOT_AN_ERROR.has(error.code)) return null
	if (isTime(status.lastWriteAt) && isTime(error.at) && error.at < status.lastWriteAt) return null // the same run can do both: some files read, one failed
	const code = safeCode(error.code)
	return { reason: NOT_OPENED.has(code) ? 'cannot open database' : `last error ${code}`, at: error.at }
}

/** One line, at most 60 tokens, or null when nothing is wrong. Counts, dates and codes only. A cause that stops capture
 * outright (old Node, no node:sqlite, drift, an error) counts at least 1, as this session won't be kept right either. */
export function captureWarning({ openError, status, missed = [], since }) {
	const known = status && typeof status === 'object' ? status : {}
	if (openError?.code) return `WARNING: session memory cannot open its database (${safeCode(openError.code)}). Run: wp-brain memory status`
	const cause = openError?.reason ? { reason: openError.reason } : statusReason(known) ?? (missed.length ? { reason: 'hook did not run' } : null)
	if (!cause) return null
	const from = [cause.at, ...missed.map((m) => m.mtimeMs)].filter(isTime).reduce((a, b) => Math.min(a, b), Infinity)
	const date = from !== Infinity ? from : isTime(since) ? since : Date.now()
	return `WARNING: session memory has not captured ${Math.max(missed.length, 1)} session(s) since ${day(date)} (${cause.reason}). Run: wp-brain memory status`
}

export function readStatus() {
	try {
		const status = JSON.parse(readFileSync(join(dirname(memoryDbPath()), 'status.json'), 'utf8'))
		return status && typeof status === 'object' ? status : {}
	} catch {
		return {}
	}
}

/** memory-db.mjs. Loading node:sqlite warns on some Node versions, and a hook's or a one-line command's output stays clean. */
async function loadMemoryDb() {
	const emit = process.emitWarning
	process.emitWarning = (warning, ...rest) => {
		const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type
		if (type !== 'ExperimentalWarning' || !/sqlite/i.test(String(warning))) emit.call(process, warning, ...rest)
	}
	try {
		return await import('./memory-db.mjs')
	} finally {
		process.emitWarning = emit
	}
}

/** Opens for reading: { db, memoryDb }, or { openError }, or { busy: true }. */
async function openForReading(options = {}) {
	let memoryDb
	try {
		if (process.env.WP_MEMORY_NO_SQLITE) throw new Error('turned off for a test')
		memoryDb = await loadMemoryDb()
	} catch {
		return { openError: { reason: 'node:sqlite missing' } }
	}
	try {
		return { db: memoryDb.openMemory(memoryDbPath(), { readOnly: true, ...options }), memoryDb }
	} catch (error) {
		return memoryDb.isBusyError(error) ? { busy: true } : { openError: { code: memoryDb.errorCode(error) } }
	}
}

/** With no database to compare against: main files changed since the last write, by file time alone, nothing opened. */
function waitingByTime(status, since, now, grace = GRACE) {
	if (!isTime(since)) return []
	const from = Math.max(since, isTime(status.lastWriteAt) ? status.lastWriteAt : 0)
	return mainTranscripts(projectsRoot()).filter((t) => t.mtimeMs >= from && now - t.mtimeMs > grace)
}

/** The check at session start: { text, missed }, read only. `missed` goes to the worker, which logs it before catching up. */
export async function captureCheck(cfg, { now = Date.now(), tooOld = false } = {}) {
	const status = readStatus()
	const since = captureLowerBound(cfg)
	const cannotRun = (reason) => ({ text: captureWarning({ openError: { reason }, status, missed: waitingByTime(status, since, now), since }), missed: [] })
	// In WAL mode a writer doesn't block readers, so a read that stays busy is unusual and may last. Time alone says if it matters.
	const locked = () => {
		const waiting = waitingByTime(status, since, now, LONG_GRACE)
		return { text: captureWarning({ status, since, missed: waiting, ...(waiting.length ? { openError: { reason: 'cannot open database' } } : {}) }), missed: [] }
	}
	if (tooOld) return cannotRun('Node too old')
	const { db, memoryDb, openError, busy } = await openForReading({ busyMs: HOOK_BUSY_MS })
	if (openError?.reason) return cannotRun(openError.reason)
	if (openError) return { text: captureWarning({ openError, status, since }), missed: [] }
	if (busy) return locked()
	try {
		const missed = missedSessions(db, mainTranscripts(projectsRoot()), { now, since })
		return { text: captureWarning({ status, missed, since }), missed }
	} catch (error) {
		if (memoryDb.isBusyError(error)) return locked()
		return { text: captureWarning({ openError: { code: memoryDb.errorCode(error) }, status, since }), missed: [] }
	} finally {
		db.close()
	}
}

// ── wp-brain memory status ──────────────────────────────────────────────────

function databaseSize(path) {
	const bytes = [path, `${path}-wal`].reduce((sum, p) => sum + (statSync(p, { throwIfNoEntry: false })?.size ?? 0), 0)
	return `${(bytes / 1048576).toFixed(1)} MB`
}

function logCounts(db, from) {
	const counts = { missed: 0, recovered: 0, lost: 0 }
	for (const row of db.prepare("SELECT kind, count(DISTINCT session_id) AS n FROM capture_log WHERE at >= ? AND kind IN ('missed', 'recovered', 'lost') GROUP BY kind").all(from)) counts[row.kind] = row.n
	return counts
}

/** One row per day a session file last changed: how many were seen and how many have nothing left unread. Null `db`: captured is unknown. */
function sessionsPerDay(db, transcripts) {
	const stored = db ? storedFiles(db) : null
	const days = new Map()
	for (const t of transcripts) {
		const key = day(t.mtimeMs)
		const row = days.get(key) ?? { seen: 0, captured: 0 }
		row.seen++
		if (stored && !unreadHoldsMessage(t.path, stored(t))) row.captured++
		days.set(key, row)
	}
	return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, row]) => `  ${date}  ${String(row.seen).padStart(4)}  ${db ? String(row.captured).padStart(8) : '       ?'}`)
}

/** The lines of `wp-brain memory status [--since 14d]`. Reads only. Throws on a --since it can't read. */
export async function memoryStatusLines(cfg, { now = Date.now(), window = DEFAULT_WINDOW } = {}) {
	const match = typeof window === 'string' ? window.match(/^([1-9]\d{0,4})d$/) : null
	if (!match) throw new Error('--since takes a number of days, like 14d')
	const days = Number(match[1])
	const windowStart = now - days * DAY
	const on = cfg?.memory === true
	const status = readStatus()
	const dbPath = memoryDbPath()
	const since = captureLowerBound(cfg)
	const lines = [`Session memory: ${on ? 'on' : 'off'}${isTime(cfg?.capture_since) ? ` since ${day(cfg.capture_since)}` : ''}`]
	lines.push(`Last write: ${isTime(status.lastWriteAt) ? minute(status.lastWriteAt) : 'none yet'}`)

	const opened = on || existsSync(dbPath) ? await openForReading() : {}
	let { db, openError, busy } = opened
	try {
		const counted = isTime(since) ? mainTranscripts(projectsRoot()).filter((t) => t.mtimeMs >= Math.max(since, windowStart)) : []
		let missed = []
		let rows = []
		let log = null
		// Everything the database can say comes first, so damage found while reading still leaves the rest of the facts.
		if (db) {
			try {
				if (on) rows = sessionsPerDay(db, counted)
				if (on && isTime(since)) missed = missedSessions(db, mainTranscripts(projectsRoot()), { now, since })
				log = logCounts(db, windowStart)
			} catch (error) {
				if (opened.memoryDb.isBusyError(error)) busy = true
				else openError = { code: opened.memoryDb.errorCode(error) }
				db.close()
				db = null
				missed = []
			}
		}
		if (!db && on) rows = sessionsPerDay(null, counted)
		if (on) {
			lines.push(`Sessions, last ${days} days, counted from ${day(Math.max(isTime(since) ? since : windowStart, windowStart))} (date, seen, captured):`)
			lines.push(...(rows.length ? rows : ['  none']))
			if (!isTime(since)) lines.push('Missed now: not judged, as brain.json has no capture_since. Run: wp-brain memory on')
			else if (busy) lines.push('Missed now: not judged, the database is locked')
			else if (!db) lines.push('Missed now: unknown, the database did not open')
			else {
				const ids = missed.slice(0, 10).map((m) => m.sessionId).join(', ')
				lines.push(`Missed now: ${missed.length}${missed.length ? ` (${ids}${missed.length > 10 ? ', …' : ''})` : ''}`)
			}
		}
		if (log) {
			lines.push(`Capture log (last ${days} days): missed ${log.missed}, recovered ${log.recovered}, lost ${log.lost}`)
		}
		const error = status.lastError
		lines.push(`Last error: ${error ? `${safeCode(error.code)}${isTime(error.at) ? ` at ${minute(error.at)}` : ''}` : 'none'}`)
		lines.push(`Drift: ${status.drift ? `${safeCode(status.drift.code)}${isTime(status.drift.at) ? ` since ${day(status.drift.at)}` : ''}` : 'none'}`)
		const held = existsSync(dbPath)
		if (openError?.code) lines.push(`Database: ${held ? databaseSize(dbPath) : 'no file'}, cannot open (${safeCode(openError.code)}), left as it is: ${dbPath}`)
		else if (openError?.reason) lines.push(`Database: ${held ? databaseSize(dbPath) : 'no file'}, cannot read here (${openError.reason}): ${dbPath}`)
		else if (busy) lines.push(`Database: ${databaseSize(dbPath)}, locked by another process: ${dbPath}`)
		else lines.push(held ? `Database: ${databaseSize(dbPath)}, ${dbPath}` : 'Database: none')
		if (on) {
			const warning = captureWarning({ openError, status, missed: openError?.reason ? waitingByTime(status, since, now) : missed, since })
			lines.push(`Health: ${warning ?? (isTime(since) && db ? 'no problem found' : 'not judged')}`)
		}
	} finally {
		db?.close()
	}
	return lines
}

/** `wp-brain memory status`: a broken brain.json reads as off, as it does for the hook. */
export async function memoryStatus({ config, since }) {
	let cfg = {}
	try {
		cfg = JSON.parse(readFileSync(config, 'utf8'))
	} catch { /* off */ }
	for (const line of await memoryStatusLines(cfg, since === undefined ? {} : { window: since })) console.log(line)
}

// ── the live summary ────────────────────────────────────────────────────────

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'wp-brain.mjs')
const SAFE_ID = /^[\w-]+$/ // it goes into a command Claude is asked to run
const MAX_ASKS = 2
export const asCount = (n) => (Number.isInteger(n) && n > 0 ? n : 0)

/** What to ask Claude from the Stop hook, or null. Pure: `mark` is the worker's counts plus `asked`, the hook's own record of earlier asks.
 * Stop fires each turn and no hook knows which turn is the last, so: at most two asks, each only after real work. */
export function summaryAsk(mark, input) {
	if (!mark || input?.stop_hook_active || mark.entrypoint !== 'cli') return null
	const id = input?.session_id
	if (typeof id !== 'string' || !SAFE_ID.test(id)) return null
	const prompts = asCount(mark.prompts)
	const commits = asCount(mark.commits)
	const asks = asCount(mark.asked?.count)
	if (asks >= MAX_ASKS) return null
	const due = asks === 0
		? prompts >= 3 && (commits >= 1 || asCount(mark.edits) >= 3)
		: commits - asCount(mark.asked?.commits) >= 1 || prompts - asCount(mark.asked?.prompts) >= 10
	if (!due) return null
	const cli = /^[\w./-]+$/.test(CLI_PATH) ? CLI_PATH : JSON.stringify(CLI_PATH)
	return `Before stopping, save this session's memory: node ${cli} memory summary --session ${id} --next '<next step or none>' '<asked, done, left, under 120 words>'. Nothing else is needed.`
}

const SENTENCE_END = /[.!?…]["')\]]*(?=\s)|[।॥。！？]|\n/g
const NEXT_TOKENS = 40 // the next step shares the summary's cap, and can't take it all

/** `text` within `maxTokens`: up to its last whole sentence; with no sentence end, up to a word and `…`; never inside a letter. */
export function cutToSentence(text, maxTokens) {
	if (tokensOf(text) <= maxTokens) return text
	const room = maxTokens * 4 - Buffer.byteLength('…')
	let used = 0
	let end = 0
	for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
		used += Buffer.byteLength(segment)
		if (used > room) break
		end = index + segment.length
	}
	let sentence = 0
	for (const m of text.slice(0, end + 1).matchAll(SENTENCE_END)) if (m.index + m[0].length <= end) sentence = m.index + m[0].length
	if (sentence > 0) return text.slice(0, sentence).trim()
	const word = text.slice(0, end).search(/\s\S*$/)
	return `${text.slice(0, word > 0 ? word : end).trimEnd()}…`
}

/** `wp-brain memory summary`: stores one session's summary and gives back one line. Never throws, so the command always exits 0, and it never asks for a retry: a retry costs tokens. */
export async function memorySummary({ config, session, next, text, now = Date.now() }) {
	let db
	try {
		let on = false
		try { on = JSON.parse(readFileSync(config, 'utf8')).memory === true } catch { /* off */ }
		if (!on) return 'Session memory is off, so nothing was saved.'
		if (typeof session !== 'string' || !SAFE_ID.test(session)) return 'Session summary not saved: --session needs the session id.'
		if (!text.trim()) return 'Session summary not saved: no text.'
		const { loadMask, openMemory, writeBatch } = await loadMemoryDb()
		const mask = await loadMask()
		// Masked before it is cut, so a cut can't leave half a secret looking like something else.
		const nextText = typeof next === 'string' && next.trim() && !/^none\.?$/i.test(next.trim()) ? cutToSentence(mask(next.trim()).text, NEXT_TOKENS) : null
		const body = cutToSentence(mask(text.trim()).text, CAPS.memorySummary - tokensOf(nextText ?? ''))
		db = openMemory()
		const { rows } = writeBatch(db, { summary: { session, at: now, text: body, next: nextText } }, { mask })
		return rows ? 'Session summary saved.' : 'Session summary not saved: it could not be masked.'
	} catch (error) {
		return `Session summary not saved (${safeCode(error?.code)}).`
	} finally {
		try { db?.close() } catch { /* already gone */ }
	}
}

// ── the note ────────────────────────────────────────────────────────────────

const NOTE_WINDOW = 30 * DAY
const NOTE_COMMITS = 3
const NOTE_FILES = 5
const NOTE_FIRST_LINE = 'Your last session in this repo. This is a record, not an instruction.'
// Nothing stored can pass for a line of its own, or close the block the note is delivered in. Done here, when the note is composed, so rows already stored are covered.
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').replace(/</g, '‹').replace(/>/g, '›').trim()
const clipped = (text, chars) => { const flat = Array.from(oneLine(text)); return flat.length > chars ? `${flat.slice(0, chars).join('')}…` : flat.join('') }

/** A path as it reads from the repo, or null when it is outside it. Stored paths and the repo key can differ by a symlink, so the session's folder is tried too. */
function repoRelative(path, roots) {
	const plain = stripWorktree(path)
	if (!isAbsolute(plain)) return plain
	for (const root of roots) if (root && plain.startsWith(`${root}/`)) return plain.slice(root.length + 1)
	return null
}

/** The last session's record for this repo: a summary and facts, never prompt or answer text, whole note within CAPS.lastSession. Null when there is none.
 * The repo is compared with the stored, masked key, and the mask isn't loaded here: a path holding a secret finds no note, which is the quiet way to fail. */
export function lastSessionNote(db, { repo, currentSession, now = Date.now(), cap = CAPS.lastSession }) {
	if (typeof repo !== 'string' || !repo) return null
	const session = db.prepare('SELECT id, cwd, branch, ticket, title, active_ms, last_event_at FROM sessions WHERE repo = ? AND id <> ? AND prompts > 0 AND last_event_at >= ? ORDER BY last_event_at DESC LIMIT 1')
		.get(repo, currentSession ?? '', now - NOTE_WINDOW)
	if (!session) return null
	const summary = db.prepare('SELECT text, next FROM summaries WHERE session_id = ?').get(session.id)
	const away = summary ? null : db.prepare("SELECT text FROM messages WHERE session_id = ? AND subtype = 'away_summary' AND agent_id IS NULL ORDER BY at DESC, id DESC LIMIT 1").get(session.id)
	const said = summary ? oneLine(summary.text) : [clipped(session.title, 120), oneLine(away?.text)].filter(Boolean).join('. ')
	const next = oneLine(summary?.next)
	const minutes = Math.round(session.active_ms / 60_000)
	const facts = [day(session.last_event_at), minutes ? `${minutes} min` : 'under 1 min', session.branch && `branch ${clipped(session.branch, 60)}`, session.ticket && `ticket ${session.ticket}`].filter(Boolean).join(', ')
	let commits = db.prepare('SELECT sha, subject FROM session_commits WHERE session_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(session.id, NOTE_COMMITS)
	const roots = [repo, session.cwd && stripWorktree(session.cwd)]
	let files = db.prepare('SELECT path FROM session_files WHERE session_id = ? ORDER BY rowid DESC').all(session.id).map((f) => repoRelative(f.path, roots)).filter(Boolean)
	files = [...new Set(files)].slice(0, NOTE_FILES)
	const lead = summary ? 'Summary: ' : '(no summary written) '
	const compose = (text) => [
		NOTE_FIRST_LINE,
		facts,
		`${lead}${text}`.trimEnd(),
		...(next ? [`Next: ${next}`] : []),
		...commits.map((c) => `Commit ${c.sha.slice(0, 7)} ${clipped(c.subject, 80)}`),
		...(files.length ? [`Files: ${files.map((f) => clipped(f, 120)).join(', ')}`] : []),
	].join('\n')
	const over = () => tokensOf(compose(said)) > cap
	while (over() && files.length) files = files.slice(0, -1)
	while (over() && commits.length) commits = commits.slice(0, -1)
	if (!over()) return compose(said)
	const room = cap - tokensOf(compose(''))
	const fitted = compose(room > 0 ? cutToSentence(said, room) : '')
	return capLines(fitted.split('\n'), cap).lines.join('\n') // a next step or facts stored too long still can't pass the cap
}

/** Whether this session start is a fresh one: a resumed or compacted session already knows. */
export const freshStart = (input) => input?.source === 'startup' || input?.source === 'clear'

/** The note for a session that just began, and its size. Only a fresh start gets one. Quiet on any failure: the warning reports a database that won't open. `besides` shares the note's cap. */
export async function sessionNote(input, { now = Date.now(), besides = '' } = {}) {
	if (!freshStart(input)) return null
	const repo = repoKey(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd())
	const { db } = await openForReading({ busyMs: HOOK_BUSY_MS })
	if (!db) return null
	try {
		const text = lastSessionNote(db, { repo, currentSession: input.session_id, now, cap: CAPS.lastSession - tokensOf(besides && `${besides}\n`) })
		return text ? { text, tokens: tokensOf(text) } : null
	} catch {
		return null
	} finally {
		db.close()
	}
}

/** The two rows of `wp-brain budget` while capture is on: the note this folder would get, and the largest summary kept. */
export async function memoryBudget(cwd, { now = Date.now() } = {}) {
	if (!existsSync(memoryDbPath())) return { empty: true } // normal just after `memory on`
	const { db } = await openForReading()
	if (!db) return { unreadable: true }
	try {
		const note = lastSessionNote(db, { repo: repoKey(cwd), currentSession: null, now })
		const summaryTokens = db.prepare('SELECT text, next FROM summaries').all().reduce((most, s) => Math.max(most, tokensOf(s.text) + tokensOf(s.next)), 0)
		return { note, summaryTokens }
	} catch {
		return { unreadable: true }
	} finally {
		db.close()
	}
}
