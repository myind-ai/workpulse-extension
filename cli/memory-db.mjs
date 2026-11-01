// The session-memory database: open, schema, and the one function that writes session text. This database is not
// disposable: nothing here deletes or recreates it, and a corrupt file is reported to the caller and left in place.
//
// Loads no secret shapes until a writer asks for them (loadMask), so the session-start hook can open it read-only
// without pulling in bridge.ts.

import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { memoryDbPath, ticketOf } from './claude-files.mjs'

export const SCHEMA_VERSION = 1
const TOKENIZE = `tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co Mn Mc'"`

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE files (
	path TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, inode INTEGER, size INTEGER, offset INTEGER NOT NULL DEFAULT 0, tail_hash TEXT,
	active_ms INTEGER NOT NULL DEFAULT 0, clock_closed INTEGER NOT NULL DEFAULT 0, clock_start INTEGER, clock_last INTEGER,
	unknown_since_text INTEGER NOT NULL DEFAULT 0, unknown_user_rows INTEGER NOT NULL DEFAULT 0, odd_lines INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX files_session ON files(session_id);
CREATE TABLE sessions (
	id TEXT PRIMARY KEY, repo TEXT, cwd TEXT, branch TEXT, ticket TEXT, title TEXT, entrypoint TEXT, started_at INTEGER, last_event_at INTEGER,
	active_ms INTEGER NOT NULL DEFAULT 0, prompts INTEGER NOT NULL DEFAULT 0, answers INTEGER NOT NULL DEFAULT 0, commit_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_repo ON sessions(repo, last_event_at);
CREATE TABLE messages (
	id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uuid TEXT NOT NULL, block INTEGER NOT NULL, role TEXT NOT NULL, subtype TEXT, at INTEGER, agent_id TEXT, text TEXT NOT NULL,
	UNIQUE(uuid, block)
);
CREATE INDEX messages_session ON messages(session_id, at);
CREATE TABLE session_files (session_id TEXT NOT NULL, path TEXT NOT NULL, UNIQUE(session_id, path));
CREATE TABLE session_commits (session_id TEXT NOT NULL, sha TEXT NOT NULL, subject TEXT, at INTEGER, UNIQUE(session_id, sha));
CREATE TABLE commit_calls (session_id TEXT NOT NULL, call_hash TEXT NOT NULL, dirs TEXT, at INTEGER, state TEXT NOT NULL DEFAULT 'pending', UNIQUE(session_id, call_hash));
CREATE TABLE summaries (session_id TEXT PRIMARY KEY, at INTEGER, text TEXT, next TEXT);
CREATE TABLE archive (
	id INTEGER PRIMARY KEY, source_table TEXT NOT NULL, source_id TEXT NOT NULL, session_id TEXT, project TEXT, type TEXT, title TEXT, text TEXT, at INTEGER,
	promoted_entry TEXT, promoted_at INTEGER, UNIQUE(source_table, source_id)
);
CREATE TABLE import_state (source_table TEXT PRIMARY KEY, last_id INTEGER, rows INTEGER NOT NULL DEFAULT 0, at INTEGER);
CREATE TABLE capture_log (at INTEGER NOT NULL, kind TEXT NOT NULL, session_id TEXT, detail TEXT);
CREATE INDEX capture_log_at ON capture_log(at);
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', ${TOKENIZE});
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
	INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE VIRTUAL TABLE archive_fts USING fts5(title, text, content='archive', content_rowid='id', ${TOKENIZE});
CREATE TRIGGER archive_ai AFTER INSERT ON archive BEGIN INSERT INTO archive_fts(rowid, title, text) VALUES (new.id, new.title, new.text); END;
CREATE TRIGGER archive_ad AFTER DELETE ON archive BEGIN INSERT INTO archive_fts(archive_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text); END;
CREATE TRIGGER archive_au AFTER UPDATE OF title, text ON archive BEGIN
	INSERT INTO archive_fts(archive_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
	INSERT INTO archive_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;
`

const SQLITE_NAMES = { 1: 'SQLITE_ERROR', 5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 8: 'SQLITE_READONLY', 10: 'SQLITE_IOERR', 11: 'SQLITE_CORRUPT', 13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN', 26: 'SQLITE_NOTADB' }

/** A short code for an error, for status.json: never its message, which can quote a path or a statement. */
export function errorCode(error) {
	const primary = typeof error?.errcode === 'number' ? error.errcode & 0xff : null
	if (primary !== null) return SQLITE_NAMES[primary] || `SQLITE_${primary}`
	return typeof error?.code === 'string' && /^[A-Z_0-9]+$/.test(error.code) ? error.code : 'ERROR'
}

const isBusy = (error) => error?.errcode !== undefined && [5, 6].includes(error.errcode & 0xff)

/** Switching to WAL can report busy without waiting, so this one step retries by hand. */
function retryBusy(step) {
	for (let attempt = 0; ; attempt++) {
		try {
			return step()
		} catch (error) {
			if (!isBusy(error) || attempt >= 40) throw error
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
		}
	}
}

function schemaVersion(db) {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) return 0
	return Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0)
}

function migrate(db) {
	const version = schemaVersion(db)
	if (version > SCHEMA_VERSION) throw Object.assign(new Error('memory database is newer than this code'), { code: 'ERR_MEMORY_SCHEMA_NEWER' })
	if (version === SCHEMA_VERSION) return
	db.exec('BEGIN IMMEDIATE')
	try {
		if (schemaVersion(db) === 0) { // another worker may have got here first
			db.exec(SCHEMA)
			db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION))
		}
		db.exec('COMMIT')
	} catch (error) {
		try { db.exec('ROLLBACK') } catch { /* nothing open */ }
		throw error
	}
}

/** Opens the database. Writable: creates the folder (0700) and file (0600), WAL, schema. readOnly: only opens, and reads the
 * schema version, so a corrupt file, one from newer code or one with no tables yet throws here; a missing file throws. busyMs is for a hook that can't wait. */
export function openMemory(path = memoryDbPath(), { readOnly = false, busyMs = 5000 } = {}) {
	if (readOnly) {
		const db = new DatabaseSync(path, { readOnly: true })
		try {
			db.exec(`PRAGMA busy_timeout = ${Number(busyMs)}`)
			const version = schemaVersion(db)
			if (version > SCHEMA_VERSION) throw Object.assign(new Error('memory database is newer than this code'), { code: 'ERR_MEMORY_SCHEMA_NEWER' })
			if (version === 0) throw Object.assign(new Error('memory database has no tables yet'), { code: 'ERR_MEMORY_NO_TABLES' }) // the next writable open makes them
			return db
		} catch (error) {
			db.close()
			throw error
		}
	}
	const dir = dirname(path)
	const created = !existsSync(dir)
	if (created) mkdirSync(dir, { recursive: true, mode: 0o700 })
	// Only a folder we made or our own default: WP_MEMORY_DB may sit in a folder that is someone else's to set.
	if (created || dir === join(homedir(), '.workpulse', 'memory')) chmodSync(dir, 0o700)
	closeSync(openSync(path, 'a', 0o600))
	chmodSync(path, 0o600)
	const db = new DatabaseSync(path)
	try {
		db.exec('PRAGMA busy_timeout = 5000')
		retryBusy(() => {
			if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') db.exec('PRAGMA journal_mode = WAL')
		})
		db.exec('PRAGMA synchronous = NORMAL')
		migrate(db)
		return db
	} catch (error) {
		db.close()
		throw error
	}
}

let loadedMask = null

/** Loads maskSecrets. A module that calls writeBatch awaits this once at its top. */
export async function loadMask() {
	loadedMask ??= (await import('./memory-mask.mjs')).maskSecrets
	return loadedMask
}

/** The masked form of a key string (a file path, a session id). If masking fails: a hash, which holds no text. */
export function stableKey(value, mask = loadedMask) {
	try {
		const out = mask(value).text
		if (typeof out === 'string') return out
	} catch { /* below */ }
	return `unmaskable:${createHash('sha256').update(value).digest('hex')}`
}

const HEX_SHA = /^[0-9a-f]{40,64}$/

/** Applies one batch in one transaction, offset included. The only function that writes session text.
 *
 * batch: { session?: { id, agent?, cwd, repo, branch, ticketBranch?, title, entrypoint, startedAt, lastEventAt },
 *          messages?: [{ uuid, block, role, subtype?, at, agentId?, text }], files?: [path],
 *          commits?: [{ sha, subject, at }], commitCalls?: [{ hash, dirs, at }], commitResults?: [{ hash, state }],
 *          log?: [{ kind, detail, session? }],  (session: this row's own, when the batch has none and none should be created)
 *          summary?: { session, at, text, next? },  (replaces the session's earlier one; a session row is left to the capture)
 *          file?: { path, sessionId, agentId, inode, size, from, offset, tailHash, activeMs, clock, unknownSinceText, unknownUserRows, oddLines } }
 *
 * Every string is masked first, outside the transaction. A string whose masking throws drops its row and counts it.
 * Returns { rows, dropped }, or { stale: true } when file.from is no longer the stored offset: another worker moved it,
 * and nothing was written. Throws when the database is busy, with the offset unmoved; see isBusyError. */
export function writeBatch(db, batch, { mask = loadedMask } = {}) {
	if (!mask) throw new Error('call loadMask() before writeBatch; nothing was written')
	let dropped = 0
	const clean = (value) => {
		if (value === undefined || value === null) return null
		try {
			const out = mask(String(value)).text
			if (typeof out !== 'string') throw new Error('mask gave no text')
			return out
		} catch {
			dropped++
			return undefined
		}
	}
	const sid = batch.session?.id ?? batch.file?.sessionId ?? null
	const session = sid === null ? null : stableKey(String(sid), mask)
	const messages = []
	for (const m of batch.messages ?? []) {
		const text = clean(m.text)
		const uuid = text === undefined ? undefined : clean(m.uuid)
		const agent = uuid === undefined ? undefined : clean(m.agentId)
		if (text === undefined || uuid === undefined || agent === undefined || text === null) continue
		messages.push({ uuid, block: m.block, role: m.role, subtype: m.subtype ?? null, at: m.at ?? null, agent, text })
	}
	const paths = (batch.files ?? []).map(clean).filter((p) => typeof p === 'string')
	const commits = []
	for (const c of batch.commits ?? []) {
		if (!HEX_SHA.test(c.sha)) { dropped++; continue } // from git and checked: not session text, and masking must not alter it
		const subject = clean(c.subject)
		if (subject !== undefined) commits.push({ sha: c.sha, subject, at: c.at ?? null })
	}
	const calls = (batch.commitCalls ?? []).map((c) => ({ hash: c.hash, at: c.at ?? null, dirs: JSON.stringify((c.dirs ?? []).map(clean).filter((d) => typeof d === 'string')) }))
	const fields = {}
	for (const k of ['cwd', 'repo', 'branch', 'title', 'entrypoint']) fields[k] = clean(batch.session?.[k]) ?? null
	const ticket = ticketOf(clean(batch.session?.ticketBranch) ?? fields.branch) ?? null // from a masked branch, so a secret cannot become a ticket
	const logRows = (batch.log ?? []).map((l) => ({ kind: clean(l.kind), detail: clean(l.detail), session: typeof l.session === 'string' ? stableKey(l.session, mask) : session })).filter((l) => typeof l.kind === 'string' && l.detail !== undefined)
	const summary = batch.summary ? { session: stableKey(String(batch.summary.session), mask), at: batch.summary.at ?? null, text: clean(batch.summary.text), next: clean(batch.summary.next) } : null
	const file = batch.file ? { ...batch.file, key: stableKey(batch.file.path, mask), agent: clean(batch.file.agentId) ?? null } : null

	let rows = 0
	let prompts = 0
	let answers = 0
	let attempts = 0
	db.exec('BEGIN IMMEDIATE')
	try {
		if (file) {
			db.prepare('INSERT OR IGNORE INTO files (path, session_id, agent_id, inode, size, offset, tail_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.run(file.key, session, file.agent, file.inode, file.size, file.from, '')
			const moved = db.prepare(`UPDATE files SET session_id = ?, agent_id = ?, inode = ?, size = ?, offset = ?, tail_hash = ?, active_ms = ?,
				clock_closed = ?, clock_start = ?, clock_last = ?, unknown_since_text = ?, unknown_user_rows = ?, odd_lines = ? WHERE path = ? AND offset = ?`)
				.run(session, file.agent, file.inode, file.size, file.offset, file.tailHash, file.activeMs ?? 0, file.clock?.closed ?? 0, file.clock?.start ?? null, file.clock?.last ?? null, file.unknownSinceText ?? 0, file.unknownUserRows ?? 0, file.oddLines ?? 0, file.key, file.from)
			if (moved.changes === 0) {
				db.exec('ROLLBACK')
				return { rows: 0, dropped: 0, stale: true }
			}
		}
		if (session !== null) {
			db.prepare('INSERT OR IGNORE INTO sessions (id) VALUES (?)').run(session)
			// The main file's newer value wins; a subagent's only fills what is empty, and never sets the title.
			const pick = (col) => (batch.session?.agent ? `COALESCE(${col}, ?)` : `COALESCE(?, ${col})`)
			db.prepare(`UPDATE sessions SET repo = ${pick('repo')}, cwd = ${pick('cwd')}, branch = ${pick('branch')}, ticket = ${pick('ticket')}, title = ${pick('title')}, entrypoint = ${pick('entrypoint')} WHERE id = ?`)
				.run(fields.repo, fields.cwd, fields.branch, ticket, batch.session?.agent ? null : fields.title, fields.entrypoint, session)
			const startedAt = batch.session?.startedAt ?? null
			const lastEventAt = batch.session?.lastEventAt ?? null
			db.prepare('UPDATE sessions SET started_at = min(COALESCE(started_at, ?1), COALESCE(?1, started_at)), last_event_at = max(COALESCE(last_event_at, ?2), COALESCE(?2, last_event_at)) WHERE id = ?3')
				.run(startedAt, lastEventAt, session)
		}
		const counted = new Set()
		const addMessage = db.prepare('INSERT OR IGNORE INTO messages (session_id, uuid, block, role, subtype, at, agent_id, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		for (const m of messages) {
			if (addMessage.run(session, m.uuid, m.block, m.role, m.subtype, m.at, m.agent, m.text).changes === 0) continue
			rows++
			if (m.agent !== null || counted.has(m.uuid)) continue // a line with three text blocks is one prompt
			counted.add(m.uuid)
			if (m.role === 'prompt') prompts++
			if (m.role === 'answer') answers++
		}
		const addPath = db.prepare('INSERT OR IGNORE INTO session_files (session_id, path) VALUES (?, ?)')
		for (const p of paths) rows += addPath.run(session, p).changes
		const addCommit = db.prepare('INSERT OR IGNORE INTO session_commits (session_id, sha, subject, at) VALUES (?, ?, ?, ?)')
		for (const c of commits) rows += addCommit.run(session, c.sha, c.subject, c.at).changes
		const addCall = db.prepare('INSERT OR IGNORE INTO commit_calls (session_id, call_hash, dirs, at) VALUES (?, ?, ?, ?)')
		for (const c of calls) addCall.run(session, c.hash, c.dirs, c.at)
		const settle = db.prepare("UPDATE commit_calls SET state = ? WHERE session_id = ? AND call_hash = ? AND state = 'pending'")
		for (const r of batch.commitResults ?? []) if (settle.run(r.state, session, r.hash).changes && r.state === 'none') attempts++
		if (session !== null && (prompts || answers || attempts)) {
			db.prepare('UPDATE sessions SET prompts = prompts + ?, answers = answers + ?, commit_attempts = commit_attempts + ? WHERE id = ?').run(prompts, answers, attempts, session)
		}
		if (file && file.agent === null) {
			db.prepare('UPDATE sessions SET active_ms = (SELECT COALESCE(SUM(active_ms), 0) FROM files WHERE session_id = ?1 AND agent_id IS NULL) WHERE id = ?1').run(session)
		}
		if (summary && typeof summary.text === 'string' && summary.next !== undefined) {
			rows += db.prepare('INSERT OR REPLACE INTO summaries (session_id, at, text, next) VALUES (?, ?, ?, ?)').run(summary.session, summary.at, summary.text, summary.next).changes
		}
		const log = db.prepare('INSERT INTO capture_log (at, kind, session_id, detail) VALUES (?, ?, ?, ?)')
		const now = Date.now()
		for (const l of logRows) log.run(now, l.kind, l.session, l.detail)
		if (dropped) log.run(now, 'mask_failed', session, String(dropped))
		db.exec('COMMIT')
	} catch (error) {
		try { db.exec('ROLLBACK') } catch { /* nothing open */ }
		throw error
	}
	return { rows, dropped }
}

export const isBusyError = isBusy

/** Writes one batch of archive rows (claude-mem's history) in one transaction, with the source's progress. Same rule as writeBatch: every
 * string is masked first, outside the transaction, and a row whose masking throws is dropped and counted, never stored raw.
 *
 * batch: { table, rows: [{ id, session, project, type, title, text, at }], lastId }  (id is the source row's id; lastId moves import_state)
 * Returns { added, dropped }. Throws when the database is busy, with import_state unmoved. */
export function writeArchive(db, batch, { mask = loadedMask } = {}) {
	if (!mask) throw new Error('call loadMask() before writeArchive; nothing was written')
	let dropped = 0
	const clean = (value) => {
		if (value === undefined || value === null) return null
		const out = mask(String(value)).text
		if (typeof out !== 'string') throw new Error('mask gave no text')
		return out
	}
	const rows = []
	for (const r of batch.rows) {
		try {
			rows.push({ id: String(r.id), session: r.session == null ? null : stableKey(String(r.session), mask), project: clean(r.project), type: clean(r.type), title: clean(r.title), text: clean(r.text) ?? '', at: r.at ?? null })
		} catch {
			dropped++
		}
	}
	let added = 0
	db.exec('BEGIN IMMEDIATE')
	try {
		const add = db.prepare('INSERT OR IGNORE INTO archive (source_table, source_id, session_id, project, type, title, text, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		for (const r of rows) added += add.run(batch.table, r.id, r.session, r.project, r.type, r.title, r.text, r.at).changes
		db.prepare(`INSERT INTO import_state (source_table, last_id, rows, at) VALUES (?1, ?2, ?3, ?4)
			ON CONFLICT(source_table) DO UPDATE SET last_id = max(COALESCE(last_id, 0), ?2), rows = rows + ?3, at = ?4`).run(batch.table, batch.lastId, added, Date.now())
		if (dropped) db.prepare('INSERT INTO capture_log (at, kind, session_id, detail) VALUES (?, ?, NULL, ?)').run(Date.now(), 'mask_failed', `archive ${batch.table}: ${dropped}`)
		db.exec('COMMIT')
	} catch (error) {
		try { db.exec('ROLLBACK') } catch { /* nothing open */ }
		throw error
	}
	return { added, dropped }
}

/** Marks archive rows promoted (the second step of a promotion; the entry is written first), after their entries are written: [{ id, entry }]. One short transaction; a row already marked keeps its mark. */
export function markPromoted(db, marks) {
	const now = Date.now()
	db.exec('BEGIN IMMEDIATE')
	try {
		const set = db.prepare("UPDATE archive SET promoted_entry = ?, promoted_at = ? WHERE source_table = 'observations' AND source_id = ? AND promoted_entry IS NULL")
		for (const m of marks) set.run(m.entry, now, String(m.id))
		db.exec('COMMIT')
	} catch (error) {
		try { db.exec('ROLLBACK') } catch { /* nothing open */ }
		throw error
	}
}

// ── searching and showing ───────────────────────────────────────────────────

const MAX_WORDS = 12
const SNIPPET_CHARS = 200
// brain-db.mjs has no exported query escaper (its own is private to ranking), so this is the Decisions table's rule, kept here.

/** An FTS5 query from free text: every word becomes `"word"*`, joined by AND. Punctuation, quotes, operators and a lone `*` can't
 * raise a syntax error, because only letters, numbers and combining marks (so Devanagari vowel signs) are kept. Null when no word is left. */
export function ftsQuery(text) {
	const words = String(text ?? '').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
	if (!words.length) return null
	return words.slice(0, MAX_WORDS).map((w) => `"${w.replace(/"/g, '""')}"*`).join(' AND ')
}

