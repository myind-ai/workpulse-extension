// node --test cli/brain-db.test.mjs
// The local database: temp paths only (every run sets WP_BRAIN_DB). Never touches the real Brain or ~/.workpulse/brain.db.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { dbState, entriesFor, openDb, query, rebuild, rebuildFile, recall, unavailable } from './brain-db.mjs'
import { brainSandbox, CLI, withinBudget } from './sandbox.mjs'

const NO_SQLITE = { NODE_OPTIONS: '--no-experimental-sqlite' }
const NO_FTS = { WP_BRAIN_DB_TEST: 'no-fts5' }
const temp = () => mkdtempSync(join(tmpdir(), 'wp-brain-db-'))

let at = 1_780_000_000_000
const lesson = (id, title, more = {}) => ({ schema: 'workpulse.bridge.entry/1', id, at: at++, device: 'cli-test', kind: 'learning', scope: 'work', title, ...more })

function memory(entries, libraryRoot = null) {
	const db = openDb(':memory:')
	rebuild(db, entries, libraryRoot)
	return db
}

const ids = (hits) => hits.map((h) => h.id)

/** Folders under a temp library root. */
function libraryRoot(folders) {
	const root = temp()
	for (const [rel, files] of Object.entries(folders)) {
		mkdirSync(join(root, rel), { recursive: true })
		for (const [name, text] of Object.entries(files)) writeFileSync(join(root, rel, name), text)
	}
	return root
}

// ── this Node ──────────────────────────────────────────────────────────────

test('node:sqlite with FTS5 and the Devanagari tokenizer really works in this Node', () => {
	assert.equal(unavailable(), null)
})

// ── building ───────────────────────────────────────────────────────────────

test('lessons and library text are indexed: a word in notes.md is found, and the hit names its entry and its folder', () => {
	const root = libraryRoot({
		'youtube/2026-09-14_viral_abc': { 'notes.md': 'The zeigarnik loop keeps people watching.', 'transcript.md': 'and a kaleidoscope appears at minute three', '.owner': 'cli-test\n', 'video.mp4': 'mediaword' },
		'site/a-loose-article': { 'article.md': 'Quokka facts nobody asked for.' },
	})
	const db = memory([lesson('a', 'Open with curiosity', { body: 'Notes: /x/youtube-learning/2026-09-14_viral_abc/notes.md' }), lesson('b', 'From the same place', { source: { type: 'youtube', library: 'bridge/library/youtube/2026-09-14_viral_abc' } }), lesson('c', 'Nothing to do with it')], root)
	const notes = ids(query(db, 'zeigarnik'))
	assert.ok(notes.includes('a') && notes.includes('b'), 'a lesson that names the folder is found by its notes')
	assert.ok(notes.includes('library:youtube/2026-09-14_viral_abc'), 'the folder is named too')
	assert.ok(!notes.includes('c'))
	assert.deepEqual(ids(query(db, 'kaleidoscope')), ['library:youtube/2026-09-14_viral_abc'], 'a transcript belongs to the folder alone: it would match anything')
	assert.deepEqual(ids(query(db, 'quokka')), ['library:site/a-loose-article'])
	assert.deepEqual(ids(query(db, 'mediaword')), [], 'media is never read')
})

test('rebuild reports what went in, and a link in the library is never followed', () => {
	const root = libraryRoot({ 'site/real': { 'notes.md': 'visible words' } })
	const outside = libraryRoot({ x: { 'notes.md': 'outsideword' } })
	symlinkSync(join(outside, 'x'), join(root, 'site', 'linked'))
	symlinkSync(join(outside, 'x', 'notes.md'), join(root, 'site', 'real', 'article.md'))
	const db = openDb(':memory:')
	assert.deepEqual(rebuild(db, [lesson('a', 'One'), lesson('b', 'Two')], root), { entries: 2, files: 1 })
	assert.deepEqual(ids(query(db, 'outsideword')), [])
})

