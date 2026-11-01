// Reads session files from their stored byte offset into the memory database. Never reads a whole file; parsing and
// the git checks happen outside the transaction. Runs as a detached, niced worker started by a hook:
//   node cli/memory-capture.mjs [--session ID --transcript PATH] [--since MS] [--missed JSON] [--note-shown TOKENS]
// The worker catches everything and reports counts and codes in status.json, next to the database.

import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { setPriority } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { gitIn as git, isExcludedProject, mainTranscripts, memoryDbPath, memorySessionsDir, projectsRoot, repoKey, subagentFiles, ticketOf } from './claude-files.mjs'
import { errorCode, isBusyError, loadMask, openMemory, stableKey, writeBatch } from './memory-db.mjs'
import { storedFiles, tailHash, unreadHoldsMessage } from './memory-note.mjs'
import { BOOKKEEPING, commitTokens, parseLine, stripWorktree } from './memory-parse.mjs'

export { parseLine, repoKey }

// Held as null when it will not load (bridge.ts is the fragile link): the worker reports that, and nothing is captured.
let maskSecrets = null
try {
	maskSecrets = await loadMask()
} catch { /* runWorker and captureFile refuse */ }

const CHUNK = 1024 * 1024
const MAX_LINE = 32 * 1024 * 1024
const MAX_BATCH_BYTES = 16 * 1024 * 1024
const MAX_BATCH_ROWS = 2000
const IDLE_GAP = 20 * 60_000 // scan-claude's default, so the timesheet and the memory tell the same story
const MIN_SEGMENT = 60_000 // scan-claude drops a burst shorter than this
const DRIFT_ROWS = 20
const DRIFT_ODD = 50
const COMMIT_MAX_AGE = 5 * 60_000 // a commit this much older than its call was not made by it

// ── git ─────────────────────────────────────────────────────────────────────

/** The first token that git knows as a commit in one of the folders, with git's own subject. One well older than its call
 * proves nothing: `git commit; git log -1` with nothing to commit prints the last one. */
function proveCommit(dirs, content, callAt) {
	const tokens = commitTokens(content)
	if (!tokens.length) return null
	for (const dir of dirs) {
		if (!existsSync(dir)) continue
		const answer = git(dir, ['cat-file', '--batch-check'], `${tokens.join('\n')}\n`)
		const shas = answer?.split('\n').filter((line) => / commit \d+$/.test(line)).map((line) => line.split(' ')[0])
		if (!shas?.length) continue
		const shown = git(dir, ['log', '--no-walk=unsorted', '--format=%H%x00%ct%x00%s', ...shas])
		for (const line of shown?.split('\n') ?? []) {
			const [full, seconds, subject] = line.split('\0')
			if (!full || seconds === undefined) continue
			if (typeof callAt === 'number' && Number(seconds) * 1000 < callAt - COMMIT_MAX_AGE) continue
			return { sha: full, subject: subject ?? '' }
		}
	}
	return null
}

// ── the reader ──────────────────────────────────────────────────────────────

/** Complete lines from a byte position, read in chunks: { line: Buffer | null (too long), end }. A tail with no newline is not yielded.
 * A yielded buffer is valid until the next step. */
function* completeLines(fd, start) {
	const chunk = Buffer.allocUnsafe(CHUNK)
	let pos = start
	let parts = []
	let held = 0
	let over = false
	for (;;) {
		const n = readSync(fd, chunk, 0, CHUNK, pos)
		if (n === 0) return
		const view = chunk.subarray(0, n)
		let from = 0
		for (;;) {
			const nl = view.indexOf(0x0a, from)
			if (nl === -1) break
			const end = pos + nl + 1
			if (over || held + nl - from > MAX_LINE) yield { line: null, end }
			else yield { line: parts.length ? Buffer.concat([...parts, view.subarray(from, nl)]) : view.subarray(from, nl), end }
			parts = []
			held = 0
			over = false
			from = nl + 1
		}
		if (from < n && !over) {
			held += n - from
			if (held > MAX_LINE) {
				over = true
				parts = []
			} else parts.push(Buffer.from(view.subarray(from)))
		}
		pos += n
	}
}

const segment = (clock) => (clock.start !== null && clock.last - clock.start >= MIN_SEGMENT ? clock.last - clock.start : 0)
function tick(clock, at) {
	if (clock.last === null) {
		clock.start = at
		clock.last = at
	} else if (at > clock.last) {
		if (at - clock.last > IDLE_GAP) {
			clock.closed += segment(clock)
			clock.start = at
		}
		clock.last = at
	}
}