export const oneLine = (text, max) => {
	const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
	const chars = [...flat]
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

/** Hits in session text, best first by bm25: { session_id, role, at, repo, snippet }. Prompts, answers and notes only; subagent text
 * only with `agents`; the `injected` role (hook and system text) only when asked for by name. A snippet is one line of at most 200
 * characters, so a search costs a bounded number of tokens. The archive is never searched here. `since` is a time in ms. */
export function searchMemory(db, text, { repo, role, session, agents = false, since, limit = 10 } = {}) {
	const query = ftsQuery(text)
	if (query === null) return []
	const where = ['messages_fts MATCH ?']
	const args = [query]
	if (role) { where.push('m.role = ?'); args.push(String(role)) } else where.push("m.role IN ('prompt', 'answer', 'note')")
	if (!agents) where.push('m.agent_id IS NULL')
	// Literal comparisons, not LIKE: `%` and `_` in a name mean themselves, and case counts.
	if (session) { where.push('substr(m.session_id, 1, length(?)) = ?'); args.push(String(session), String(session)) } // a printed prefix works, as it does for show
	if (repo) { where.push("(s.repo = ? OR substr(s.repo, -(length(?) + 1)) = '/' || ?)"); args.push(String(repo), String(repo), String(repo)) }
	if (Number.isFinite(since)) { where.push('m.at >= ?'); args.push(since) }
	const cut = Math.min(Math.max(Math.trunc(Number(limit)) || 10, 1), 100)
	const rows = db.prepare(`SELECT m.session_id, m.role, m.at, s.repo, snippet(messages_fts, 0, '', '', '…', 24) AS snippet
		FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid LEFT JOIN sessions s ON s.id = m.session_id
		WHERE ${where.join(' AND ')} ORDER BY bm25(messages_fts), m.at DESC LIMIT ?`).all(...args, cut)
	return rows.map((r) => ({ session_id: r.session_id, role: r.role, at: r.at, repo: r.repo, snippet: oneLine(r.snippet, SNIPPET_CHARS) }))
}

/** One session by id or unique prefix: { facts, summary, next, messages? }, or { ambiguous: [ids] }, or null. `text` adds its masked
 * prompts, answers and notes in order (the main file's, not subagents'). The facts and summary are all that a default `show` prints. */
export function showSession(db, idOrPrefix, { text = false } = {}) {
	const like = String(idOrPrefix).replace(/[\\%_]/g, '\\$&')
	const found = db.prepare("SELECT id FROM sessions WHERE id = ?1 OR id LIKE ?2 || '%' ESCAPE '\\' ORDER BY id = ?1 DESC, id LIMIT 6").all(String(idOrPrefix), like)
	if (!found.length) return null
	if (found.length > 1 && found[0].id !== String(idOrPrefix)) return { ambiguous: found.map((f) => f.id) }
	const id = found[0].id
	const facts = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
	const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get(id).n
	const out = {
		facts: { ...facts, edits: count('session_files'), commits: db.prepare('SELECT sha, subject FROM session_commits WHERE session_id = ? ORDER BY at').all(id).map((c) => ({ ...c })) },
		summary: null,
		next: null,
	}
	const summary = db.prepare('SELECT text, next FROM summaries WHERE session_id = ?').get(id)
	if (summary) { out.summary = summary.text; out.next = summary.next }
	if (text) out.messages = db.prepare("SELECT role, at, text FROM messages WHERE session_id = ? AND agent_id IS NULL AND role IN ('prompt', 'answer', 'note') ORDER BY at, id").all(id).map((m) => ({ ...m }))
	return out
}