test('a rebuilt file gives the same results after being deleted, and rebuilding twice leaves no duplicates', () => {
	const dir = temp()
	const path = join(dir, 'brain.db')
	const entries = [lesson('a', 'Retry the webhook with backoff'), lesson('b', 'Webhook signatures need raw bytes')]
	const results = () => {
		const db = openDb(path, { readOnly: true })
		try {
			return query(db, 'webhook retry').map(({ id, score, matched }) => ({ id, score, matched }))
		} finally {
			db.close()
		}
	}
	rebuildFile(path, entries, null, { head: 'h1', clone: '/c' })
	const first = results()
	assert.equal(first.length, 2)
	rmSync(path)
	rebuildFile(path, entries, null, { head: 'h1', clone: '/c' })
	assert.deepEqual(results(), first)
	rebuildFile(path, entries, null, { head: 'h1', clone: '/c' })
	assert.deepEqual(results(), first)
	const db = openDb(path)
	rebuild(db, entries, null)
	rebuild(db, entries, null)
	db.close()
	assert.deepEqual(results(), first, 'no duplicates in the same file either')
	assert.deepEqual(readdirSync(dir), ['brain.db'], 'no temp file left behind')
	assert.equal(statSync(path).mode & 0o777, 0o600, 'private notes are this user\'s alone')
})

test('a rebuild that fails leaves the old database in place', () => {
	const dir = temp()
	const path = join(dir, 'brain.db')
	rebuildFile(path, [lesson('a', 'Survivor lesson')], null, { head: 'h1', clone: '/c' })
	const bad = [{ ...lesson('b', 'Broken'), get next() { throw new Error('boom') } }]
	assert.throws(() => rebuildFile(path, bad, null, { head: 'h2', clone: '/c' }), /boom/)
	assert.equal(dbState(path, { head: 'h1', clone: '/c' }).state, 'fresh')
	assert.deepEqual(readdirSync(dir), ['brain.db'])
})

test('a rebuild sweeps what a killed one left, and leaves a young temp file, which a live rebuild may own', () => {
	const dir = temp()
	const path = join(dir, 'brain.db')
	const old = new Date(Date.now() - 3_600_000)
	for (const name of ['brain.db.111.tmp', 'brain.db.111.tmp-journal', 'brain.db.222.tmp']) {
		writeFileSync(join(dir, name), 'a copy of private notes')
		utimesSync(join(dir, name), old, old)
	}
	writeFileSync(join(dir, 'brain.db.333.tmp'), 'in use')
	writeFileSync(join(dir, 'brain.db.notes'), 'not ours')
	utimesSync(join(dir, 'brain.db.notes'), old, old)
	writeFileSync(join(dir, 'other.db.111.tmp'), 'not ours')
	utimesSync(join(dir, 'other.db.111.tmp'), old, old)
	rebuildFile(path, [lesson('a', 'x y')], null, { head: 'h1', clone: '/c' })
	assert.deepEqual(readdirSync(dir).sort(), ['brain.db', 'brain.db.333.tmp', 'brain.db.notes', 'other.db.111.tmp'])
})

test('the stored head and clone decide what is fresh', () => {
	const path = join(temp(), 'brain.db')
	assert.equal(dbState(path, { head: 'h1', clone: '/c' }).state, 'missing')
	rebuildFile(path, [lesson('a', 'x y')], null, { head: 'h1', clone: '/c' })
	assert.equal(dbState(path, { head: 'h1', clone: '/c' }).state, 'fresh')
	assert.equal(dbState(path, { head: 'h2', clone: '/c' }).state, 'stale')
	assert.equal(dbState(path, { head: 'h1', clone: '/other' }).state, 'stale')
	assert.equal(dbState(path, { head: '', clone: '/c' }).state, 'stale', 'no commit is never fresh')
})

test('an archived entry is not indexed', () => {
	const db = memory([lesson('a', 'Archived quokka lesson', { archived: true }), lesson('b', 'Quokka lesson still here')])
	assert.deepEqual(ids(query(db, 'quokka')), ['b'])
	assert.deepEqual(entriesFor(db, ['a']), [])
})

// ── ranking ────────────────────────────────────────────────────────────────

/**
 * Modelled on the real Brain, titles as they were written: lessons from one video about video scripts, and mistakes
 * about shell scripts, which won this prompt when the word search counted "write" and "script" and nothing else.
 */
