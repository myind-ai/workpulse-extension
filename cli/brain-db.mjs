// wp-brain db — a local SQLite database that `search` and `recall` read from.
//
// Built only from the clone (entries through fold, library text from bridge/library/), so it is safe to delete and is
// never committed. It remembers the clone's HEAD: when that moves the database is stale and gets rebuilt, always into
// a temp file and then renamed, so a reader sees the old database or the new one and never half of one.
//
// Uses the built-in node:sqlite with FTS5 and no dependency. When either is missing, or the file is corrupt, callers
// fall back to searchBrain and recallFor, so nothing here may ever stop a prompt.
//
// Ranking: how many words of the query an entry has, then BM25 with searchBrain's weights (title highest). Words are
// put through the same `stem` as searchBrain on both sides, so script / scripts / scripting meet. Lessons from one
// video or article also count each other's titles, at the lowest weight: they are about one subject, so a question
// using the word one of them uses reaches them all. That is what tells a video script from a shell script, from what
// the Brain itself holds, with no word list for any subject.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { LIBRARY_FILES, MAX_BYTES } = await import(new URL('./library.mjs', import.meta.url))
const here = dirname(fileURLToPath(import.meta.url))
const { sourceOf } = await import(join(here, '..', 'extension', 'src', 'core', 'bridge.ts'))
const { FILLER, LESSON_KINDS, stem } = await import(join(here, '..', 'extension', 'src', 'core', 'brain-query.ts'))

export const dbPath = () => process.env.WP_BRAIN_DB || join(homedir(), '.workpulse', 'brain.db')

const VERSION = '1'
// Without Mn and Mc the vowel signs of Devanagari would split every word in pieces.
const TOKENIZE = `unicode61 categories 'L* N* Co Mn Mc'`
// id, kind, then the five columns that are searched; the weights are searchBrain's, library text below them all.
const WEIGHTS = 'bm25(docs, 0, 0, 8, 5, 5, 2, 1)'
const FIELD_WEIGHT = { title: 8, subtitle: 5, tags: 5, rest: 2 }
const LIBRARY_WEIGHT = 1
/** A long paste shares words with anything: only the start of what was asked is looked at. */
const MAX_WORDS = 24
/** The score a lesson needs to be put in front of Claude: recallFor's bar. */
const RECALL_MIN = 12
/**
 * The lower score a lesson that is plainly about one of the words may have: that word in both its title and its tags,
 * plus a second word from a sibling lesson, makes 9. Two words in a title and no more makes 11, and is not enough.
 */
const RECALL_MIN_STRONG = 9
/** A rebuild's lock is ignored after this long: whoever held it has died. */
const LOCK_MS = 120_000

// ── node:sqlite ─────────────────────────────────────────────────────────────

let loaded

/** DatabaseSync, or null. Loading it prints an ExperimentalWarning on some Node versions, and a hook's output stays clean. */
export function sqlite() {
	if (loaded !== undefined) return loaded
	loaded = null
	if (process.env.WP_BRAIN_DB_TEST === 'no-sqlite') return loaded
	const emit = process.emitWarning
	process.emitWarning = (warning, ...rest) => {
		const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type
		if (type !== 'ExperimentalWarning' || !/sqlite/i.test(String(warning))) emit.call(process, warning, ...rest)
	}
	try {
		loaded = process.getBuiltinModule('node:sqlite')?.DatabaseSync ?? null
	} catch {
		loaded = null
	} finally {
		process.emitWarning = emit
	}
	return loaded
}

/** Null when the database can be used here, or the reason it can't. */
export function unavailable() {
	const DatabaseSync = sqlite()
	if (!DatabaseSync) return 'node:sqlite is not available in this Node'
	if (process.env.WP_BRAIN_DB_TEST === 'no-fts5') return 'this Node\'s SQLite has no FTS5'
	try {
		const db = new DatabaseSync(':memory:')
		try {
			db.exec(`CREATE VIRTUAL TABLE t USING fts5(a, tokenize="${TOKENIZE}")`)
		} finally {
			db.close()
		}
		return null
	} catch {
		return 'this Node\'s SQLite has no FTS5'
	}
}

