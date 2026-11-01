// node --test cli/memory-archive.test.mjs
// claude-mem's history as an archive. Every source here is a synthetic temp WAL database held open by a writer, as a live one is.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { compareWithClaudeMem, importClaudeMem, searchArchive } from './memory-archive.mjs'
import { loadMask, openMemory, writeBatch } from './memory-db.mjs'
import { lastSessionNote } from './memory-note.mjs'
import { brainSandbox } from './sandbox.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GITHUB = 'gh' + 'p_a1B2c3D4e5F6g7H8i9J0k1L2' // built at run time, so no scanner mistakes this file for a leak
const T0 = Date.UTC(2026, 9, 20, 10)

const OBS_COLS = 'id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT, type TEXT, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, files_read TEXT, files_modified TEXT, created_at_epoch INTEGER'
const SUM_COLS = 'id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT, request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, created_at_epoch INTEGER'
const PRM_COLS = 'id INTEGER PRIMARY KEY, content_session_id TEXT, prompt_text TEXT, created_at_epoch INTEGER'
const SES_COLS = 'id INTEGER PRIMARY KEY, content_session_id TEXT, project TEXT, started_at_epoch INTEGER'

/** A temp folder; removed afterwards. */
function folder(t) {
	const root = mkdtempSync(join(tmpdir(), 'wp-archive-'))
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
	return root
}