const VIDEO = { project: 'youtube-learning', tags: ['youtube', 'content', 'scripting'], body: 'From "Psychology Behind My Viral Videos" https://www.youtube.com/watch?v=Ad7VTVeREOk&t=181s. Notes: /x/youtube-learning/2026-09-14_psychology_Ad7VTVeREOk/notes.md' }
const brain = () => [
	lesson('ppp', "Open every script with Promise-Proof-Plan: the result promised in the thumbnail, proof you did it, then how you'll show it #youtube #content #scripting", VIDEO),
	lesson('objections', 'Before a script, answer the 3 viewer objections on screen: is it for me, is this person credible #youtube #content #scripting', VIDEO),
	lesson('value', 'Value equation for hooks and listings: raise dream outcome, cut time and effort #youtube #content', { ...VIDEO, tags: ['youtube', 'content'] }),
	lesson('landing', "Landing script overwrote another session's uncommitted edits: a newline-separated file list was matched wrongly #git #tooling", { kind: 'mistake', tags: ['git', 'tooling'], rootCause: 'bad shell loop' }),
	lesson('write-tool', 'Write tool turned \\u escapes into real characters in a content script #ascii #tooling', { kind: 'mistake', tags: ['ascii', 'tooling'] }),
	lesson('pgrep', "Wait loops with pgrep -f on a script name never ended: the loop's own zsh command line matched #shell #tooling", { kind: 'mistake', tags: ['shell', 'tooling'] }),
	lesson('rm-rf', 'Re-run of a sync script did rm -rf on the folder and took node_modules with it #scripts', { kind: 'mistake', tags: ['scripts', 'tooling'] }),
	lesson('reel-whisper', 'Instagram reels have no subtitle tracks: save the caption and run Whisper #instagram', { tags: ['instagram', 'whisper'] }),
	lesson('stop-hook', 'A Stop hook that blocks must check stop_hook_active and ask once per session, or it loops #claude-code #hooks', { tags: ['claude-code', 'hooks'] }),
	lesson('worktree', 'Started feature edits in the main checkout instead of a new worktree #git', { kind: 'mistake', tags: ['git'] }),
	lesson('eleven', 'ElevenLabs stock voices sound English in Marathi; use native library voices by ID #elevenlabs #voice', { tags: ['elevenlabs', 'voice', 'marathi'] }),
	lesson('hindi', 'कहानी की शुरुआत वादे से करें और दर्शक का ध्यान पकड़ें #हिंदी', { tags: ['हिंदी'] }),
	lesson('studio', 'App video studio frames each screen for a narrated explainer', { tags: ['video'] }),
	lesson('pilot', 'HyperFrames pilot records the app screen at 30 fps', { tags: ['video-editing'] }),
	lesson('a-ticket', 'Reel script hook ticket log with every word of the prompt', { kind: 'ticket' }),
]

/** prompt, lessons that must come back, lessons that must not. Empty `yes` and `no: all` means silence. */
const PROMPTS = [
	['write the reel script hook', ['ppp'], ['landing', 'write-tool', 'pgrep', 'rm-rf', 'a-ticket']],
	['how should I open the youtube video script', ['ppp', 'objections'], ['landing', 'write-tool', 'pgrep']],
	['fix the shell script that hangs', ['pgrep'], ['ppp', 'objections']],
	['why is the stop hook looping', ['stop-hook'], ['value']],
	['elevenlabs marathi voice sounds english', ['eleven'], []],
	['git worktree conflict after a rebase', ['worktree'], ['ppp']],
	['दर्शक का ध्यान कैसे पकड़ें', ['hindi'], ['ppp']],
]
const SILENT = ['hello there how are you', 'please run the tests again', 'make the button blue', 'check the deploy status', 'add a new migration for the users table', '/commit', 'script', 'add a dark mode toggle to the settings screen in the flutter app']

for (const [prompt, yes, no] of PROMPTS) {
	test(`recall "${prompt}" finds ${yes.join(', ')}${no.length ? ` and not ${no.join(', ')}` : ''}`, () => {
		const got = ids(recall(memory(brain()), prompt))
		for (const id of yes) assert.ok(got.includes(id), `${id} missing from ${got}`)
		for (const id of no) assert.ok(!got.includes(id), `${id} should not be in ${got}`)
		assert.ok(got.length <= 3, 'at most three lessons')
	})
}