/** Opens the database, creating what is missing. `readOnly` creates nothing: it is for the path every prompt takes. */
export function openDb(path, { readOnly = false } = {}) {
	const DatabaseSync = sqlite()
	if (!DatabaseSync || process.env.WP_BRAIN_DB_TEST === 'no-fts5') throw new Error(unavailable() ?? 'no database')
	const db = new DatabaseSync(path, { readOnly })
	if (readOnly) return db
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
			CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, json TEXT NOT NULL);
			CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(id UNINDEXED, kind UNINDEXED, title, subtitle, tags, rest, library, tokenize="${TOKENIZE}");
		`)
	} catch (e) {
		db.close()
		throw e
	}
	return db
}

// ── words ───────────────────────────────────────────────────────────────────

/** Hindi words that say nothing about the subject, as FILLER is for English. */
const HINDI_FILLER = new Set('का की के को में से पर और है हैं था थी थे हो या कि यह वह एक कैसे क्या क्यों मैं हम तुम आप ने भी तो ही'.split(' '))

/** Words that say what to do with something, not what it is about: "write the reel script" is about reels and scripts. */
const ACTIONS = new Set('write writes writing wrote written fix fixes fixing fixed add adds adding added create creates creating created update updates updating updated change changes changing changed remove removes removing removed run runs running ran'.split(' '))

/** The same for Marathi. */
const MARATHI_FILLER = new Set('आहे आहेत होता होती होते कसा कशी कसे कसं काय कोण कुठे कधी आणि किंवा पण तर नाही ला ना चा ची चे च्या ने मध्ये वर मी आम्ही तू तुम्ही हा ही हे तो ती ते'.split(' '))

/** Letters, digits and combining marks, in one form each. Works for any script; `stem` only changes Latin endings. */
function tokens(text) {
	const found = String(text ?? '').normalize('NFC').replace(/[‌‍]/g, '').toLowerCase().match(/[\p{L}\p{N}\p{Mn}\p{Mc}]+/gu)
	return (found ?? []).filter((w) => w.length > 1)
}

const norm = (text) => tokens(text).map(stem).join(' ')

/** What a query asks for: its meaningful words, each once. An action word counts only when nothing else is left. */
function wanted(text) {
	const words = tokens(text).filter((w) => !FILLER.has(w) && !HINDI_FILLER.has(w) && !MARATHI_FILLER.has(w))
	const subject = words.filter((w) => !ACTIONS.has(w))
	return [...new Set((subject.length ? subject : words).map(stem))].slice(0, MAX_WORDS)
}

const phrase = (w) => `"${w.replace(/"/g, '""')}"`

// ── building ────────────────────────────────────────────────────────────────

const isDir = (p) => {
	try {
		return lstatSync(p).isDirectory()
	} catch {
		return false
	}
}

/** The library's folders and their text. Links are never followed; only the allowed names are read, media never. */
function readLibrary(root) {
	const out = []
	if (!root || !isDir(root)) return out
	for (const type of readdirSync(root).sort()) {
		if (!isDir(join(root, type))) continue
		for (const folder of readdirSync(join(root, type)).sort()) {
			const dir = join(root, type, folder)
			if (!isDir(dir)) continue
			const text = {}
			for (const name of LIBRARY_FILES) {
				try {
					const st = lstatSync(join(dir, name))
					if (st.isFile() && st.size <= MAX_BYTES) text[name] = readFileSync(join(dir, name), 'utf8')
				} catch {
					/* this folder has no such file */
				}
			}
			out.push({ type, folder, text })
		}
	}
	return out
}

/** The folders an entry's notes are in: its source.library, or the `…/<folder>/notes.md` older lessons name in their body. */
function foldersOf(e) {
	const found = []
	if (typeof e.source?.library === 'string') found.push(e.source.library.replace(/\/+$/, '').split('/').pop())
	for (const m of String(e.body ?? '').matchAll(/([^/\s]+)\/notes\.md/g)) found.push(m[1])
	return found
}

