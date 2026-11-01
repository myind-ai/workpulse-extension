// claude-mem's history as an archive in the memory database: imported read-only, searched only on purpose.
//
// The source is opened with { readOnly: true } and nothing here writes to it, edits its files or touches how it runs. Each batch is its own
// short read, so a live WAL is never held up. Archive rows live in `archive` and `archive_fts` only: plain search, recall, the brief and the
// last-session note never read them. Not for hooks: this runs only from `wp-brain memory import-claude-mem`.
// Checked before writing this: memory-db.mjs has the one writer (writeArchive, beside writeBatch) and searchMemory, whose filters this file's
// search copies (literal comparisons); nothing else imports from claude-mem, so there was nothing to extend.
// Resume is by id (`id > last_id`): a row committed later with a lower id, or a later change to merged_into_project, is not picked up. That
// is incomplete, never duplicated. An idle source (no -wal, no -shm) is opened immutable so the read leaves no journal files beside it; if a
// writer appears during that read, the batch is dropped and read again with a normal open.

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ftsQuery, loadMask, markPromoted, oneLine, stableKey, writeArchive } from './memory-db.mjs'

export const defaultClaudeMemPath = () => join(homedir(), '.claude-mem', 'claude-mem.db')

const SNIPPET_CHARS = 200
const TEXT_PARTS = { // the columns joined, in order, into an archive row's text
	observations: ['subtitle', 'narrative', 'facts', 'concepts', 'files_read', 'files_modified'],
	session_summaries: ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'],
	user_prompts: ['prompt_text'],
}
const REQUIRED = {
	observations: ['id', 'memory_session_id', 'project', 'merged_into_project', 'type', 'title', 'created_at_epoch', ...TEXT_PARTS.observations],
	session_summaries: ['id', 'memory_session_id', 'project', 'merged_into_project', 'created_at_epoch', ...TEXT_PARTS.session_summaries],
	user_prompts: ['id', 'content_session_id', 'created_at_epoch', ...TEXT_PARTS.user_prompts],
}
const TABLES = Object.keys(REQUIRED)

const isIdle = (path) => !existsSync(`${path}-wal`) && !existsSync(`${path}-shm`)

/** The source, read-only, for one short read. */
function openSource(path, idle = isIdle(path)) {
	if (!existsSync(path)) throw Object.assign(new Error(`claude-mem's database is not at ${path}. Pass --db PATH.`), { code: 'ERR_ARCHIVE_NO_SOURCE' })
	// A read-only open of a WAL database nobody holds creates -shm and -wal beside it and leaves them. With neither present the file is idle,
	// so open it immutable (no journal files are made); with either present a writer may be live, so the normal read-only open is the right one.
	const src = new DatabaseSync(idle ? `${pathToFileURL(resolve(path)).href}?immutable=1` : path, { readOnly: true })
	try {
		src.exec('PRAGMA busy_timeout = 5000')
		return src
	} catch (error) {
		src.close()
		throw error
	}
}

/** One batch's read. An immutable open ignores locks and the WAL, so if a writer appeared meanwhile its rows can't be trusted, whether it threw or not: read again normally. */
function readSource(path, read, afterRead = () => {}) {
	const immutable = isIdle(path)
	const src = openSource(path, immutable)
	let rows
	let failure = null
	try {
		rows = read(src)
	} catch (error) {
		failure = error
	} finally {
		src.close()
	}
	afterRead()
	if (immutable && !isIdle(path)) {
		const live = openSource(path, false)
		try {
			return read(live)
		} finally {
			live.close()
		}
	}
	if (failure) throw failure
	return rows
}

const columnsOf = (src, table) => new Set(src.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name))

/** Throws, naming the first missing table or column, before anything is written. */
function checkSchema(src) {
	for (const table of TABLES) {
		const have = columnsOf(src, table)
		if (!have.size) throw Object.assign(new Error(`claude-mem's database has no table ${table}; nothing was imported.`), { code: 'ERR_ARCHIVE_SCHEMA' })
		const missing = REQUIRED[table].find((c) => !have.has(c))
		if (missing) throw Object.assign(new Error(`claude-mem's table ${table} has no column ${missing}; nothing was imported.`), { code: 'ERR_ARCHIVE_SCHEMA' })
	}
}