for (const prompt of SILENT) {
	test(`recall stays silent on "${prompt}"`, () => {
		assert.deepEqual(ids(recall(memory(brain()), prompt)), [])
	})
}

test('the entry with more of the words beats a stronger match on one word, then BM25 and the title decide', () => {
	const db = memory([lesson('one-word', 'Retry retry retry retry retry retry'), lesson('both', 'Nothing here', { body: 'retry the webhook' }), lesson('in-body', 'Other thing', { body: 'retry once' }), lesson('in-title', 'Retry once')])
	const got = query(db, 'webhook retry')
	assert.equal(got[0].id, 'both')
	assert.equal(got[0].matched, 2)
	assert.ok(ids(got).indexOf('in-title') < ids(got).indexOf('in-body'), 'a title word counts more than a body word')
})

test('word forms meet, and a hyphenated word is found by its parts', () => {
	const db = memory([lesson('a', 'Scripting long reels'), lesson('b', 'Promise-Proof-Plan')])
	assert.deepEqual(ids(query(db, 'scripts')), ['a'])
	assert.deepEqual(ids(query(db, 'reel')), ['a'])
	assert.deepEqual(ids(query(db, 'proof')), ['b'])
	assert.deepEqual(ids(query(db, 'promise-proof-plan')), ['b'])
})

test('two title words alone are below the bar; a word in both title and tags is enough at the lower score', () => {
	const db = memory(brain())
	const scoreOf = (prompt, id) => query(db, prompt, { kinds: ['learning'] }).find((h) => h.id === id)
	const weak = scoreOf('add a dark mode toggle to the settings screen in the flutter app', 'studio')
	assert.equal(weak.score, 11)
	assert.equal(weak.strong, false)
	const target = scoreOf('write the reel script hook', 'ppp')
	assert.equal(target.score, 9)
	assert.equal(target.strong, true)
})

test('Marathi filler words say nothing about the subject: the Shodkk lesson comes back and a lesson sharing only "कसा" does not', () => {
	const shodkk = lesson('shodkk', 'Shodkk is pronounced शोधक (shodhak), from the Satyashodhak Samaj Phule started: spell Shodkk on screen, voice always शोधक #shodkk #voice', { tags: ['shodkk', 'voice'] })
	const decoy = lesson('decoy', 'हा पाऊस कसा थांबला ते पाहा')
	const got = query(memory([shodkk, decoy]), 'शोधक कसा उच्चारायचा')
	assert.deepEqual(ids(got), ['shodkk'])
	const howTo = lesson('how-to', 'शोधक कसा उच्चारायचा: शोधक, shodhak', { tags: ['voice'] })
	assert.deepEqual(ids(recall(memory([howTo, decoy]), 'शोधक कसा उच्चारायचा')), ['how-to'])
})

test('an action word alone still searches; next to a subject it does not count', () => {
	const db = memory([lesson('a', 'Fix the alarm'), lesson('b', 'Alarm rings at eight')])
	assert.deepEqual(ids(query(db, 'fix')), ['a'])
	assert.equal(query(db, 'fix alarm').find((h) => h.id === 'a').matched, 1)
})

test('characters that mean something to FTS5 are only words', () => {
	const db = memory([lesson('a', 'Quotes and stars')])
	for (const q of ['"quotes', 'stars*', 'NOT quotes', 'title:quotes', 'quotes OR', '(stars)', 'a"b"c']) assert.doesNotThrow(() => query(db, q), q)
	assert.deepEqual(query(db, '"" * ()'), [])
})

test('Devanagari keeps its vowel signs: words are whole, and a word differing by a sign is another word', () => {
	const db = memory([lesson('work', 'काम पूरा हो गया'), lesson('less', 'कम समय लगा'), lesson('start', 'कहानी की शुरुआत')])
	assert.deepEqual(ids(query(db, 'काम')), ['work'])
	assert.deepEqual(ids(query(db, 'कम')), ['less'])
	assert.deepEqual(ids(query(db, 'शुरुआत')), ['start'])
	assert.deepEqual(ids(query(db, 'शुर')), [], 'the signs do not split the word')
	assert.deepEqual(ids(query(db, 'शुरु')), [])
})

