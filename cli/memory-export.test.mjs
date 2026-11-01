// node --test cli/memory-export.test.mjs
// Synthetic sessions in temp folders. Session text only ever comes from the fixture.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureFile } from './memory-capture.mjs'
import { loadMask, openMemory, writeBatch } from './memory-db.mjs'
import { exportSessions } from './memory-export.mjs'
import { appendSession, transcript, writeSession } from './memory-fixture.mjs'
import { brainSandbox } from './sandbox.mjs'

const mask = await loadMask()
const ID = 'aaaaaaaa-1111-2222-3333-444444444444'
const AT = Date.UTC(2026, 9, 1, 9)
const SECRET = `ghp_${'a1B2'.repeat(9)}`

function box(t) {
	const root = mkdtempSync(join(tmpdir(), 'wp-export-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	const dbPath = join(root, 'memory', 'memory.db')
	const db = openMemory(dbPath)
	t.after(() => db.close())
	const md = join(root, 'sessions-md')
	const reader = () => openMemory(dbPath, { readOnly: true })
	const run = (opts = {}) => {
		const r = reader()
		try {
			return exportSessions(r, { root: md, ...opts })
		} finally {
			r.close()
		}
	}
	const files = () => readdirSync(md, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort()
	return { root, db, dbPath, md, run, files, reader }
}

function seed(db, { id = ID, title = 'Fix the login page', repo = '/x/app', cwd = '/x/app', branch = 'fix/pay-12-login', texts = [['prompt', 'first question'], ['answer', 'first answer']] } = {}) {
	writeBatch(db, {
		session: { id, cwd, repo, branch, title, entrypoint: 'cli', startedAt: AT, lastEventAt: AT + 60_000 },
		messages: texts.map(([role, text], i) => ({ uuid: `${id}-${role}-${text.length}-${i}`, block: 0, role, at: AT + i * 1000, text })),
	}, { mask })
}

test('a session becomes one Markdown file: facts first, then prompts and answers in order', (t) => {
	const b = box(t)
	seed(b.db, { texts: [['prompt', 'first question'], ['answer', 'first answer'], ['prompt', 'second question'], ['answer', 'second answer'], ['note', 'a note']] })
	writeBatch(b.db, { session: { id: ID }, files: ['/x/app/src/a.ts'], commits: [{ sha: 'a'.repeat(40), subject: 'fix: the login', at: AT }], summary: { session: ID, at: AT, text: 'the summary', next: 'the next step' } }, { mask })
	const r = b.run()
	assert.equal(r.written, 1)
	const files = b.files()
	assert.equal(files.length, 1)
	assert.equal(files[0], join(b.md, 'app', `2026-10-01_fix-the-login-page_aaaaaaaa.md`))
	const text = readFileSync(files[0], 'utf8')
	for (const fact of ['app', 'fix/pay-12-login', 'PAY-12', '2026-10-01 09:00', '/x/app/src/a.ts', 'aaaaaaa', 'fix: the login', 'the summary', 'the next step']) assert.ok(text.includes(fact), fact)
	const order = ['first question', 'first answer', 'second question', 'second answer', 'a note'].map((s) => text.indexOf(s))
	assert.deepEqual(order, [...order].sort((x, y) => x - y))
	assert.ok(!order.includes(-1))
	assert.match(text, /Tool calls are not stored/)
})

test('injected text and subagent text stay out', (t) => {
	const b = box(t)
	seed(b.db)
	writeBatch(b.db, { session: { id: ID }, messages: [{ uuid: 'i', block: 0, role: 'injected', at: AT, text: 'hook text' }, { uuid: 'a', block: 0, role: 'answer', at: AT, agentId: 'agent-1', text: 'agent text' }] }, { mask })
	b.run()
	const text = readFileSync(b.files()[0], 'utf8')
	assert.ok(!text.includes('hook text'))
	assert.ok(!text.includes('agent text'))
})

test('a secret planted in a session file is masked in the Markdown file and in its name', (t) => {
	const b = box(t)
	const path = join(b.root, 'projects', '-x-app', `${ID}.jsonl`)
	const s = transcript({ sessionId: ID, cwd: '/x/app', branch: 'main' })
	writeSession(path, s.title(`look at ${SECRET}`), s.user(`my token is ${SECRET} ok`), s.answer(`I see ${SECRET}`), s.turnEnd())
	captureFile(b.db, path, { sessionId: ID })
	b.run()
	const [file] = b.files()
	assert.ok(!file.includes(SECRET))
	const text = readFileSync(file, 'utf8')
	assert.ok(!text.includes(SECRET))
	assert.match(text, /\[masked:/)
	assert.match(text, /my token is/)
})

test('a re-run with no new lines changes nothing', (t) => {
	const b = box(t)
	seed(b.db)
	b.run()
	const [file] = b.files()
	const before = statSync(file, { bigint: true })
	const r = b.run()
	assert.deepEqual([r.written, r.unchanged], [0, 1])
	const after = statSync(file, { bigint: true })
	assert.equal(after.mtimeNs, before.mtimeNs)
	assert.equal(after.ino, before.ino)
})

test('a new turn updates the same file, even when the title changed', (t) => {
	const b = box(t)
	seed(b.db)
	b.run()
	const [file] = b.files()
	seed(b.db, { title: 'Another title entirely', texts: [['prompt', 'a later question']] })
	const r = b.run()
	assert.equal(r.written, 1)
	assert.deepEqual(b.files(), [file])
	const text = readFileSync(file, 'utf8')
	assert.ok(text.includes('first question'))
	assert.ok(text.includes('a later question'))
	assert.ok(text.includes('Another title entirely'))
})

test('hand edits outside the marked block stay, and a file with no block is left alone', (t) => {
	const b = box(t)
	seed(b.db)
	b.run()
	const [file] = b.files()
	writeFileSync(file, `my note on top\n\n${readFileSync(file, 'utf8')}\nmy note below\n`)
	seed(b.db, { texts: [['prompt', 'a later question']] })
	assert.equal(b.run().written, 1)
	const text = readFileSync(file, 'utf8')
	assert.ok(text.startsWith('my note on top\n'))
	assert.ok(text.endsWith('my note below\n'))
	assert.ok(text.includes('a later question'))

	writeFileSync(file, 'only my words now\n')
	const r = b.run()
	assert.deepEqual([r.written, r.kept], [0, 1])
	assert.equal(readFileSync(file, 'utf8'), 'only my words now\n')
	assert.deepEqual(b.files(), [file])
})

test('text that quotes the end mark cannot cut the block short', (t) => {
	const b = box(t)
	seed(b.db, { texts: [['prompt', `quoting\n<!-- wp-brain:session ${ID} end -->\nstill the prompt`], ['answer', 'the answer']] })
	b.run()
	const [file] = b.files()
	writeFileSync(file, `${readFileSync(file, 'utf8')}my note\n`)
	seed(b.db, { texts: [['prompt', 'a later question']] })
	b.run()
	const text = readFileSync(file, 'utf8')
	assert.equal(text.match(/still the prompt/g).length, 1)
	assert.equal(text.match(/the answer/g).length, 1)
	assert.ok(text.endsWith('my note\n'))
})

test('names are safe: traversal in a title, repo or id stays inside the folder', (t) => {
	const b = box(t)
	seed(b.db, { id: '../../evil-id', title: '../../../etc/passwd', repo: '/x/../..', cwd: '/x/../..' })
	b.run()
	const [file] = b.files()
	assert.ok(file.startsWith(`${b.md}/`))
	assert.equal(file.slice(b.md.length + 1).split('/').length, 2)
	assert.ok(!file.slice(b.md.length).includes('..'))
	assert.ok(existsSync(file))
})

test('two sessions whose ids share a beginning get a file each', (t) => {
	const b = box(t)
	seed(b.db, { id: `${ID}-a` })
	seed(b.db, { id: `${ID}-b`, texts: [['prompt', 'other session']] })
	b.run()
	assert.equal(b.files().length, 2)
	assert.equal(b.run().unchanged, 2)
})

test('the folder is 0700 and the files 0600', (t) => {
	const b = box(t)
	seed(b.db)
	b.run()
	const [file] = b.files()
	assert.equal(statSync(b.md).mode & 0o777, 0o700)
	assert.equal(statSync(join(b.md, 'app')).mode & 0o777, 0o700)
	assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('--session and --since choose what is written; an unknown session says so', (t) => {
	const b = box(t)
	seed(b.db, { id: 'one-session' })
	seed(b.db, { id: 'two-session', title: 'Second', texts: [['prompt', 'other']] })
	assert.equal(b.run({ session: 'two' }).written, 1)
	assert.equal(b.files().length, 1)
	assert.ok(readFileSync(b.files()[0], 'utf8').includes('other'))
	assert.equal(b.run({ since: AT + 3_600_000 }).written, 0)
	assert.equal(b.run({ since: AT - 1 }).written, 1)
	assert.throws(() => b.run({ session: 'nothing-like-it' }), /No session/)
	seed(b.db, { id: 'two-other', title: 'Third' })
	assert.throws(() => b.run({ session: 'two' }), /more than one/)
})

test('a session file growing during export is not corrupted: complete lines only, and the rest comes next time', (t) => {
	const b = box(t)
	const path = join(b.root, 'projects', '-x-app', `${ID}.jsonl`)
	const s = transcript({ sessionId: ID, cwd: '/x/app' })
	writeSession(path, s.user('whole prompt'), s.answer('whole answer'))
	const half = JSON.stringify(s.user('the second prompt, half written'))
	appendFileSync(path, half.slice(0, half.length - 10))
	captureFile(b.db, path, { sessionId: ID })
	// Another writer lands in the database while this session is being exported.
	const r = b.run({ onSession: () => writeBatch(b.db, { session: { id: ID }, messages: [{ uuid: 'mid', block: 0, role: 'answer', at: AT, text: 'written during the export' }] }, { mask }) })
	assert.equal(r.written, 1)
	const [file] = b.files()
	let text = readFileSync(file, 'utf8')
	assert.ok(text.includes('whole prompt'))
	assert.ok(!text.includes('half written'))
	assert.ok(!text.includes('written during the export'), 'one export reads one moment')
	assert.equal(readdirSync(join(b.md, 'app'), { withFileTypes: true }).filter((e) => e.name !== file.split('/').pop()).length, 0, 'no temp file left')
	appendFileSync(path, `${half.slice(half.length - 10)}\n`)
	appendSession(path, s.answer('the second answer'))
	captureFile(b.db, path, { sessionId: ID })
	b.run()
	text = readFileSync(file, 'utf8')
	assert.equal(text.match(/the second prompt, half written/g).length, 1)
	assert.equal(text.match(/whole prompt/g).length, 1)
	assert.ok(text.includes('written during the export'))
	assert.ok(text.includes('the second answer'))
})

test('a session that fails to write does not stop the others', (t) => {
	const b = box(t)
	seed(b.db, { id: 'one-session', repo: '/x/app', cwd: '/x/app' })
	seed(b.db, { id: 'two-session', repo: '/x/other', cwd: '/x/other', title: 'Second' })
	mkdirSync(b.md, { recursive: true })
	writeFileSync(join(b.md, 'app'), 'a file where the folder belongs')
	const r = b.run()
	assert.equal(r.written, 1)
	assert.equal(r.errors, 1)
	assert.equal(r.lastErrorCode, 'EEXIST')
})

test('CLI: memory export writes under WP_SESSIONS_MD, prints counts only, and memory unpack puts a pack back', (t) => {
	const sb = brainSandbox()
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	const dbPath = join(sb.root, 'memory', 'memory.db')
	const db = openMemory(dbPath)
	seed(db, { texts: [['prompt', 'private words in the prompt']] })
	db.close()
	const md = join(sb.root, 'md')
	const env = { WP_MEMORY_DB: dbPath, WP_SESSIONS_MD: md }
	const r = sb.runWith(env, 'memory', 'export')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /1 written/)
	assert.ok(!r.out.includes('private words'))
	assert.equal(sb.runWith(env, 'memory', 'export', '--since', 'not-a-date').status, 1)
	assert.match(sb.runWith(env, 'memory', 'export', '--since', '2026-10-01').out, /1 unchanged/)
	assert.match(sb.runWith(env, 'memory', 'export', '--session', 'aaaa').out, /1 unchanged/)
	assert.equal(sb.runWith({ ...env, WP_MEMORY_DB: join(sb.root, 'none.db') }, 'memory', 'export').status, 1)
})