/** What lessons from one video or article have in common: its folder, or its address without the place in it. */
function sourceKey(e) {
	const folder = foldersOf(e)[0]
	if (folder) return folder
	const url = sourceOf(e)?.url
	return url ? url.replace(/[&?#]t=\w+$/, '').replace(/#.*$/, '') : null
}

/**
 * Replaces everything in `db` with `entries` and the library under `libraryRoot` (may be null), in one transaction.
 * Every library folder is a document of its own named `library:<type>/<folder>`; a lesson that names the folder also
 * gets its notes (not its transcript, which would match anything), and the titles of the other lessons from its source. Returns what went in.
 */
export function rebuild(db, entries, libraryRoot) {
	const library = readLibrary(libraryRoot)
	const notesOf = new Map(library.map((l) => [l.folder, [l.text['notes.md'], l.text['description.md']].filter(Boolean).join('\n')]))
	const put = db.prepare('INSERT INTO docs (id, kind, title, subtitle, tags, rest, library) VALUES (?, ?, ?, ?, ?, ?, ?)')
	const keep = db.prepare('INSERT OR REPLACE INTO entries (id, json) VALUES (?, ?)')
	const shown = entries.filter((e) => !e.archived)
	const titles = new Map()
	for (const e of shown) {
		const key = sourceKey(e)
		if (key) titles.set(key, [...(titles.get(key) ?? []), e])
	}
	let count = 0
	let files = 0
	db.exec('BEGIN')
	try {
		db.exec('DELETE FROM docs; DELETE FROM entries;')
		for (const e of shown) {
			const rest = [e.body, e.ticket, e.project, e.rootCause, e.asked, e.done, e.source?.title, e.source?.by, ...(e.next ?? [])].filter(Boolean).join('\n')
			const notes = [...new Set(foldersOf(e))].map((f) => notesOf.get(f)).filter(Boolean).join('\n')
			const siblings = (titles.get(sourceKey(e)) ?? []).filter((o) => o !== e).map((o) => o.title).join('\n')
			put.run(e.id, e.kind ?? '', norm(e.title), norm(e.subtitle), norm((e.tags ?? []).join(' ')), norm(rest), norm(`${notes}\n${siblings}`))
			keep.run(e.id, JSON.stringify(e))
			count++
		}
		for (const l of library) {
			const names = Object.keys(l.text)
			files += names.length
			put.run(`library:${l.type}/${l.folder}`, 'library', norm(l.folder), '', norm(l.type), '', norm(names.map((n) => l.text[n]).join('\n')))
		}
		db.exec('COMMIT')
	} catch (e) {
		db.exec('ROLLBACK')
		throw e
	}
	return { entries: count, files }
}

const tmpNext = (path) => `${path}.${process.pid}.tmp`

/** A killed rebuild leaves a full copy of private notes. Only old ones go: a young one may be a live rebuild's. */
function sweepTemp(path) {
	const base = basename(path)
	for (const name of readdirSync(dirname(path))) {
		if (!name.startsWith(`${base}.`) || !/^\d+\.tmp(-journal)?$/.test(name.slice(base.length + 1))) continue
		const file = join(dirname(path), name)
		try {
			if (Date.now() - statSync(file).mtimeMs > LOCK_MS) rmSync(file, { force: true })
		} catch {
			/* gone already */
		}
	}
}

/** Builds the database at `path` from nothing and swaps it in, so a failure or a crash leaves the old one in place. */
export function rebuildFile(path, entries, libraryRoot, { head = '', clone = '' } = {}) {
	mkdirSync(dirname(path), { recursive: true })
	sweepTemp(path)
	const tmp = tmpNext(path)
	rmSync(tmp, { force: true })
	rmSync(`${tmp}-journal`, { force: true })
	// Private notes: readable by this user only, from the first byte.
	closeSync(openSync(tmp, 'wx', 0o600))
	try {
		const db = openDb(tmp)
		let counts
		try {
			counts = rebuild(db, entries, libraryRoot)
			const set = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
			for (const [k, v] of Object.entries({ version: VERSION, head, clone, entries: counts.entries, files: counts.files, builtAt: Date.now() })) set.run(k, String(v))
		} finally {
			db.close()
		}
		renameSync(tmp, path)
		return counts
	} finally {
		rmSync(tmp, { force: true })
		rmSync(`${tmp}-journal`, { force: true })
	}
}

// ── state ───────────────────────────────────────────────────────────────────

const metaOf = (db) => Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]))

/**
 * What the database at `path` is compared with this clone: fresh, stale, missing, corrupt or unavailable. An empty
 * `head` (no commit yet) is never fresh. `deep` also checks every page, which is for doctor and status, not a prompt.
 */