// ── the CLI ────────────────────────────────────────────────────────────────

function eventually(check, what, ms = 60_000) {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) assert.fail(`never happened: ${what}`)
		spawnSync('sleep', ['0.2'])
	}
}

test('after add, search finds the lesson with no manual rebuild, and the database is never in the clone', () => {
	const { run, clone, git, dbFile } = brainSandbox()
	assert.equal(run('add', 'learning', 'First lesson about quokkas', '--no-push').status, 0)
	assert.match(run('search', 'quokkas').out, /First lesson about quokkas/)
	assert.ok(existsSync(dbFile))
	assert.match(run('db', 'status').out, /up to date/)
	assert.equal(run('add', 'learning', 'Second lesson about wombats', '--no-push').status, 0)
	assert.match(run('db', 'status').out, /behind the clone/)
	assert.match(run('search', 'wombats').out, /Second lesson about wombats/)
	assert.match(run('db', 'status').out, /up to date/)
	assert.equal(git('-C', clone, 'status', '--porcelain'), '', 'nothing new in the clone')
	assert.match(run('search', 'type:learning').out, /Second lesson/)
})

test('archive, restore and delete show in search and recall at once', () => {
	const { run } = brainSandbox()
	run('add', 'learning', 'Quokka handling needs gloves and patience', '--no-push')
	run('add', 'learning', 'Wombat handling needs gloves and patience', '--no-push')
	const prompt = 'quokka handling gloves'
	assert.match(run('search', prompt).out, /Quokka handling/)
	assert.match(run('recall', prompt).out, /Quokka handling/)
	const id = run('list').out.split('\n').find((l) => l.includes('Quokka')).match(/\[(\w+)\]\s*$/)[1]
	run('archive', id, '--no-push')
	assert.doesNotMatch(run('search', prompt).out, /Quokka handling/)
	assert.doesNotMatch(run('recall', prompt).out, /Quokka handling/)
	run('restore', id, '--no-push')
	assert.match(run('search', prompt).out, /Quokka handling/)
	run('rm', id, '--no-push')
	assert.doesNotMatch(run('search', prompt).out, /Quokka handling/)
	assert.doesNotMatch(run('recall', prompt).out, /Quokka handling/)
})

test('search still applies filters to words, and names a library folder its words were found in', () => {
	const box = brainSandbox({ config: { library: true } })
	const { run, root, git, clone } = box
	run('add', 'mistake', 'Quokka mistake', '--no-push')
	run('add', 'learning', 'Quokka lesson', '--no-push', '--tags', 'animals')
	assert.doesNotMatch(run('search', 'quokka type:mistake').out, /Quokka lesson/)
	assert.match(run('search', 'quokka #animals').out, /Quokka lesson/)
	assert.doesNotMatch(run('search', 'quokka #animals').out, /Quokka mistake/)
	mkdirSync(join(root, 'vid'))
	writeFileSync(join(root, 'vid', 'notes.md'), 'Capybaras are calm\n')
	assert.equal(run('library', 'add', join(root, 'vid'), '--type', 'site', '--no-push').status, 0)
	assert.match(run('search', 'capybaras').out, /library\s+site\/vid/)
	assert.doesNotMatch(run('search', 'capybaras type:mistake').out, /site\/vid/)
	assert.equal(git('-C', clone, 'status', '--porcelain'), '')
})

test('db rebuild reports counts, and db status and help describe it', () => {
	const { run, dbFile } = brainSandbox()
	run('add', 'learning', 'Quokka lesson', '--no-push')
	assert.match(run('db', 'status').out, /not built yet/)
	const built = run('db', 'rebuild')
	assert.equal(built.status, 0, built.err)
	assert.match(built.out, /1 entries and 0 library files/)
	assert.match(built.out, /never committed/)
	assert.ok(existsSync(dbFile))
	assert.match(run('db', 'status').out, /up to date/)
	assert.notEqual(run('db', 'nonsense').status, 0)
	assert.match(run('help').out, /wp-brain db rebuild \| status/)
})