function lastIds(db) {
	const out = Object.fromEntries(TABLES.map((t) => [t, 0]))
	if (!db) return out
	for (const r of db.prepare('SELECT source_table, last_id FROM import_state').all()) if (r.source_table in out) out[r.source_table] = Number(r.last_id) || 0
	return out
}

/** The archive row for a source row. */
function shape(table, row, projectOf) {
	const text = TEXT_PARTS[table].map((c) => row[c]).filter((v) => typeof v === 'string' && v.trim() !== '').join('\n')
	if (table === 'observations') return { id: row.id, session: row.memory_session_id, project: row.merged_into_project || row.project, type: row.type, title: row.title, text, at: row.created_at_epoch }
	if (table === 'session_summaries') return { id: row.id, session: row.memory_session_id, project: row.merged_into_project || row.project, type: 'summary', title: null, text, at: row.created_at_epoch }
	return { id: row.id, session: row.content_session_id, project: projectOf.get(row.content_session_id) ?? null, type: 'prompt', title: null, text, at: row.created_at_epoch }
}

/** Their project for each prompt's session, when their sessions table has it; otherwise prompts have no project. */
function sessionProjects(src) {
	const have = columnsOf(src, 'sdk_sessions')
	const map = new Map()
	if (!have.has('content_session_id') || !have.has('project')) return map
	for (const r of src.prepare('SELECT content_session_id, project FROM sdk_sessions').all()) if (r.content_session_id && r.project) map.set(r.content_session_id, r.project)
	return map
}

/** Copies claude-mem's history into the archive, from where the last run stopped. Resumable, idempotent (UNIQUE source), and a row appearing
 * in the source later is picked up by the next run. Returns { observations, summaries, prompts, skipped }: rows added this run (with
 * dryRun: rows that would be, and db may be null), and rows dropped because masking failed. Throws with a message naming a missing
 * file, table or column before writing; throws when the memory database is busy, and the next run carries on. */