const emptyCounts = () => ({ bytes: 0, rows: 0, skipped: 0, dropped: 0, messageLines: 0, texts: 0, batches: 0, busy: false, reset: null, drift: null })
const callHash = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 32)

/** One pass from the stored offset. Returns false when another worker moved the offset, so the pass should start over. */
function readPass(db, fd, path, { sessionId, agentId, mask }, out) {
	const key = stableKey(path, mask)
	const stat = fstatSync(fd)
	const stored = db.prepare('SELECT * FROM files WHERE path = ?').get(key)
	let reset = null
	if (stored) {
		if (stored.inode !== stat.ino) reset = 'inode'
		else if (stat.size < stored.offset) reset = 'shrank'
		else if (tailHash(fd, stored.offset) !== stored.tail_hash) reset = 'rewritten'
	}
	if (reset) out.reset = reset
	else if (stored && stat.size === stored.offset) return true

	const fresh = !stored || reset
	const clock = fresh ? { closed: 0, start: null, last: null } : { closed: stored.clock_closed, start: stored.clock_start, last: stored.clock_last }
	const counters = { unknownSinceText: fresh ? 0 : stored.unknown_since_text, unknownUserRows: fresh ? 0 : stored.unknown_user_rows, oddLines: fresh ? 0 : stored.odd_lines }
	const start = fresh ? 0 : stored.offset
	let from = stored ? stored.offset : 0
	let position = start
	let counted = start

	const sessionKey = stableKey(sessionId, mask)
	const pending = new Map(db.prepare("SELECT call_hash, dirs, at FROM commit_calls WHERE session_id = ? AND state = 'pending'").all(sessionKey).map((c) => [c.call_hash, { dirs: JSON.parse(c.dirs || '[]'), at: c.at }]))

	let batch
	let batchBytes
	let batchRows
	let badLines
	let held // line counts, added to `out` only once their batch is stored: a pass that lost a race starts over
	const begin = () => {
		batch = { session: { id: sessionId, agent: Boolean(agentId) }, messages: [], files: [], commits: [], commitCalls: [], commitResults: [], log: [] }
		batchBytes = 0
		batchRows = 0
		badLines = 0
		held = { messageLines: 0, texts: 0 }
	}
	begin()
	if (reset) batch.log.push({ kind: 'reset', detail: reset })

	/** Writes what is held. False: stop here (busy or stale, the offset is unmoved and `stale` says which). */
	let stale = false
	const flush = () => {
		if (badLines) batch.log.push({ kind: 'bad_lines', detail: String(badLines) })
		batch.file = {
			path, sessionId, agentId: agentId ?? null, inode: stat.ino, size: Math.max(stat.size, position), from, offset: position, tailHash: tailHash(fd, position),
			activeMs: clock.closed + segment(clock), clock: { ...clock }, ...counters,
		}
		let result
		try {
			result = writeBatch(db, batch, { mask })
		} catch (error) {
			if (!isBusyError(error)) throw error
			out.busy = true
			return false
		}
		if (result.stale) {
			stale = true
			return false
		}
		out.bytes += position - counted
		counted = position
		out.rows += result.rows
		out.dropped += result.dropped
		out.skipped += badLines
		out.messageLines += held.messageLines
		out.texts += held.texts
		out.batches++
		from = position
		begin()
		return true
	}

	let unflushed = Boolean(reset)
	for (const { line, end } of completeLines(fd, start)) {
		batchBytes += end - position
		position = end
		unflushed = true
		if (line === null) {
			badLines++
			counters.oddLines++
		} else if (line.length) {
			// One line can never stop a file: whatever it does, it is skipped and counted, and absorb only sees checked values.
			try {
				const row = JSON.parse(line.toString('utf8'))
				if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('not a row')
				if (row.type === 'user' || row.type === 'assistant') {
					held.messageLines++
					counters.oddLines = 0
				} else if (typeof row.type !== 'string' || !BOOKKEEPING.test(row.type)) counters.oddLines++
				const parsed = parseLine(row)
				if (parsed) batchRows += absorb(parsed)
			} catch {
				badLines++
				counters.oddLines++
			}
		}
		if (batchBytes >= MAX_BATCH_BYTES || batchRows >= MAX_BATCH_ROWS) {
			if (!flush()) return !stale
			unflushed = false
		}
	}
	if (unflushed && !flush()) return !stale
	out.drift = counters.unknownSinceText >= DRIFT_ROWS || counters.unknownUserRows >= DRIFT_ROWS ? 'no_text' : counters.oddLines >= DRIFT_ODD ? 'unknown_rows' : null
	return true

	function absorb(parsed) {
		const s = parsed.session
		if (s) {
			if (s.title) batch.session.title = s.title
			if (s.cwd) {
				batch.session.cwd = s.cwd
				batch.session.repo = repoKey(s.cwd)
			}
			if (s.branch) {
				batch.session.branch = s.branch
				if (ticketOf(s.branch)) batch.session.ticketBranch = s.branch // a move to main in this batch keeps the ticket
			}
			if (s.entrypoint) batch.session.entrypoint = s.entrypoint
			if (s.activity && s.at !== null && s.at !== undefined) {
				tick(clock, s.at)
				batch.session.startedAt = Math.min(batch.session.startedAt ?? s.at, s.at)
				batch.session.lastEventAt = Math.max(batch.session.lastEventAt ?? s.at, s.at)
			}
		}
		if (parsed.assistantShape === 'text') {
			held.texts++
			counters.unknownSinceText = 0
		} else if (parsed.assistantShape === 'unknown') counters.unknownSinceText++
		if (parsed.userShape === 'text') counters.unknownUserRows = 0
		else if (parsed.userShape === 'unknown') counters.unknownUserRows++
		for (const m of parsed.messages) batch.messages.push({ ...m, agentId })
		batch.files.push(...parsed.files)
		for (const c of parsed.commitCandidates) {
			const hash = callHash(c.id)
			if (c.kind === 'call') {
				pending.set(hash, { dirs: c.dirs, at: c.at })
				batch.commitCalls.push({ hash, dirs: c.dirs, at: c.at })
			} else if (pending.has(hash)) {
				const call = pending.get(hash)
				pending.delete(hash)
				const proof = c.isError ? null : proveCommit(call.dirs, c.content, call.at)
				if (proof) batch.commits.push({ ...proof, at: c.at })
				batch.commitResults.push({ hash, state: c.isError ? 'error' : proof ? 'proved' : 'none' })
			}
		}
		return parsed.messages.length + parsed.files.length + parsed.commitCandidates.length
	}
}