test('a stale database answers recall with the new lesson at once, then rebuilds itself in the background', () => {
	const { run, dbFile } = brainSandbox()
	run('add', 'learning', 'Quokka handling needs gloves and patience', '--no-push')
	run('db', 'rebuild')
	run('add', 'learning', 'Wombat burrows collapse after heavy rain', '--no-push')
	assert.match(run('db', 'status').out, /behind the clone/)
	const r = run('recall', 'wombat burrows rain')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /Wombat burrows/)
	eventually(() => /up to date/.test(run('db', 'status').out), 'the background rebuild')
	assert.ok(!existsSync(`${dbFile}.lock`), 'the lock is released')
})

test('a burst of prompts on a stale database starts one background rebuild, not one each', async () => {
	const { root, run, configPath, sessions, dbFile } = brainSandbox()
	run('add', 'learning', 'Quokka handling needs gloves and patience', '--no-push')
	run('db', 'rebuild')
	run('add', 'learning', 'Wombat burrows collapse after heavy rain', '--no-push')
	// In every Node from here down: a `db rebuild` process counts itself and holds on, so the burst fits inside it.
	const counted = join(root, 'rebuilds.txt')
	const preload = join(root, 'count-rebuilds.cjs')
	writeFileSync(preload, `if (process.argv.includes('--background')) { require('node:fs').appendFileSync(${JSON.stringify(counted)}, 'x'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000) }`)
	const env = { ...process.env, NODE_OPTIONS: `--require ${preload}`, WP_BRAIN_CONFIG: configPath, WP_BRAIN_SESSIONS: sessions, WP_BRAIN_DB: dbFile }
	const one = () => new Promise((done) => spawn('node', [CLI, 'recall', 'wombat burrows rain'], { env, stdio: 'ignore' }).on('exit', done))
	await Promise.all(Array.from({ length: 6 }, one))
	eventually(() => existsSync(counted), 'a background rebuild starting')
	assert.ok(readFileSync(counted, 'utf8').length <= 2, `${readFileSync(counted, 'utf8').length} background rebuilds`)
	eventually(() => /up to date/.test(run('db', 'status').out), 'the background rebuild')
})

test('the hook prints only its JSON, and shows a lesson once per session', () => {
	const { run, runWith } = brainSandbox()
	run('add', 'learning', 'Quokka handling needs gloves and patience', '--no-push')
	run('db', 'rebuild')
	const input = JSON.stringify({ session_id: 's1', prompt: 'quokka handling gloves', cwd: tmpdir() })
	const first = runWith({ input }, 'recall')
	assert.equal(first.status, 0, first.err)
	assert.equal(first.err, '')
	assert.match(JSON.parse(first.out).hookSpecificOutput.additionalContext, /Quokka handling/)
	assert.equal(runWith({ input }, 'recall').out, '')
})

for (const [name, env] of [['node:sqlite is missing', NO_SQLITE], ['FTS5 is missing', NO_FTS]]) {
	test(`when ${name}, search and recall fall back, nothing is written, and doctor warns`, () => {
		const { root, runWith, dbFile } = brainSandbox()
		const home = join(root, 'claude')
		const e = { ...env, CLAUDE_HOME: home }
		runWith(e, 'add', 'learning', 'Quokka handling needs gloves and patience', '--no-push')
		const found = runWith(e, 'search', 'quokka')
		assert.equal(found.status, 0, found.err)
		assert.match(found.out, /Quokka handling/)
		const recalled = runWith(e, 'recall', 'quokka handling gloves')
		assert.equal(recalled.status, 0, recalled.err)
		assert.match(recalled.out, /Quokka handling/)
		const hook = runWith({ ...e, input: JSON.stringify({ session_id: 's', prompt: 'quokka handling gloves', cwd: tmpdir() }) }, 'recall')
		assert.equal(hook.status, 0)
		assert.equal(hook.err, '')
		assert.match(JSON.parse(hook.out).hookSpecificOutput.additionalContext, /Quokka handling/)
		const doctor = runWith(e, 'doctor')
		assert.match(doctor.out, /! Local database\s+not available/)
		assert.notEqual(runWith(e, 'db', 'rebuild').status, 0)
		assert.ok(!existsSync(dbFile))
	})
}