/** A synthetic claude-mem database in WAL mode, with a writer left open (returned) so the source is "live". `without` drops one column. */
function makeSource(root, { without } = {}) {
	const path = join(root, 'claude-mem.db')
	const writer = new DatabaseSync(path)
	writer.exec('PRAGMA journal_mode = WAL')
	const cols = (text) => text.split(', ').filter((c) => c.split(' ')[0] !== without).join(', ')
	writer.exec(`CREATE TABLE observations (${cols(OBS_COLS)}); CREATE TABLE session_summaries (${cols(SUM_COLS)}); CREATE TABLE user_prompts (${cols(PRM_COLS)}); CREATE TABLE sdk_sessions (${SES_COLS});`)
	if (without !== 'narrative') {
		const obs = writer.prepare('INSERT INTO observations (id, memory_session_id, project, merged_into_project, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
		obs.run(1, 'mem-a', 'old-name', 'workpulse', 'decision', 'Chose quokka queues', 'a subtitle', '["fact one"]', `The narrative says quokka scheduling won. Key ${GITHUB} was pasted.`, '["queues"]', '["src/a.js"]', '["src/b.js"]', T0)
		obs.run(2, 'mem-a', 'workpulse', null, 'bugfix', 'Fixed the 100%_odd parser', null, null, 'Parser narrative about wombats.', null, null, null, T0 + 1000)
		obs.run(3, 'mem-b', 'other', null, 'odd type!', 'Third', null, null, 'Third narrative', null, null, null, T0 + 2000)
	}
	writer.exec(`INSERT INTO session_summaries (id, memory_session_id, project, merged_into_project, request, investigated, learned, completed, next_steps, notes, created_at_epoch) VALUES
		(1, 'mem-a', 'workpulse', NULL, 'Make the importer', 'Looked at tables', 'Learned about axolotl schemas', 'Built it', 'Test it', NULL, ${T0 + 3000}),
		(2, 'mem-b', 'other', NULL, 'Second request', NULL, NULL, NULL, NULL, NULL, ${T0 + 4000})`)
	writer.exec(`INSERT INTO user_prompts (id, content_session_id, prompt_text, created_at_epoch) VALUES
		(1, 'sess-both', 'first prompt about pangolins', ${T0 + 5000}), (2, 'sess-both', 'second prompt', ${T0 + 6000}), (3, 'sess-theirs', 'a prompt only they have', ${T0 + 7000})`)
	writer.exec(`INSERT INTO sdk_sessions (id, content_session_id, project, started_at_epoch) VALUES (1, 'sess-both', 'workpulse', ${T0}), (2, 'sess-theirs', 'workpulse', ${T0 + 86_400_000})`)
	return { path, writer }
}

const sha = (path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null)
const count = (db, table, where = '1') => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n
const schemaOf = (db) => db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all().map((r) => `${r.name}|${r.sql}`)
const total = (db) => Object.fromEntries(['observations', 'session_summaries', 'user_prompts', 'sdk_sessions'].map((tb) => [tb, count(db, tb)]))

test('the archive has as many rows as the source, a second run adds none, and rows added later come with the next run', async (t) => {
	const root = folder(t)
	const { path, writer } = makeSource(root)
	t.after(() => writer.close())
	const db = openMemory(join(root, 'memory', 'memory.db'))
	t.after(() => db.close())
	const first = await importClaudeMem(db, path, { batch: 2 }) // small batches: several short reads per table
	assert.deepEqual(first, { observations: 3, summaries: 2, prompts: 3, skipped: 0 })
	assert.equal(count(db, 'archive'), 8)
	assert.deepEqual(db.prepare('SELECT source_table, last_id, rows FROM import_state ORDER BY source_table').all().map((r) => ({ ...r })), [
		{ source_table: 'observations', last_id: 3, rows: 3 }, { source_table: 'session_summaries', last_id: 2, rows: 2 }, { source_table: 'user_prompts', last_id: 3, rows: 3 },
	])
	assert.deepEqual(await importClaudeMem(db, path), { observations: 0, summaries: 0, prompts: 0, skipped: 0 })
	assert.equal(count(db, 'archive'), 8)

	writer.exec(`INSERT INTO observations (id, memory_session_id, project, type, title, narrative, created_at_epoch) VALUES (4, 'mem-c', 'workpulse', 'decision', 'Later one', 'arrived later', ${T0 + 9000})`)
	assert.deepEqual(await importClaudeMem(db, path), { observations: 1, summaries: 0, prompts: 0, skipped: 0 })
	assert.equal(count(db, 'archive'), 9)
})

test('the mapping: type verbatim, project is merged_into_project or project, the text parts are joined, prompts are typed prompt', async (t) => {
	const root = folder(t)
	const { path, writer } = makeSource(root)
	t.after(() => writer.close())
	const db = openMemory(join(root, 'memory', 'memory.db'))
	t.after(() => db.close())
	await importClaudeMem(db, path)
	const row = (table, id) => db.prepare('SELECT * FROM archive WHERE source_table = ? AND source_id = ?').get(table, String(id))
	const o1 = row('observations', 1)
	assert.equal(o1.type, 'decision')
	assert.equal(o1.project, 'workpulse')
	assert.equal(o1.title, 'Chose quokka queues')
	assert.equal(o1.at, T0)
	assert.equal(o1.session_id, 'mem-a')
	assert.match(o1.text, /^a subtitle\nThe narrative says quokka scheduling won\./)
	assert.match(o1.text, /\["fact one"\]\n\["queues"\]\n\["src\/a\.js"\]\n\["src\/b\.js"\]$/)
	assert.equal(row('observations', 3).type, 'odd type!')
	const s1 = row('session_summaries', 1)
	assert.equal(s1.type, 'summary')
	assert.equal(s1.text, 'Make the importer\nLooked at tables\nLearned about axolotl schemas\nBuilt it\nTest it')
	const p1 = row('user_prompts', 1)
	assert.equal(p1.type, 'prompt')
	assert.equal(p1.session_id, 'sess-both')
	assert.equal(p1.text, 'first prompt about pangolins')
	assert.equal(p1.project, 'workpulse') // from their sessions table
})

test('the source is untouched while a writer holds it open: same schema, counts and bytes, and a write through a read-only connection throws', async (t) => {
	const root = folder(t)
	const { path, writer } = makeSource(root)
	t.after(() => writer.close())
	writer.exec('BEGIN IMMEDIATE')
	writer.exec(`INSERT INTO observations (id, memory_session_id, project, type, title, narrative, created_at_epoch) VALUES (9, 'mem-z', 'p', 't', 'uncommitted', 'not yet committed', ${T0})`)
	const before = { schema: schemaOf(writer), counts: total(writer), db: sha(path), wal: sha(`${path}-wal`), shm: sha(`${path}-shm`) }
	const db = openMemory(join(root, 'memory', 'memory.db'))
	t.after(() => db.close())
	const done = await importClaudeMem(db, path)
	assert.equal(done.observations, 3, 'the open transaction\'s row is not read')
	assert.deepEqual({ schema: schemaOf(writer), counts: total(writer), db: sha(path), wal: sha(`${path}-wal`), shm: sha(`${path}-shm`) }, before)
	writer.exec('COMMIT')
	assert.equal((await importClaudeMem(db, path)).observations, 1, 'once committed, the next run takes it')

	const reader = new DatabaseSync(path, { readOnly: true }) // the mode the importer uses
	t.after(() => reader.close())
	assert.throws(() => reader.exec("INSERT INTO observations (id, title) VALUES (99, 'x')"), /readonly/i)
	assert.throws(() => reader.exec('DROP TABLE observations'), /readonly/i)
	const src = readFileSync(join(HERE, 'memory-archive.mjs'), 'utf8')
	assert.match(src, /readOnly: true/)
	const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') // comments may name these words
	assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|VACUUM|enabledPlugins|rmSync|unlinkSync|writeFileSync)\b/)
})