/** Reads what is new in one session file. A vanished file does nothing: its row and its messages stay.
 * Returns { bytes, rows, skipped, messageLines, dropped, texts, batches, busy, reset, drift }. */
export function captureFile(db, path, { sessionId, agentId = null, mask = maskSecrets } = {}) {
	if (!mask) throw Object.assign(new Error('the secret mask did not load'), { code: 'MASK_UNAVAILABLE' })
	const out = emptyCounts()
	let fd
	try {
		fd = openSync(path, 'r')
	} catch (error) {
		if (error.code === 'ENOENT') return out
		throw error
	}
	try {
		for (let attempt = 0; attempt < 4; attempt++) if (readPass(db, fd, path, { sessionId, agentId, mask }, out)) return out
		out.busy = true // another worker keeps moving this file along; the next run carries on
		return out
	} finally {
		closeSync(fd)
	}
}

const addCounts = (total, one) => {
	for (const k of ['bytes', 'rows', 'skipped', 'dropped', 'messageLines', 'texts']) total[k] += one[k]
	total.busy ||= one.busy
	total.drift ??= one.drift
}

/** Captures a session's main file, then its subagents' files (which belong to it). A worker folder of another tool is skipped. */
export function captureSession(db, { sessionId, transcriptPath, mask }) {
	const total = { sessionId, sessions: 1, files: 0, excluded: false, ...emptyCounts() }
	delete total.batches
	delete total.reset
	if (isExcludedProject(basename(dirname(transcriptPath)))) {
		total.sessions = 0
		total.excluded = true
		return total
	}
	const options = mask ? { mask } : {}
	addCounts(total, captureFile(db, transcriptPath, { sessionId, ...options }))
	total.files++
	for (const file of subagentFiles(transcriptPath)) {
		if (total.busy) break // each file would wait out the timeout; the next run carries on from the offsets
		addCounts(total, captureFile(db, file, { sessionId, agentId: basename(file, '.jsonl').replace(/^agent-/, ''), ...options }))
		total.files++
	}
	return total
}