test('a corrupt file: doctor warns, search and recall still answer with no error, and db rebuild repairs it', () => {
	const { root, run, runWith, dbFile } = brainSandbox()
	const e = { CLAUDE_HOME: join(root, 'claude') }
	run('add', 'learning', 'Quokka handling needs gloves and patience', '--no-push')
	writeFileSync(dbFile, 'this is not a database, it is not even close '.repeat(200))
	assert.match(runWith(e, 'doctor').out, /! Local database\s+the file is unreadable/)
	const recalled = run('recall', 'quokka handling gloves')
	assert.equal(recalled.status, 0, recalled.err)
	assert.equal(recalled.err, '')
	assert.match(recalled.out, /Quokka handling/)
	const found = run('search', 'quokka')
	assert.equal(found.status, 0, found.err)
	assert.equal(found.err, '')
	assert.match(found.out, /Quokka handling/)
	assert.equal(run('db', 'rebuild').status, 0)
	assert.match(run('db', 'status').out, /up to date/)
})

test('damage inside a database that looks up to date still falls back, and a rebuild replaces it', () => {
	const { run, dbFile } = brainSandbox()
	run('add', 'learning', 'Quokka handling needs gloves and patience', '--no-push')
	run('db', 'rebuild')
	const db = openDb(dbFile)
	db.exec('DROP TABLE entries')
	db.close()
	const r = run('recall', 'quokka handling gloves')
	assert.equal(r.status, 0, r.err)
	assert.equal(r.err, '')
	assert.match(r.out, /Quokka handling/)
	eventually(() => {
		const check = openDb(dbFile, { readOnly: true })
		try {
			check.prepare('SELECT count(*) FROM entries').get()
			return true
		} catch {
			return false
		} finally {
			check.close()
		}
	}, 'a rebuild replacing the damaged file')
})

// ── time and output ────────────────────────────────────────────────────────

test('recall on 2,000 entries costs under its budget on top of starting the CLI, and prints no warning', (t) => {
	const { clone, git, run, configPath, sessions, dbFile } = brainSandbox()
	const words = 'retry webhook alarm voice reel shell cache token render queue subtitle layout migration deploy sensor'.split(' ')
	const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ schema: 'workpulse.bridge.entry/1', id: `e_${i}`, at: 1_780_000_000_000 + i, device: 'cli-test', kind: i % 5 ? 'learning' : 'mistake', scope: 'work', title: `${words[i % 15]} ${words[(i * 7 + 3) % 15]} lesson number ${i} about ${words[(i * 11 + 5) % 15]} handling`, body: `What happened with ${words[(i * 13) % 15]} and why the ${words[(i * 3) % 15]} step broke, in a few plain sentences. `.repeat(3), tags: [words[i % 15]] }))
	const rel = 'bridge/entries/2026-10'
	mkdirSync(join(clone, rel), { recursive: true })
	writeFileSync(join(clone, rel, 'cli-test.jsonl'), lines.join('\n') + '\n')
	git('-C', clone, 'add', 'bridge')
	git('-C', clone, 'commit', '-q', '-m', 'fixture')
	const timed = (...args) => {
		const t = performance.now()
		const env = { ...process.env, WP_BRAIN_CONFIG: configPath, WP_BRAIN_SESSIONS: sessions, WP_BRAIN_DB: dbFile, CLAUDE_HOME: join(configPath, '..', 'claude-home'), WP_BRAIN_RULE_INDEX: join(configPath, '..', 'rule-index.json') }
		const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env })
		return { ms: performance.now() - t, ...r }
	}
	const best = (...args) => Math.min(...[1, 2, 3].map(() => timed(...args).ms))
	const start = best('help')
	// A first recall with no database yet builds one, so each of the three starts from none: best of 3 against best of 3.
	const staleBest = Math.min(...[1, 2, 3].map(() => {
		for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true })
		const stale = timed('recall', 'retry webhook handling')
		assert.equal(stale.status, 0, stale.stderr)
		assert.equal(stale.stderr, '', 'no warning on a stale database')
		assert.match(stale.stdout, /lesson number/)
		return stale.ms
	}))
	assert.equal(run('db', 'rebuild').status, 0)
	const fresh = timed('recall', 'retry webhook handling')
	assert.equal(fresh.stderr, '', 'no warning on a fresh database')
	assert.match(fresh.stdout, /lesson number/)
	const freshBest = best('recall', 'retry webhook handling')
	// Measured against starting the CLI on this machine at this moment, so a loaded machine does not fail it.
	const BUDGET_MS = 500
	withinBudget(t, freshBest - start, BUDGET_MS, 'fresh recall, beyond starting the CLI,')
	withinBudget(t, staleBest - start, BUDGET_MS * 2, 'stale recall, beyond starting the CLI,')
})