test('an idle source (no writer, no -wal, no -shm) is left exactly as found: same file list, same bytes', async (t) => {
	const root = folder(t)
	const { path, writer } = makeSource(root)
	writer.close() // a clean close checkpoints and removes -wal and -shm
	const list = () => readdirSync(root).sort()
	assert.deepEqual(list(), ['claude-mem.db'], 'the fixture really is idle')
	const before = { files: list(), db: sha(path) }
	const db = openMemory(join(folder(t), 'memory.db'))
	t.after(() => db.close())
	assert.equal((await importClaudeMem(db, path)).observations, 3)
	assert.equal((await compareWithClaudeMem(db, path, {})).length > 0, true)
	assert.deepEqual({ files: list(), db: sha(path) }, before)
})

test('a writer appearing during an immutable read: the batch is dropped and read again normally', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'wp-archive-race-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	const { path, writer } = makeSource(root)
	writer.close()
	assert.deepEqual(readdirSync(root).filter((f) => f.startsWith('claude-mem')), ['claude-mem.db'], 'the fixture really is idle')
	await loadMask()
	const db = openMemory(join(root, 'memory', 'memory.db'))
	t.after(() => db.close())
	let late = null
	t.after(() => late?.close())
	let reads = 0
	const out = await importClaudeMem(db, path, { afterRead: () => {
		reads++
		if (late) return
		late = new DatabaseSync(path)
		late.exec("UPDATE observations SET narrative = 'capybara came later' WHERE id = 1")
	} })
	assert.equal(out.observations, 3)
	assert.equal(reads >= 2, true, 'the seam ran')
	const text = db.prepare("SELECT text FROM archive WHERE source_table = 'observations' AND source_id = '1'").get().text
	assert.match(text, /capybara came later/, 'what a normal open sees, not the immutable read')
	assert.doesNotMatch(text, /quokka scheduling/)
})

test('an idle source whose path has odd characters is still read and left alone', async (t) => {
	const root = folder(t)
	const odd = join(root, 'a b#c?d')
	mkdirSync(odd)
	const { path, writer } = makeSource(odd)
	writer.close()
	const db = openMemory(join(folder(t), 'memory.db'))
	t.after(() => db.close())
	assert.equal((await importClaudeMem(db, path)).observations, 3)
	assert.deepEqual(readdirSync(odd).sort(), ['claude-mem.db'])
})

test('a planted token is masked in the archive, in its text, its index and the bytes of the database and its -wal', async (t) => {
	const root = folder(t)
	const { path, writer } = makeSource(root)
	t.after(() => writer.close())
	const dbPath = join(root, 'memory', 'memory.db')
	const db = openMemory(dbPath)
	t.after(() => db.close())
	await importClaudeMem(db, path)
	const stored = db.prepare("SELECT text FROM archive WHERE source_table = 'observations' AND source_id = '1'").get().text
	assert.ok(!stored.includes(GITHUB) && /narrative says quokka scheduling won/.test(stored), 'masked, the rest kept')
	assert.equal(searchArchive(db, GITHUB).length, 0)
	for (const file of [dbPath, `${dbPath}-wal`]) if (existsSync(file)) assert.ok(!readFileSync(file).includes(GITHUB), `${file} holds the token`)
})

test('a row whose masking throws is dropped and counted, never stored raw, and the import moves on', async (t) => {
	const root = folder(t)
	const { path, writer } = makeSource(root)
	t.after(() => writer.close())
	const db = openMemory(join(root, 'memory', 'memory.db'))
	t.after(() => db.close())
	const real = await loadMask()
	const mask = (text) => {
		if (text.includes('wombats')) throw new Error('mask failed')
		return real(text)
	}
	const done = await importClaudeMem(db, path, { mask })
	assert.equal(done.skipped, 1)
	assert.equal(done.observations, 2)
	assert.equal(count(db, 'archive', "source_table = 'observations' AND source_id = '2'"), 0)
	assert.equal(count(db, 'archive', "text LIKE '%wombats%'"), 0)
	assert.equal(count(db, 'capture_log', "kind = 'mask_failed'"), 1)
	assert.equal(db.prepare("SELECT last_id FROM import_state WHERE source_table = 'observations'").get().last_id, 3)
})