export function dbState(path, { head = '', clone = '', deep = false } = {}) {
	const why = unavailable()
	if (why) return { state: 'unavailable', why, path }
	if (!existsSync(path)) return { state: 'missing', path }
	let db
	try {
		db = openDb(path, { readOnly: true })
		const meta = metaOf(db)
		if (deep && db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('quick_check failed')
		db.prepare('SELECT rowid FROM docs LIMIT 1').all()
		const about = { path, entries: Number(meta.entries) || 0, files: Number(meta.files) || 0, builtAt: Number(meta.builtAt) || 0 }
		const fresh = meta.version === VERSION && meta.clone === clone && head !== '' && meta.head === head
		return { state: fresh ? 'fresh' : 'stale', ...about }
	} catch (e) {
		return { state: 'corrupt', why: e.message, path }
	} finally {
		db?.close()
	}
}

/** The entries behind these ids, in the order given. An id that is a library folder has no entry and is left out. */
export function entriesFor(db, ids) {
	const one = db.prepare('SELECT json FROM entries WHERE id = ?')
	return ids.flatMap((id) => {
		const row = one.get(id)
		return row ? [JSON.parse(row.json)] : []
	})
}

// ── asking ──────────────────────────────────────────────────────────────────

/**
 * Entries that share words with `text`, best first: { id, score, matched, strong }. `matched` is how many words of the query
 * the entry has; `strong` means one of them is in both its title and its tags. `score` is searchBrain's formula, so its scale means the same; the order is coverage, then BM25, then the
 * entry indexed first, which is the newer one. `kinds` limits it; `limit` cuts it.
 */
export function query(db, text, { limit = 0, kinds = null } = {}) {
	const words = wanted(text)
	if (!words.length) return []
	const only = kinds ? new Set(kinds) : null
	const hit = db.prepare(`SELECT rowid AS row, id, kind, ${WEIGHTS} AS rank FROM docs WHERE docs MATCH ?`)
	const docs = new Map()
	for (const w of words) {
		for (const r of hit.all(phrase(w))) {
			if (only && !only.has(r.kind)) continue
			const d = docs.get(r.row) ?? docs.set(r.row, { row: r.row, id: r.id, rank: 0, words: new Set() }).get(r.row)
			d.rank += r.rank
			d.words.add(w)
		}
	}
	if (!docs.size) return []
	const fields = db.prepare('SELECT title, subtitle, tags, rest FROM docs WHERE rowid = ?')
	const scored = [...docs.values()].map((d) => {
		const f = fields.get(d.row)
		const inField = Object.fromEntries(Object.keys(FIELD_WEIGHT).map((k) => [k, new Set(f[k].split(' '))]))
		let raw = 0
		let named = false
		let strong = false
		for (const w of d.words) {
			const s = Object.keys(FIELD_WEIGHT).reduce((n, k) => n + (inField[k].has(w) ? FIELD_WEIGHT[k] : 0), 0)
			if (inField.title.has(w) || inField.subtitle.has(w) || inField.tags.has(w)) named = true
			if (inField.title.has(w) && inField.tags.has(w)) strong = true
			raw += s || LIBRARY_WEIGHT
		}
		return { id: d.id, score: Math.round((raw * d.words.size) / Math.min(words.length, 3)), matched: d.words.size, named, strong, rank: d.rank, row: d.row }
	})
	scored.sort((a, b) => b.matched - a.matched || a.rank - b.rank || a.row - b.row)
	return limit > 0 ? scored.slice(0, limit) : scored
}

/**
 * The bars of recallFor: nothing for a command or a one-word prompt, at least two words matched (one when the prompt
 * has only one or two), and its minimum score, or the lower one for a strong match (RECALL_MIN_STRONG). Lessons only,
 * and a lesson must name a word of the prompt itself, not just have it in its notes.
 */
export function recall(db, prompt, limit = 3) {
	const text = String(prompt ?? '').trim()
	if (!text || text.startsWith('/')) return []
	const head = text.slice(0, 600).replace(/\b[a-z]+:\S+/gi, ' ')
	const count = wanted(head).length
	if (count < 2) return []
	const need = count <= 2 ? 1 : 2
	return query(db, head, { kinds: LESSON_KINDS })
		.filter((x) => x.named && x.matched >= need && (x.score >= RECALL_MIN || (x.score >= RECALL_MIN_STRONG && x.strong)))
		.slice(0, limit)
}

// ── a rebuild in the background ─────────────────────────────────────────────

/** True while another process holds the lock; a lock whose holder must have died doesn't count. */
export function rebuildRunning(path) {
	try {
		return Date.now() - statSync(`${path}.lock`).mtimeMs <= LOCK_MS
	} catch {
		return false
	}
}

/** Takes the lock for a rebuild; false when another one is running. */
export function lockRebuild(path) {
	const lock = `${path}.lock`
	mkdirSync(dirname(path), { recursive: true })
	if (!rebuildRunning(path)) rmSync(lock, { force: true })
	try {
		const fd = openSync(lock, 'wx')
		writeSync(fd, String(process.pid))
		closeSync(fd)
		return true
	} catch {
		return false
	}
}

export const unlockRebuild = (path) => rmSync(`${path}.lock`, { force: true })