/** Captures every main session file changed since then, and its subagents. One bad file does not stop the rest. */
export function captureSince(db, sinceMs) {
	const total = { sessions: 0, files: 0, errors: 0, lastErrorCode: null, sessionIds: [], ...emptyCounts() }
	delete total.batches
	delete total.reset
	for (const t of mainTranscripts(projectsRoot())) {
		if (t.mtimeMs < sinceMs) continue
		try {
			const one = captureSession(db, { sessionId: t.sessionId, transcriptPath: t.path })
			addCounts(total, one)
			total.files += one.files
			total.sessions++
			if (one.bytes > 0) total.sessionIds.push(t.sessionId)
			if (one.busy) break // the next run carries on from the offsets
		} catch (error) {
			total.errors++
			total.lastErrorCode = errorCode(error)
		}
	}
	return total
}

// ── backfill ────────────────────────────────────────────────────────────────

/** Every session file on disk, listed and sized, nothing opened: main files first, then the subagent files of those. Another tool's
 * worker folders stay out. Not limited by `capture_since`: backfill is explicit and reads what capture was off for too. */
export function backfillPlan(root = projectsRoot()) {
	const mains = mainTranscripts(root).sort((a, b) => (a.path < b.path ? -1 : 1))
	const files = mains.map((m) => ({ path: m.path, sessionId: m.sessionId, agentId: null, size: m.size }))
	for (const m of mains) {
		for (const path of subagentFiles(m.path)) {
			const size = statSync(path, { throwIfNoEntry: false })?.size
			if (size !== undefined) files.push({ path, sessionId: m.sessionId, agentId: basename(path, '.jsonl').replace(/^agent-/, ''), size })
		}
	}
	return { files, main: mains.length, bytes: files.reduce((sum, f) => sum + f.size, 0) }
}

/** Captures every file in the plan from its stored offset, so a stopped run carries on where it was and a finished one reads nothing.
 * One bad file doesn't stop the rest; a busy database does (the next run resumes). onFile(file, done, total) after each file;
 * onProgress({ done, total, bytes }) every `every` files and at the end. Never called from a hook. */
export function backfill(db, plan, { onFile, onProgress, every = 100, mask } = {}) {
	const total = { files: 0, errors: 0, lastErrorCode: null, stopped: false, ...emptyCounts() }
	delete total.batches
	delete total.reset
	const options = mask ? { mask } : {}
	for (const f of plan.files) {
		try {
			addCounts(total, captureFile(db, f.path, { sessionId: f.sessionId, agentId: f.agentId, ...options }))
		} catch (error) {
			if (error?.code === 'MASK_UNAVAILABLE') throw error
			total.errors++
			total.lastErrorCode = errorCode(error)
		}
		total.files++
		onFile?.(f, total.files, plan.files.length)
		if (total.files % every === 0) onProgress?.({ done: total.files, total: plan.files.length, bytes: total.bytes })
		if (total.busy) { // each file would wait out the timeout; the next run carries on from the offsets
			total.stopped = true
			break
		}
	}
	onProgress?.({ done: total.files, total: plan.files.length, bytes: total.bytes })
	return total
}

// ── the worker ──────────────────────────────────────────────────────────────

const statusPath = () => join(dirname(memoryDbPath()), 'status.json')
const SAFE_ID = /^[\w-]+$/

function writeAtomic(path, text, mode) {
	mkdirSync(dirname(path), { recursive: true, ...(mode === 0o600 ? { mode: 0o700 } : {}) })
	const temp = `${path}.${process.pid}.tmp`
	writeFileSync(temp, text, { mode })
	chmodSync(temp, mode)
	renameSync(temp, path)
}

/** What the Stop hook reads instead of opening the database. Counts and the entrypoint only. */
function refreshMark(db, sessionId) {
	if (!SAFE_ID.test(sessionId)) return
	const key = stableKey(sessionId)
	const row = db.prepare('SELECT prompts, entrypoint FROM sessions WHERE id = ?').get(key)
	if (!row) return
	const edits = db.prepare('SELECT count(*) AS n FROM session_files WHERE session_id = ?').get(key).n
	const commits = db.prepare('SELECT count(*) AS n FROM session_commits WHERE session_id = ?').get(key).n
	writeAtomic(join(memorySessionsDir(), `${sessionId}.memory.json`), JSON.stringify({ prompts: row.prompts, edits, commits, entrypoint: row.entrypoint }), 0o644)
}

function readStatus() {
	try {
		const parsed = JSON.parse(readFileSync(statusPath(), 'utf8'))
		return parsed && typeof parsed === 'object' ? parsed : {}
	} catch {
		return {}
	}
}