test('a missing column stops the import, names the column and writes nothing', async (t) => {
	const root = folder(t)
	const { path, writer } = makeSource(root, { without: 'narrative' })
	t.after(() => writer.close())
	const db = openMemory(join(root, 'memory', 'memory.db'))
	t.after(() => db.close())
	await assert.rejects(importClaudeMem(db, path), /observations.*narrative/)
	assert.equal(count(db, 'archive'), 0)
	assert.equal(count(db, 'import_state'), 0)
})

test('a missing source file is a clear message, and the command exits non-zero without creating a database', async (t) => {
	const root = folder(t)
	const db = openMemory(join(root, 'memory', 'memory.db'))
	t.after(() => db.close())
	await assert.rejects(importClaudeMem(db, join(root, 'nope.db')), /not at .*nope\.db/)
	const box = cliBox(t)
	const r = box.run('memory', 'import-claude-mem', '--db', join(box.root, 'nope.db'))
	assert.notEqual(r.status, 0)
	assert.match(r.err + r.out, /not at .*nope\.db/)
	const bad = box.run('memory', 'import-claude-mem', '--dry-run', '--db', join(box.root, 'nope.db'))
	assert.notEqual(bad.status, 0)
	assert.ok(!existsSync(box.dbPath), 'no memory database made for nothing')
})

/** A CLI sandbox with its own memory database. */
function cliBox(t) {
	const root = mkdtempSync(join(tmpdir(), 'wp-archive-cli-'))
	const dbPath = join(root, 'memory', 'memory.db')
	const box = brainSandbox({ config: { memory: true, capture_since: 1 }, env: { HOME: root, WP_MEMORY_DB: dbPath, CLAUDE_CONFIG_DIR: join(root, 'claude-home') } })
	t.after(() => {
		rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
	})
	return { ...box, dbPath }
}

test('archive rows are found by search --archive and by nothing else: not plain search, recall, or the last-session note', async (t) => {
	const box = cliBox(t)
	const { path, writer } = makeSource(box.root)
	t.after(() => writer.close())

	const dry = box.run('memory', 'import-claude-mem', '--dry-run', '--db', path)
	assert.equal(dry.status, 0, dry.err)
	assert.match(dry.out, /3 observations, 2 summaries and 3 prompts would be added/)
	assert.ok(!existsSync(box.dbPath), 'a dry run writes nothing, not even the database')

	const imp = box.run('memory', 'import-claude-mem', '--db', path)
	assert.equal(imp.status, 0, imp.err)
	assert.match(imp.out, /3 observations, 2 summaries, 3 prompts/)
	assert.equal(box.run('memory', 'import-claude-mem', '--db', path).out.match(/0 observations, 0 summaries, 0 prompts/) !== null, true)

	const hits = JSON.parse(box.run('memory', 'search', 'quokka', '--archive', '--json').out)
	assert.equal(hits.length, 1)
	assert.equal(hits[0].source_table, 'observations')
	assert.ok(hits[0].snippet.length <= 200)
	assert.match(box.run('memory', 'search', 'axolotl', '--archive').out, /summary/)
	for (const word of ['quokka', 'axolotl', 'pangolins']) {
		assert.match(box.run('memory', 'search', word, '--archive').out, new RegExp(word), `${word} is in the archive`)
		assert.doesNotMatch(box.run('memory', 'search', word).out, new RegExp(word), `${word} must not reach plain search`)
		assert.doesNotMatch(box.run('recall', word).out, new RegExp(word), `${word} must not reach recall`)
	}
	assert.notEqual(box.run('memory', 'search', 'quokka', '--archive', '--repo', 'x').status, 0)
	assert.notEqual(box.run('memory', 'search', 'quokka', '--type', 'decision').status, 0, '--type needs --archive')

	// The note for a repo holding the same project and session ids as archive rows still shows none of them.
	await loadMask()
	const db = openMemory(box.dbPath)
	t.after(() => db.close())
	const now = Date.now()
	writeBatch(db, { session: { id: 'mem-a', cwd: '/tmp/workpulse', repo: '/tmp/workpulse', branch: 'main', title: 'Plain work', startedAt: now - 3_600_000, lastEventAt: now - 1_000_000 },
		messages: [{ uuid: 'u1', block: 0, role: 'prompt', at: now - 3_000_000, text: 'a prompt' }] })
	const note = lastSessionNote(db, { repo: '/tmp/workpulse', currentSession: 'other', now })
	assert.ok(note, 'the note exists')
	assert.doesNotMatch(note, /quokka|axolotl|pangolin|wombat|importer/i)
})