test('no warning is printed by the query commands', () => {
	const { run } = brainSandbox()
	run('add', 'learning', 'Quokka handling needs gloves and patience', '--no-push')
	for (const args of [['search', 'quokka'], ['recall', 'quokka handling gloves'], ['db', 'status'], ['db', 'rebuild']]) {
		const r = run(...args)
		assert.equal(r.status, 0, r.err)
		assert.doesNotMatch(r.err, /Warning/, args.join(' '))
	}
})

// ── doctor ─────────────────────────────────────────────────────────────────

const backupLine = (out) => out.split('\n').find((l) => l.includes('Extension backup')) ?? ''

test('doctor: no backup folder says not on this branch; files without a manifest say what is there', () => {
	const box = brainSandbox()
	const { root, clone, git, runWith } = box
	const e = { CLAUDE_HOME: join(root, 'claude') }
	assert.match(backupLine(runWith(e, 'doctor').out), /! .*not on this branch yet/)
	mkdirSync(join(clone, 'workpulse', 'records'), { recursive: true })
	writeFileSync(join(clone, 'workpulse', 'INDEX.md'), 'index\n')
	writeFileSync(join(clone, 'workpulse', 'graph.json'), '{}\n')
	writeFileSync(join(clone, 'workpulse', 'records', 'a.md'), 'a\n')
	git('-C', clone, 'add', 'workpulse')
	git('-C', clone, 'commit', '-q', '-m', 'an older copy of the index')
	const line = backupLine(runWith(e, 'doctor').out)
	assert.doesNotMatch(line, /not on this branch/)
	assert.match(line, /! .*workpulse\/ holds 3 files, but no backup data yet/)
})

test('doctor: a backup with its manifest is present, and one only on the remote says so', () => {
	const box = brainSandbox()
	const { root, clone, git, runWith, configPath } = box
	const e = { CLAUDE_HOME: join(root, 'claude') }
	writeFileSync(configPath, JSON.stringify({ repo: 'test/brain', clone, device: 'cli-test', branch: 'main' }))
	const other = join(root, 'other')
	git('clone', '-q', box.remote, other)
	git('-C', other, 'config', 'user.email', 'test@example.com')
	git('-C', other, 'config', 'user.name', 'Other')
	mkdirSync(join(other, 'workpulse', 'data'), { recursive: true })
	writeFileSync(join(other, 'workpulse', 'index.json'), '{}\n')
	writeFileSync(join(other, 'workpulse', 'data', 'meta.json'), '{}\n')
	git('-C', other, 'add', 'workpulse')
	git('-C', other, 'commit', '-q', '-m', 'backup')
	git('-C', other, 'push', '-q', 'origin', 'HEAD:main')
	git('-C', clone, 'fetch', '-q', 'origin')
	assert.match(backupLine(runWith(e, 'doctor').out), /✓ .*on the remote, 2 files, not pulled here yet/)
	git('-C', clone, 'merge', '-q', '--ff-only', 'origin/main')
	assert.match(backupLine(runWith(e, 'doctor').out), /✓ .*workpulse\/ present, 2 files \(its Learnings reach the brief\)/)
})

test('doctor reports the database in each state', () => {
	const { root, run, runWith } = brainSandbox()
	const e = { CLAUDE_HOME: join(root, 'claude') }
	const line = () => runWith(e, 'doctor').out.split('\n').find((l) => l.includes('Local database'))
	assert.match(line(), /✓ Local database\s+not built yet/)
	run('add', 'learning', 'Quokka', '--no-push')
	run('db', 'rebuild')
	assert.match(line(), /✓ Local database\s+up to date/)
	run('add', 'learning', 'Wombat', '--no-push')
	assert.match(line(), /✓ Local database\s+behind the clone/)
})