/** Merges into status.json: counts and codes only, never text or a path. A later run decides drift when it read something. */
function writeStatus({ run, error }) {
	const status = { lastWriteAt: null, drift: null, ...readStatus() }
	const now = Date.now()
	if (error) status.lastError = { at: now, code: error }
	if (run) {
		const { bytes, rows, skipped, dropped, messageLines, sessions, files, busy } = run
		status.lastRun = { at: now, ms: run.ms, sessions, files, bytes, rows, skipped, dropped, messageLines, busy }
		if (bytes > 0 || rows > 0) status.lastWriteAt = now
		if (run.drift) status.drift = { at: now, code: run.drift }
		else if (run.texts > 0) status.drift = null
	}
	try {
		writeAtomic(statusPath(), `${JSON.stringify(status)}\n`, 0o600)
	} catch { /* nowhere to report it; the next session start notices missed sessions */ }
}

/** What the session-start hook found missed, given as JSON. Broken input is ignored: this is only the log, and the sweep still runs. */
function parseMissed(text) {
	try {
		const list = JSON.parse(text ?? '[]')
		return Array.isArray(list) ? list.filter((m) => typeof m?.sessionId === 'string' && typeof m?.path === 'string') : []
	} catch {
		return []
	}
}

/** Ids and sizes only, in capture_log. Busy here must not cost the capture itself. */
function logMissed(db, rows) {
	if (!rows.length) return
	try {
		writeBatch(db, { log: rows })
	} catch (error) {
		if (!isBusyError(error)) throw error
	}
}

const sizeRow = (kind, { sessionId, path }) => ({ kind, session: sessionId, detail: statSync(path, { throwIfNoEntry: false })?.size ?? null })

/** After catching up: a file gone is lost, one with nothing left unread is recovered. Anything else was not reached (busy), and the next session start finds it again. */
function logOutcomes(db, missed) {
	const stored = storedFiles(db)
	const rows = []
	for (const m of missed) {
		if (!existsSync(m.path)) rows.push(sizeRow('lost', m))
		else if (!unreadHoldsMessage(m.path, stored(m))) rows.push(sizeRow('recovered', m))
	}
	logMissed(db, rows)
}

function argument(argv, name) {
	const i = argv.indexOf(name)
	return i === -1 ? undefined : argv[i + 1]
}

/** The worker's whole life. Catches everything: a hook started it and nobody is listening. */
export function runWorker(argv) {
	let db
	try {
		try { setPriority(0, 10) } catch { /* not allowed here: run at normal priority */ }
		const sessionId = argument(argv, '--session')
		const transcriptPath = argument(argv, '--transcript')
		const since = argument(argv, '--since')
		const noteShown = argument(argv, '--note-shown')
		if (sessionId === undefined && since === undefined && noteShown === undefined) return
		const sinceMs = since === undefined ? null : Number(since)
		const badSession = sessionId !== undefined && (!SAFE_ID.test(sessionId) || !transcriptPath)
		if (badSession || (sinceMs !== null && !Number.isFinite(sinceMs))) {
			writeStatus({ error: 'BAD_ARGS' })
			return
		}
		if (!maskSecrets) {
			writeStatus({ error: 'MASK_UNAVAILABLE' })
			return
		}
		const started = Date.now()
		db = openMemory()
		const missed = parseMissed(argument(argv, '--missed'))
		logMissed(db, missed.map((m) => sizeRow('missed', m)))
		if (/^\d{1,6}$/.test(noteShown ?? '')) logMissed(db, [{ kind: 'note_shown', detail: noteShown }]) // the note's size: the hook's connection is read-only
		const run = { sessions: 0, files: 0, bytes: 0, rows: 0, skipped: 0, dropped: 0, messageLines: 0, texts: 0, busy: false, drift: null }
		let code = null
		if (sessionId !== undefined) {
			const one = captureSession(db, { sessionId, transcriptPath })
			addCounts(run, one)
			run.files += one.files
			run.sessions += one.sessions
			if (!one.excluded) refreshMark(db, sessionId)
		}
		if (sinceMs !== null) {
			const swept = captureSince(db, sinceMs)
			addCounts(run, swept)
			run.files += swept.files
			run.sessions += swept.sessions
			code = swept.lastErrorCode
			for (const id of swept.sessionIds) refreshMark(db, id)
		}
		logOutcomes(db, missed)
		run.ms = Date.now() - started
		writeStatus({ run, error: code })
	} catch (error) {
		writeStatus({ error: errorCode(error) })
	} finally {
		try { db?.close() } catch { /* already gone */ }
	}
}

const isMain = () => {
	try {
		return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
	} catch {
		return false
	}
}
if (isMain()) runWorker(process.argv.slice(2))