test('search --archive filters --type and --project exactly, with % and _ meaning themselves', async (t) => {
	const root = folder(t)
	const { path, writer } = makeSource(root)
	t.after(() => writer.close())
	const db = openMemory(join(root, 'memory', 'memory.db'))
	t.after(() => db.close())
	await importClaudeMem(db, path)
	const ids = (opts) => searchArchive(db, 'narrative', opts).map((h) => h.source_id).sort()
	assert.deepEqual(ids({}), ['1', '2', '3'])
	assert.deepEqual(ids({ type: 'decision' }), ['1'])
	assert.deepEqual(ids({ type: 'odd type!' }), ['3'])
	assert.deepEqual(ids({ type: 'Decision' }), [], 'case counts')
	assert.deepEqual(ids({ type: '%' }), [], '% is not a wildcard')
	assert.deepEqual(ids({ type: 'bugfi_' }), [])
	assert.deepEqual(ids({ project: 'workpulse' }), ['1', '2'])
	assert.deepEqual(ids({ project: 'work' }), [], 'no prefix match')
	assert.deepEqual(ids({ project: 'workpulse', type: 'bugfix' }), ['2'])
	assert.deepEqual(searchArchive(db, '"*) OR ('), [], 'punctuation cannot raise a syntax error')
})

test('compare reports a session only we have and one only they have, and changes nothing in either database', async (t) => {
	const root = folder(t)
	const { path, writer } = makeSource(root)
	t.after(() => writer.close())
	await loadMask()
	const dbPath = join(root, 'memory', 'memory.db')
	const db = openMemory(dbPath)
	t.after(() => db.close())
	writeBatch(db, { session: { id: 'sess-both', cwd: '/tmp/a', repo: '/tmp/a', branch: 'main', title: 't', startedAt: T0, lastEventAt: T0 + 60_000 } })
	writeBatch(db, { session: { id: 'sess-ours', cwd: '/tmp/a', repo: '/tmp/a', branch: 'main', title: 't', startedAt: T0 + 2 * 86_400_000, lastEventAt: T0 + 2 * 86_400_000 + 60_000 } })
	writeBatch(db, { session: { id: 'sess-old', cwd: '/tmp/a', repo: '/tmp/a', branch: 'main', title: 't', startedAt: T0 - 30 * 86_400_000, lastEventAt: T0 - 30 * 86_400_000 } })
	const day = (ms) => new Date(ms).toISOString().slice(0, 10)
	const before = { src: { schema: schemaOf(writer), counts: total(writer), db: sha(path), wal: sha(`${path}-wal`) }, ours: { schema: schemaOf(db), sessions: count(db, 'sessions'), messages: count(db, 'messages'), archive: count(db, 'archive') } }
	const report = await compareWithClaudeMem(db, path, { since: T0 - 86_400_000 })
	assert.deepEqual(report, [
		{ day: day(T0), sessions: 1, ours: 1, theirs: 1, missedByUs: 0, missedByThem: 0 },
		{ day: day(T0 + 86_400_000), sessions: 1, ours: 0, theirs: 1, missedByUs: 1, missedByThem: 0 },
		{ day: day(T0 + 2 * 86_400_000), sessions: 1, ours: 1, theirs: 0, missedByUs: 0, missedByThem: 1 },
	])
	assert.deepEqual({ schema: schemaOf(writer), counts: total(writer), db: sha(path), wal: sha(`${path}-wal`) }, before.src)
	assert.deepEqual({ schema: schemaOf(db), sessions: count(db, 'sessions'), messages: count(db, 'messages'), archive: count(db, 'archive') }, before.ours)
	assert.equal((await compareWithClaudeMem(db, path, {})).length, 4, 'with no since, the old session is in too')
})

test('--db with no value is refused, and a dry run treats a memory db without import_state as empty', async (t) => {
	const box = cliBox(t)
	const { path, writer } = makeSource(box.root)
	t.after(() => writer.close())
	for (const cmd of ['import-claude-mem', 'compare']) {
		const r = box.run('memory', cmd, '--db')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /--db needs a path/)
	}
	mkdirSync(dirname(box.dbPath), { recursive: true })
	const old = new DatabaseSync(box.dbPath) // an old schema: some table, but no import_state
	old.exec('CREATE TABLE sessions (id TEXT)')
	old.close()
	const r = box.run('memory', 'import-claude-mem', '--dry-run', '--db', path)
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /Dry run: 3 observations/)
})