export async function importClaudeMem(db, sourcePath, { dryRun = false, batch = 2000, mask, afterRead } = {}) {
	if (!dryRun) await loadMask()
	const probe = openSource(sourcePath)
	let last
	let projectOf
	try {
		checkSchema(probe)
		projectOf = sessionProjects(probe)
	} finally {
		probe.close()
	}
	last = lastIds(db)
	const out = { observations: 0, summaries: 0, prompts: 0, skipped: 0 }
	const key = { observations: 'observations', session_summaries: 'summaries', user_prompts: 'prompts' }
	for (const table of TABLES) {
		const cols = ['id', ...REQUIRED[table].filter((c) => c !== 'id')]
		for (;;) {
			const rows = readSource(sourcePath, (src) => (dryRun // one short read per batch
				? [{ n: src.prepare(`SELECT count(*) AS n FROM ${table} WHERE id > ?`).get(last[table]).n }]
				: src.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`).all(last[table], batch)), afterRead)
			if (dryRun) {
				out[key[table]] = rows[0].n
				break
			}
			if (!rows.length) break
			const lastId = rows[rows.length - 1].id
			const done = writeArchive(db, { table, rows: rows.map((r) => shape(table, r, projectOf)), lastId }, mask ? { mask } : undefined)
			out[key[table]] += done.added
			out.skipped += done.dropped
			last[table] = lastId
			if (rows.length < batch) break
		}
	}
	return out
}

// ── searching ───────────────────────────────────────────────────────────────

/** Hits in the archive, best first by bm25: { source_table, source_id, session_id, project, type, at, title, snippet }. `type` and `project` match
 * exactly (literal, case counts: the real data has over 150 odd type values). Only this function reads `archive_fts`. `since` is a time in ms.
 * A snippet is one line of at most 200 characters. */
export function searchArchive(db, text, { type, project, since, limit = 10 } = {}) {
	const query = ftsQuery(text)
	if (query === null) return []
	const where = ['archive_fts MATCH ?']
	const args = [query]
	if (type) { where.push('a.type = ?'); args.push(String(type)) }
	if (project) { where.push('a.project = ?'); args.push(String(project)) }
	if (Number.isFinite(since)) { where.push('a.at >= ?'); args.push(since) }
	const cut = Math.min(Math.max(Math.trunc(Number(limit)) || 10, 1), 100)
	const rows = db.prepare(`SELECT a.source_table, a.source_id, a.session_id, a.project, a.type, a.at, a.title, snippet(archive_fts, 1, '', '', '…', 24) AS snippet
		FROM archive_fts JOIN archive a ON a.id = archive_fts.rowid
		WHERE ${where.join(' AND ')} ORDER BY bm25(archive_fts), a.at DESC LIMIT ?`).all(...args, cut)
	return rows.map((r) => ({ ...r, snippet: oneLine(r.snippet || r.title, SNIPPET_CHARS) }))
}

// ── comparing ───────────────────────────────────────────────────────────────

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

/** A report only: per day, how many sessions each side saw since `since` (ms), and the ones only one side has. Sessions are joined on
 * their sdk_sessions.content_session_id and our masked session id (equal for ordinary ids). Reads both databases, changes neither.
 * { day, sessions, ours, theirs, missedByUs, missedByThem }[], oldest day first. A session counts on its start day, ours when we have it. */
export async function compareWithClaudeMem(db, sourcePath, { since } = {}) {
	const mask = await loadMask()
	const from = Number.isFinite(since) ? since : 0
	const src = openSource(sourcePath)
	let theirs
	try {
		const have = columnsOf(src, 'sdk_sessions')
		for (const c of ['content_session_id', 'started_at_epoch']) if (!have.has(c)) throw Object.assign(new Error(`claude-mem's table sdk_sessions has no column ${c}; nothing was compared.`), { code: 'ERR_ARCHIVE_SCHEMA' })
		theirs = src.prepare('SELECT content_session_id AS id, started_at_epoch AS at FROM sdk_sessions WHERE started_at_epoch >= ? AND content_session_id IS NOT NULL').all(from)
	} finally {
		src.close()
	}
	const ours = db.prepare('SELECT id, started_at AS at FROM sessions WHERE started_at >= ?').all(from)
	const byDay = new Map()
	const slot = (ms) => {
		const d = dayOf(ms)
		if (!byDay.has(d)) byDay.set(d, { day: d, sessions: 0, ours: 0, theirs: 0, missedByUs: 0, missedByThem: 0 })
		return byDay.get(d)
	}
	const mine = new Map(ours.map((r) => [r.id, r.at]))
	const seen = new Set()
	for (const [id, at] of mine) {
		const row = slot(at)
		row.ours++
		row.sessions++
		seen.add(id)
	}
	const theirKeys = new Set()
	for (const r of theirs) {
		const id = stableKey(String(r.id), mask)
		theirKeys.add(id)
		const row = slot(mine.has(id) ? mine.get(id) : r.at)
		row.theirs++
		if (!seen.has(id)) { row.sessions++; row.missedByUs++ }
	}
	for (const [id, at] of mine) if (!theirKeys.has(id)) slot(at).missedByThem++
	return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
}

// ── promoting ───────────────────────────────────────────────────────────────
// A reviewed archive row becomes a Brain lesson only when the owner asks, at most PROMOTE_MAX at a time, and only by a title the reviewer wrote:
// no archived text is copied into the entry. Checked before writing this: bridge's newEntry/duplicateOf/addEntries (cli/wp-brain.mjs) write the
// entry; this file lists candidates and validates the batch, and memory-db.mjs (the one writer) marks rows, so there was nothing to extend.
export { markPromoted }

export const PROMOTE_MAX = 20
export const PROMOTE_KINDS = { decision: 'decision', bugfix: 'debug' } // archive type -> Brain kind
const listing = (message) => Object.assign(new Error(message), { code: 'ERR_PROMOTE' })

/** The marker an entry carries so a re-run finds it: the same on every run for the same archive row. */
export const promotionMarker = (type, id) => `claude-mem ${type} ${id}`

/** Archive rows of type decision or bugfix that are not yet promoted, newest first: { id, at, project, type, title, text }. `id` is claude-mem's
 * own id. `query` narrows by words (the archive's full-text index); `project` matches exactly. Writes nothing. */
export function promotionCandidates(db, { type, project, query, limit = PROMOTE_MAX } = {}) {
	if (!Object.hasOwn(PROMOTE_KINDS, String(type))) throw listing('--type is decision or bugfix: only those two can be promoted.')
	const cut = Number(limit)
	if (!Number.isInteger(cut) || cut < 1) throw listing('--limit is a whole number of 1 or more.')
	if (cut > PROMOTE_MAX) throw listing(`--limit is at most ${PROMOTE_MAX}: promote a few at a time.`)
	const where = ["a.source_table = 'observations'", 'a.type = ?', 'a.promoted_entry IS NULL']
	const args = [type]
	let from = 'archive a'
	if (project) { where.push('a.project = ?'); args.push(String(project)) }
	if (query !== undefined) {
		const q = ftsQuery(query)
		if (q === null) return []
		from = 'archive_fts JOIN archive a ON a.id = archive_fts.rowid'
		where.push('archive_fts MATCH ?')
		args.push(q)
	}
	const rows = db.prepare(`SELECT a.source_id, a.at, a.project, a.type, a.title, a.text FROM ${from} WHERE ${where.join(' AND ')} ORDER BY a.at DESC, a.id DESC LIMIT ?`).all(...args, cut)
	return rows.map((r) => ({ id: r.source_id, at: r.at, project: r.project, type: r.type, title: r.title, text: oneLine(r.text, 240) }))
}

/** Checks a reviewed batch against the archive before anything is written. Returns [{ id, type, row, input, promoted }]: `input` is the Brain
 * entry input (kind, title, body, tags, scope, project, source) and `promoted` the entry id when the row was promoted before. Throws on
 * more than PROMOTE_MAX items, an item with no id or title, an id that is not a decision or bugfix in the archive, a repeated id, or a title,
 * body or tag holding `[masked:` (a masked secret sits there). Messages name the item's id, never its text. */
export function promotionPlan(db, items) {
	if (!Array.isArray(items) || !items.length) throw listing('Give a JSON array of { id, title, body?, tags?, scope? }.')
	if (items.length > PROMOTE_MAX) throw listing(`At most ${PROMOTE_MAX} at a time; this has ${items.length}. Nothing was promoted.`)
	const seen = new Set()
	const find = db.prepare("SELECT type, project, promoted_entry FROM archive WHERE source_table = 'observations' AND source_id = ?")
	return items.map((item, i) => {
		const id = item && (typeof item.id === 'string' || typeof item.id === 'number') ? String(item.id) : ''
		if (!id) throw listing(`Item ${i + 1} has no id. Nothing was promoted.`)
		if (seen.has(id)) throw listing(`Item ${id} is listed twice. Nothing was promoted.`)
		seen.add(id)
		if (typeof item.title !== 'string' || !item.title.trim()) throw listing(`Item ${id} has no title: say what was learned, in words a future task will use. Nothing was promoted.`)
		if (item.body !== undefined && typeof item.body !== 'string') throw listing(`Item ${id}: body must be text. Nothing was promoted.`)
		if (item.tags !== undefined && !(Array.isArray(item.tags) && item.tags.every((t) => typeof t === 'string'))) throw listing(`Item ${id}: tags must be a list of words. Nothing was promoted.`)
		if (item.scope !== undefined && !['work', 'personal'].includes(item.scope)) throw listing(`Item ${id}: scope is work or personal. Nothing was promoted.`)
		if ([item.title, item.body ?? '', ...(item.tags ?? [])].some((t) => t.includes('[masked:'))) throw listing(`Item ${id} holds a masked secret ([masked:…]). Rewrite it without the secret. Nothing was promoted.`)
		const row = find.get(id)
		if (!row || !Object.hasOwn(PROMOTE_KINDS, row.type)) throw listing(`Item ${id} is not a decision or bugfix in the archive. Nothing was promoted.`)
		const tags = [...new Set(['from-claude-mem', ...(item.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)])]
		const input = {
			kind: PROMOTE_KINDS[row.type], title: item.title.trim(), ...(item.body ? { body: item.body } : {}), tags, scope: item.scope ?? 'personal',
			...(row.project ? { project: row.project } : {}), source: { type: 'session', title: promotionMarker(row.type, id) },
		}
		return { id, type: row.type, row, input, promoted: row.promoted_entry ?? null }
	})
}