test('compare through the command prints the report, and says so for a missing source', async (t) => {
	const box = cliBox(t)
	const { path, writer } = makeSource(box.root)
	t.after(() => writer.close())
	await loadMask()
	const db = openMemory(box.dbPath)
	writeBatch(db, { session: { id: 'sess-ours', cwd: '/tmp/a', repo: '/tmp/a', branch: 'main', title: 't', startedAt: Date.now() - 3_600_000, lastEventAt: Date.now() } })
	db.close()
	const r = box.run('memory', 'compare', '--since', '30d', '--db', path)
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /only-theirs/)
	assert.match(r.out, /1\s+1\s+0\s+0\s+1\s*$/m, 'the session only we have')
	assert.match(r.out, /worker sessions.*only-theirs/)
	const miss = box.run('memory', 'compare', '--db', join(box.root, 'nope.db'))
	assert.notEqual(miss.status, 0)
	assert.match(miss.err + miss.out, /not at/)
})

// ── promotion ───────────────────────────────────────────────────────────────

/** A cliBox with 25 decision/bugfix observations (ids 101..125, alternating) imported on top of the standard source. */
function promoteBox(t) {
	const box = cliBox(t)
	const { path, writer } = makeSource(box.root)
	t.after(() => writer.close())
	const ins = writer.prepare('INSERT INTO observations (id, memory_session_id, project, merged_into_project, type, title, narrative, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
	for (let i = 101; i <= 125; i++) ins.run(i, 'mem-p', 'proj-p', null, i % 2 ? 'decision' : 'bugfix', `Archived title ${i}`, `Narrative zebrafish number ${i}`, T0 + i * 1000)
	assert.equal(box.run('memory', 'import-claude-mem', '--db', path).status, 0)
	const batch = (ids) => JSON.stringify(ids.map((id) => ({ id, title: `Lesson number ${id} about ostrich handling` })))
	const write = (name, text) => { const f = join(box.root, name); writeFileSync(f, text); return f }
	const entries = () => (existsSync(join(box.clone, 'bridge', 'entries')) ? readdirSync(join(box.clone, 'bridge', 'entries'), { recursive: true }) : []).filter((f) => String(f).endsWith('.jsonl'))
		.flatMap((f) => readFileSync(join(box.clone, 'bridge', 'entries', String(f)), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
	const remoteCount = () => Number(box.git('-C', box.remote, 'rev-list', '--count', 'main').trim())
	return { ...box, batch, write, entries, remoteCount }
}

test('promote lists only decisions and bugfixes, at most 20, and writes nothing', (t) => {
	const box = promoteBox(t)
	for (const type of ['feature', 'discovery']) {
		const r = box.run('memory', 'promote', '--type', type)
		assert.notEqual(r.status, 0)
		assert.match(r.err + r.out, /decision or bugfix/)
	}
	assert.notEqual(box.run('memory', 'promote').status, 0, 'a type is needed')
	assert.notEqual(box.run('memory', 'promote', '--type', 'decision', '--limit', '21').status, 0)
	const list = box.run('memory', 'promote', '--type', 'decision')
	assert.equal(list.status, 0, list.err)
	assert.match(list.out, /Archived title 101/)
	assert.doesNotMatch(list.out, /Archived title 102/, 'a bugfix is not in the decision list')
	assert.equal(box.run('memory', 'promote', '--type', 'bugfix', '--project', 'proj-p', '--query', 'zebrafish', '--limit', '3').out.match(/^\d+ {2}/gm).length, 3)
	assert.deepEqual(box.entries(), [])
})

test('promote --json refuses more than 20 and writes nothing', (t) => {
	const box = promoteBox(t)
	const ids = Array.from({ length: 21 }, (_, i) => 101 + i)
	const before = box.remoteCount()
	const r = box.run('memory', 'promote', '--json', box.write('b.json', box.batch(ids)), '--no-push')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /At most 20/)
	assert.equal(box.entries().length, 0)
	assert.equal(box.remoteCount(), before)
})

test('20 reviewed rows become 20 lessons with the source and tag, are marked, and a second run adds nothing', (t) => {
	const box = promoteBox(t)
	const ids = Array.from({ length: 20 }, (_, i) => 101 + i)
	const file = box.write('b.json', box.batch(ids))
	const r = box.run('memory', 'promote', '--json', file)
	assert.equal(r.status, 0, r.err)
	const entries = box.entries()
	assert.equal(entries.length, 20)
	const e = entries.find((x) => x.title === 'Lesson number 101 about ostrich handling')
	assert.equal(e.kind, 'decision')
	assert.equal(entries.find((x) => x.title.includes('number 102 ')).kind, 'debug')
	assert.deepEqual(e.source, { type: 'session', title: 'claude-mem decision 101' })
	assert.ok(e.tags.includes('from-claude-mem'))
	assert.equal(e.project, 'proj-p')
	assert.equal(e.scope, 'personal')
	assert.ok(!JSON.stringify(entries).includes('zebrafish'), 'no archived text is copied')
	assert.equal(Number(box.git('-C', box.remote, 'rev-list', '--count', 'main').trim()) > 1, true, 'pushed to the temp remote')
	assert.match(box.run('memory', 'promote', '--type', 'decision').out, /Archived title 121/, 'unpromoted ones are still listed')
	assert.doesNotMatch(box.run('memory', 'promote', '--type', 'decision').out, /Archived title 101\b/, 'promoted ones are not')
	const again = box.run('memory', 'promote', '--json', file, '--no-push')
	assert.equal(again.status, 0, again.err)
	assert.match(again.out, /Nothing new/)
	assert.equal(box.entries().length, 20)
})

test('a title with a secret shape or a mask refuses the whole batch, names the item and not the value, and marks nothing', (t) => {
	const box = promoteBox(t)
	for (const bad of [`token ${GITHUB} here`, 'kept [masked:github] here']) {
		const items = [{ id: 101, title: 'A fine lesson about ostriches' }, { id: 103, title: bad }]
		const r = box.run('memory', 'promote', '--json', box.write('b.json', JSON.stringify(items)), '--no-push')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /Item 103/)
		assert.ok(!(r.err + r.out).includes(GITHUB), 'the value is not echoed')
		assert.equal(box.entries().length, 0)
	}
	assert.match(box.run('memory', 'promote', '--type', 'decision').out, /Archived title 101/, 'nothing was marked')
	const unknown = box.run('memory', 'promote', '--json', box.write('u.json', JSON.stringify([{ id: 2, title: 'x' }, { id: 9999, title: 'y' }])), '--no-push')
	assert.notEqual(unknown.status, 0)
	assert.match(unknown.err, /Item 9999/)
	const noTitle = box.run('memory', 'promote', '--json', box.write('n.json', JSON.stringify([{ id: 101 }])), '--no-push')
	assert.notEqual(noTitle.status, 0)
	assert.match(noTitle.err, /Item 101 has no title/)
	assert.equal(box.entries().length, 0)
})

test('a stop between writing the lesson and marking the row does not duplicate on re-run', (t) => {
	const box = promoteBox(t)
	// What an interrupted run leaves: the lesson is written (with its source marker), the row is not marked.
	const first = box.write('w.json', JSON.stringify([{ kind: 'decision', title: 'Lesson number 101 about ostrich handling', scope: 'personal', tags: ['from-claude-mem'], source: { type: 'session', title: 'claude-mem decision 101' } }]))
	assert.equal(box.run('add', '--json', first, '--no-push').status, 0)
	assert.equal(box.entries().length, 1)
	// A different title for the same row is still found by its marker, not written again.
	const r = box.run('memory', 'promote', '--json', box.write('b.json', JSON.stringify([{ id: 101, title: 'Another wording of that lesson' }, { id: 103, title: 'Lesson number 103 about ostrich handling' }])), '--no-push')
	assert.equal(r.status, 0, r.err)
	assert.equal(box.entries().length, 2, 'row 101 was marked against the existing lesson; only 103 is new')
	assert.match(r.out, /1 new lesson, 1 found already written/)
	assert.doesNotMatch(box.run('memory', 'promote', '--type', 'decision').out, /Archived title 101\b/)
})

test('a failed push marks nothing, and a clean rerun marks them, adds no duplicate and pushes what was left behind', (t) => {
	const box = promoteBox(t)
	const file = box.write('b.json', box.batch([101, 103]))
	const before = box.remoteCount()
	const gate = join(box.remote, 'hooks', 'pre-receive')
	mkdirSync(dirname(gate), { recursive: true })
	writeFileSync(gate, '#!/bin/sh\necho refused >&2\nexit 1\n')
	chmodSync(gate, 0o755)

	const failed = box.run('memory', 'promote', '--json', file)
	assert.notEqual(failed.status, 0, 'the failure is not hidden')
	assert.equal(box.remoteCount(), before, 'nothing reached the remote')
	assert.match(box.run('memory', 'promote', '--type', 'decision').out, /Archived title 101\b/, 'nothing was marked')

	rmSync(gate)
	const rerun = box.run('memory', 'promote', '--json', file)
	assert.equal(rerun.status, 0, rerun.err)
	assert.match(rerun.out, /Promoted 2 \(0 new lessons, 2 found already written\)/)
	assert.equal(box.entries().length, 2, 'no duplicate')
	assert.doesNotMatch(box.run('memory', 'promote', '--type', 'decision').out, /Archived title 101\b/, 'marked now')
	assert.ok(box.remoteCount() > before, 'and the lessons are on the remote')
})

const auditBox = async (t) => {
	const box = cliBox(t)
	await loadMask()
	const db = openMemory(box.dbPath)
	writeBatch(db, { session: { id: 'sess-a', cwd: '/tmp/a', repo: '/tmp/a', branch: 'main', title: 't', startedAt: 1, lastEventAt: 2 }, messages: [
		{ uuid: 'u1', block: 0, role: 'prompt', at: 1, text: `a masked key ${GITHUB} stays masked` },
		{ uuid: 'u2', block: 0, role: 'answer', at: 2, text: 'the service_role word is kept on purpose' },
	] })
	db.close()
	return box
}

test('memory audit: counts rows and shapes, never a value; masked text and the bare word service_role count as nothing', async (t) => {
	const box = await auditBox(t)
	const clean = box.run('memory', 'audit')
	assert.equal(clean.status, 0, clean.err)
	assert.match(clean.out, /messages +2 rows/)
	assert.match(clean.out, /Rows checked: \d+\. Rows with a secret shape: 0\./)

	const planted = new DatabaseSync(box.dbPath)
	t.after(() => planted.close())
	planted.prepare("UPDATE messages SET text = ? WHERE uuid = 'u2'").run(`left bare ${GITHUB}`)
	planted.prepare("INSERT INTO archive (source_table, source_id, title, text, at) VALUES ('observations', '9', ?, 'x', 1)").run(`title with ${GITHUB}`)
	const found = box.run('memory', 'audit')
	assert.equal(found.status, 1, 'a hit is a failed proof')
	assert.match(found.out, /Rows with a secret shape: 2\./)
	assert.match(found.out, /GitHub token: 2/i)
	assert.ok(!found.out.includes(GITHUB) && !found.err.includes(GITHUB), 'no value on screen')
	assert.ok(!found.out.includes('left bare'), 'no text on screen')
})

test('memory audit: paths, folders, projects and log details are read too', async (t) => {
	const box = await auditBox(t)
	const planted = new DatabaseSync(box.dbPath)
	t.after(() => planted.close())
	const bare = `/x/${GITHUB}/y`
	planted.prepare("INSERT INTO session_files (session_id, path) VALUES ('sess-a', ?)").run(bare)
	planted.prepare("INSERT INTO commit_calls (session_id, call_hash, dirs) VALUES ('sess-a', 'h', ?)").run(bare)
	planted.prepare("INSERT INTO archive (source_table, source_id, project, title, text, at) VALUES ('observations', '8', ?, 't', 'x', 1)").run(bare)
	planted.prepare("UPDATE sessions SET cwd = ? WHERE id = 'sess-a'").run(bare)
	planted.prepare("INSERT INTO files (path, session_id) VALUES (?, 'sess-a')").run(bare)
	planted.prepare("INSERT INTO capture_log (at, kind, detail) VALUES (1, 'x', ?)").run(bare)
	const found = box.run('memory', 'audit')
	assert.equal(found.status, 1)
	assert.match(found.out, /Rows with a secret shape: 6\./)
	assert.ok(!found.out.includes(GITHUB), 'no value on screen')
})

test('memory audit: no database says so; it is named in the usage', (t) => {
	const box = cliBox(t)
	const r = box.run('memory', 'audit')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /no session database/i)
	assert.match(box.run('memory').err, /\baudit\b/)
})

test('promoted lessons are found by recall; the archive row they came from is not', (t) => {
	const box = promoteBox(t)
	assert.equal(box.run('memory', 'promote', '--json', box.write('b.json', box.batch([101])), '--no-push').status, 0)
	const hit = box.run('recall', 'lesson number 101 about ostrich handling')
	assert.match(hit.out, /ostrich/)
	assert.doesNotMatch(box.run('recall', 'zebrafish').out, /zebrafish/)
})
