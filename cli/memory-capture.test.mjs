// node --test cli/memory-capture.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { mainTranscripts } from './claude-files.mjs'
import { backfill, backfillPlan, captureFile, captureSession, captureSince, parseLine } from './memory-capture.mjs'
import { ftsQuery, openMemory, searchMemory, showSession, writeBatch } from './memory-db.mjs'
import { appendSession, lines, transcript, writeSession } from './memory-fixture.mjs'
import { VENDOR_SHAPES } from './memory-mask.mjs'
import { missedSessions } from './memory-note.mjs'
import { brainSandbox } from './sandbox.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'memory-capture.mjs')
const MINUTE = 60_000

/** A temp folder with a database; the callback's folder is removed afterwards. */
function withDb(fn) {
	const root = mkdtempSync(join(tmpdir(), 'wp-memory-capture-'))
	const dbPath = join(root, 'memory', 'memory.db')
	const db = openMemory(dbPath)
	try {
		return fn({ root, db, dbPath, session: (id = 'session-1') => join(root, 'projects', '-tmp-app', `${id}.jsonl`) })
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
}
const count = (db, table, where = '1') => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n
const messages = (db) => db.prepare('SELECT role, text, agent_id, subtype FROM messages ORDER BY id').all()
const sessionRow = (db, id = 'session-1') => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)

/** Secrets built at run time from parts, so no scanner mistakes this file for a leak. */
const SHAPES = {
	github: 'gh' + 'p_a1B2c3D4e5F6g7H8i9J0k1L2',
	anthropic: 'sk-' + 'ant-abcdefghij0123456789abcd',
	supabase: 'sb' + 'p_0123456789abcdef0123456789',
	aws: 'AK' + 'IAABCDEFGHIJKLMNOP',
	slack: 'xo' + 'xb-1234567890-abcdefghij',
	jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
	age: 'AGE-SECRET-' + 'KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQ',
	googleApi: 'AI' + 'za0123456789abcdefghijklmnopqrstuvwx',
	googleOauth: 'ya' + '29.a0AbCdEfGhIjKlMnOpQrSt',
	resend: 're' + '_Ab12Cd34Ef56Gh78Ij90Kl',
	nvidia: 'nv' + 'api-abcdefghij0123456789',
	stripe: 'sk' + '_live_abcdefghij012345',
	skUnderscore: 'sk' + '_abcdefghij0123456789abcdef',
	razorpay: 'rz' + 'p_live_abcdefghij12',
	digitalocean: 'do' + 'p_v1_0123456789abcdef0123456789',
	cashfree: 'cf' + 'sk_abcdefghij12',
}
/** One sample for each of the masker's vendor shapes. */
const VENDOR_SAMPLES = {
	'GitLab token': 'gl' + 'pat-abcdefghij0123456789',
	'npm token': 'np' + 'm_abcdefghij0123456789abcdefghij0123',
	'Hugging Face token': 'hf' + '_abcdefghij0123456789abcdefghij0123',
	'SendGrid key': 'SG' + '.abcdefghij012345.abcdefghij012345',
	'Webhook secret': 'wh' + 'sec_abcdefghij0123456789',
	'Stripe restricted key': 'rk' + '_live_abcdefghij012345',
	'Slack app token': 'xa' + 'pp-1-abcdefghij0123456789',
	'AWS session key': 'AS' + 'IAABCDEFGHIJKLMNOP',
	'Groq key': 'gs' + 'k_abcdefghij0123456789abcdefghij0123',
	'Supabase secret key': 'sb' + '_secret_abcdefghij0123456789',
	'DigitalOcean refresh token': 'do' + 'r_v1_0123456789abcdef0123456789',
	'PyPI token': 'py' + 'pi-abcdefghij0123456789',
}
Object.assign(SHAPES, VENDOR_SAMPLES)
const rawBytes = (dbPath) => Buffer.concat(['', '-wal'].map((s) => (existsSync(dbPath + s) ? readFileSync(dbPath + s) : Buffer.alloc(0))))

function tempRepo(root, name = 'repo') {
	const dir = join(root, name)
	mkdirSync(dir, { recursive: true })
	const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
	git('init', '-q', '-b', 'main')
	git('config', 'user.email', 'test@example.com')
	git('config', 'user.name', 'Test')
	git('config', 'commit.gpgsign', 'false')
	const commit = (subject) => {
		git('commit', '-q', '--allow-empty', '-m', subject)
		return git('rev-parse', 'HEAD')
	}
	return { dir, git, commit }
}

// ── roles and text ──────────────────────────────────────────────────────────

test('roles: each measured promptSource and origin.kind, and an unknown value is injected', () => {
	const t = transcript()
	const roleOf = (extra) => parseLine(t.user('hello', extra)).messages[0].role
	for (const promptSource of ['typed', 'suggestion_accepted', 'queued', undefined]) assert.equal(roleOf({ promptSource }), 'prompt', String(promptSource))
	for (const promptSource of ['sdk', 'system', 'something_new']) assert.equal(roleOf({ promptSource }), 'injected', promptSource)
	assert.equal(roleOf({ origin: { kind: 'human' } }), 'prompt')
	for (const kind of ['task-notification', 'peer', 'coordinator', 'auto-continuation', 'something_new']) assert.equal(roleOf({ origin: { kind } }), 'injected', kind)
	assert.equal(roleOf({ isMeta: true }), 'injected')
	assert.equal(roleOf({ isVisibleInTranscriptOnly: true }), 'injected')
	assert.equal(parseLine(t.compact('compacted')).messages[0].role, 'note')
	assert.equal(parseLine(t.away('while you were away')).messages[0].role, 'note')
	assert.equal(parseLine(t.answer('hi')).messages[0].role, 'answer')
	assert.equal(parseLine(t.away('x')).messages[0].subtype, 'away_summary')
	assert.equal(parseLine(t.compact('x')).messages[0].subtype, 'compact')
})

test('parseLine ignores what is ignored on purpose, and is pure', () => {
	const t = transcript()
	for (const type of ['attachment', 'file-history-snapshot', 'queue-operation', 'cost-state', 'api-request-start']) assert.equal(parseLine({ type, sessionId: 's' }), null, type)
	assert.equal(parseLine({ type: 'system', subtype: 'turn_duration', content: 'x' }), null)
	assert.equal(parseLine(null), null)
	const row = t.user('x')
	const copy = JSON.stringify(row)
	parseLine(row)
	assert.equal(JSON.stringify(row), copy)
})

test('a system-reminder block is removed; a row of only that, thinking and tool blocks store nothing; latest title wins', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		const reminder = '<system-reminder>REMINDER-SENTINEL do this</system-reminder>'
		writeSession(session(),
			t.user(`${reminder}\nreal words${reminder}`),
			t.user(reminder),
			t.user('mentions <system-reminder> without closing it'),
			t.thinking('THINKING-SENTINEL'),
			t.tool('t1', 'Read', { file_path: '/TOOL-INPUT-SENTINEL' }),
			t.result('t1', 'TOOL-OUTPUT-SENTINEL'),
			t.assistant({ type: 'thinking', thinking: 'THINKING-SENTINEL' }, { type: 'text', text: 'visible answer' }),
			t.title('first title'),
			t.title('latest title'))
		captureFile(db, session(), { sessionId: 'session-1' })
		assert.deepEqual(messages(db).map((m) => m.text), ['real words', 'mentions <system-reminder> without closing it', 'visible answer'])
		const all = JSON.stringify(db.prepare('SELECT * FROM messages').all()) + JSON.stringify(db.prepare('SELECT * FROM session_files').all())
		for (const s of ['REMINDER-SENTINEL', 'THINKING-SENTINEL', 'TOOL-INPUT-SENTINEL', 'TOOL-OUTPUT-SENTINEL']) assert.ok(!all.includes(s), s)
		assert.equal(sessionRow(db).title, 'latest title')
		assert.equal(sessionRow(db).prompts, 2)
		assert.equal(sessionRow(db).answers, 1)
	})
})

test('text blocks in a user row and an assistant row each get their own block number', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		writeSession(session(),
			t.user([{ type: 'text', text: 'one' }, { type: 'image', source: {} }, { type: 'text', text: 'two' }]),
			t.assistant({ type: 'text', text: 'three' }, { type: 'text', text: 'four' }))
		captureFile(db, session(), { sessionId: 'session-1' })
		assert.deepEqual(db.prepare('SELECT block, text FROM messages ORDER BY id').all().map((m) => [m.block, m.text]), [[0, 'one'], [2, 'two'], [0, 'three'], [1, 'four']])
	})
})

// ── session facts ───────────────────────────────────────────────────────────

test('facts: edited paths, also from a subagent; subagent text has agent_id; ticket from the branch; session id from the file name', () => {
	withDb(({ db, session }) => {
		const t = transcript({ branch: 'fix/pay-2433-x', cwd: '/tmp/app' })
		const main = writeSession(session(),
			t.user('go'),
			t.tool('e1', 'Edit', { file_path: '/tmp/app/a.ts' }),
			t.tool('e2', 'Write', { file_path: '/tmp/app/b.ts' }),
			t.tool('e3', 'NotebookEdit', { notebook_path: '/tmp/app/c.ipynb' }),
			t.tool('e4', 'Edit', { file_path: '/tmp/app/a.ts' }))
		const sub = transcript({ sessionId: 'session-1', branch: 'other-branch', cwd: '/elsewhere' })
		writeSession(join(main.replace(/\.jsonl$/, ''), 'subagents', 'agent-abc.jsonl'),
			sub.user('do the thing'),
			sub.tool('e5', 'Edit', { file_path: '/tmp/app/from-subagent.ts' }),
			sub.answer('did the thing'))
		const summary = captureSession(db, { sessionId: 'session-1', transcriptPath: main })
		assert.equal(summary.files, 2)
		assert.deepEqual(db.prepare('SELECT path FROM session_files ORDER BY path').all().map((r) => r.path), ['/tmp/app/a.ts', '/tmp/app/b.ts', '/tmp/app/c.ipynb', '/tmp/app/from-subagent.ts'])
		const row = sessionRow(db)
		assert.equal(row.ticket, 'PAY-2433')
		assert.equal(row.branch, 'fix/pay-2433-x', 'a subagent does not change the session')
		assert.equal(row.cwd, '/tmp/app')
		assert.equal(row.entrypoint, 'cli')
		assert.equal(row.prompts, 1, 'a subagent prompt is not a prompt of the session')
		assert.equal(row.answers, 0)
		assert.deepEqual(messages(db).filter((m) => m.agent_id).map((m) => [m.agent_id, m.role]), [['abc', 'prompt'], ['abc', 'answer']])
	})
})

test('a session keeps its last ticket after moving to a branch without one', () => {
	withDb(({ db, session }) => {
		const a = transcript({ branch: 'fix/pay-2433-x' })
		const b = transcript({ branch: 'main' })
		writeSession(session(), a.user('one'), b.user('two'))
		captureFile(db, session(), { sessionId: 'session-1' })
		assert.equal(sessionRow(db).ticket, 'PAY-2433')
		assert.equal(sessionRow(db).branch, 'main')
	})
})

test('duration honours the 20-minute gap and drops a burst under a minute, also across runs; started and last are kept', () => {
	withDb(({ db, session }) => {
		const t = transcript({ start: 1_000_000_000_000 })
		const path = writeSession(session(), t.user('a'), t.advance(10 * MINUTE).answer('b'), t.advance(10 * MINUTE).answer('c'))
		captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(sessionRow(db).active_ms, 20 * MINUTE)
		appendSession(path, t.advance(21 * MINUTE).user('after a gap'), t.advance(30_000).answer('burst'))
		captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(sessionRow(db).active_ms, 20 * MINUTE, 'a 30 s burst counts for nothing, as in scan-claude')
		appendSession(path, t.advance(5 * MINUTE).answer('longer now'))
		captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(sessionRow(db).active_ms, 25.5 * MINUTE)
		assert.equal(sessionRow(db).started_at, 1_000_000_000_000)
		assert.equal(sessionRow(db).last_event_at, 1_000_000_000_000 + 46.5 * MINUTE)
	})
})

test('the repo key is the common git folder, through a worktree, and survives a folder that is gone', () => {
	withDb(({ db, root, session }) => {
		const repo = tempRepo(root)
		repo.commit('init')
		const tree = join(repo.dir, '.claude', 'worktrees', 'task')
		repo.git('worktree', 'add', '-q', tree, '-b', 'feature/x')
		const a = transcript({ cwd: tree, sessionId: 'in-worktree' })
		captureFile(db, writeSession(session('in-worktree'), a.user('x')), { sessionId: 'in-worktree' })
		const expected = execFileSync('git', ['-C', repo.dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
		assert.equal(sessionRow(db, 'in-worktree').repo, expected)
		const gone = join(root, 'deleted-repo', '.claude', 'worktrees', 'old')
		const b = transcript({ cwd: gone, sessionId: 'gone' })
		captureFile(db, writeSession(session('gone'), b.user('x')), { sessionId: 'gone' })
		assert.equal(sessionRow(db, 'gone').repo, join(root, 'deleted-repo'))
	})
})

// ── commits ─────────────────────────────────────────────────────────────────

test('commits: only what git proves is stored, with git\'s subject and the full sha', () => {
	withDb(({ db, root, session }) => {
		const repo = tempRepo(root)
		const one = repo.commit('first real subject')
		const two = repo.commit('second real subject')
		const t = transcript({ cwd: repo.dir })
		const path = writeSession(session(),
			t.bash('a', 'rtk git commit -m "typed subject"'),
			t.result('a', `ok ${one.slice(0, 7)}`),
			t.bash('b', `git -C "${repo.dir}" commit -m x`),
			t.result('b', [{ type: 'text', text: `[main ${two.slice(0, 7)}] x\n 1 file changed` }]),
			t.bash('c', 'git commit -m y'),
			t.result('c', 'passed'),
			t.bash('d', 'git commit -m z'),
			t.result('d', 'abcdef1234567 is not here'),
			t.bash('e', 'git commit -m err'),
			t.result('e', `[main ${one.slice(0, 7)}] pretend`, true),
			t.bash('f', 'git commit --dry-run'),
			t.result('f', one),
			t.bash('g', 'git log --grep commit'),
			t.result('g', one),
			t.bash('h', 'echo git commit'),
			t.result('h', one))
		captureFile(db, path, { sessionId: 'session-1' })
		assert.deepEqual(db.prepare('SELECT sha, subject FROM session_commits ORDER BY at, sha').all().map((r) => [r.sha, r.subject]).sort(), [[one, 'first real subject'], [two, 'second real subject']].sort())
		assert.equal(sessionRow(db).commit_attempts, 2, '`passed` and a token not in the repo; is_error, --dry-run and other commands are no attempt')
	})
})

test('a commit call and its result in different runs still pair up, and a re-read counts nothing twice', () => {
	withDb(({ db, root, session }) => {
		const repo = tempRepo(root)
		const sha = repo.commit('split across runs')
		const t = transcript({ cwd: repo.dir })
		const path = writeSession(session(), t.bash('a', 'git commit -m x'), t.bash('b', 'git commit -m y'))
		captureFile(db, path, { sessionId: 'session-1' })
		appendSession(path, t.result('a', `[main ${sha.slice(0, 8)}] x`), t.result('b', 'passed'))
		captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(count(db, 'session_commits'), 1)
		assert.equal(sessionRow(db).commit_attempts, 1)
		const copy = `${path}.copy`
		writeFileSync(copy, readFileSync(path))
		renameSync(copy, path) // a new inode: the whole file is read again
		captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(count(db, 'session_commits'), 1)
		assert.equal(sessionRow(db).commit_attempts, 1)
	})
})

test('a commit made after cd, and one from a worktree that is gone, are found', () => {
	withDb(({ db, root, session }) => {
		const repo = tempRepo(root)
		const sha = repo.commit('after cd')
		const t = transcript({ cwd: root })
		const u = transcript({ cwd: join(repo.dir, '.claude', 'worktrees', 'deleted') })
		const path = writeSession(session(),
			t.bash('a', `cd ${repo.dir} && git add x && git commit -m x`),
			t.result('a', `ok ${sha.slice(0, 7)}`),
			u.bash('b', 'git commit -m y'),
			u.result('b', `ok ${sha.slice(0, 9)}`))
		captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(count(db, 'session_commits'), 1)
		assert.equal(sessionRow(db).commit_attempts, 0)
	})
})

// ── offsets and the reader ──────────────────────────────────────────────────

test('running twice gives no duplicates; appending reads only the new bytes', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		const path = writeSession(session(), t.user('one'), t.answer('two'))
		const first = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(first.bytes, statSync(path).size)
		assert.equal(first.rows, 2)
		assert.equal(first.messageLines, 2)
		const again = captureFile(db, path, { sessionId: 'session-1' })
		assert.deepEqual([again.bytes, again.rows], [0, 0])
		const more = lines(t.user('three'))
		appendFileSync(path, more)
		const third = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(third.bytes, Buffer.byteLength(more))
		assert.equal(third.rows, 1)
		assert.equal(count(db, 'messages'), 3)
		assert.equal(sessionRow(db).prompts, 2)
	})
})

test('a half-written last line is not consumed, and is read once finished', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		const path = writeSession(session(), t.user('whole'))
		const complete = statSync(path).size
		const tail = lines(t.user('finished later'))
		appendFileSync(path, tail.slice(0, 20))
		const first = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(first.bytes, complete)
		assert.equal(first.skipped, 0)
		assert.equal(db.prepare('SELECT offset FROM files').get().offset, complete)
		appendFileSync(path, tail.slice(20))
		const second = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(second.rows, 1)
		assert.equal(messages(db).at(-1).text, 'finished later')
	})
})

test('a multi-byte character across the 1 MiB chunk edge survives, and a 2.3 MB line works', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		// Place the Devanagari run so that it straddles byte 1,048,576 at every alignment of its 3-byte characters.
		const head = lines(t.user('x'))
		const marker = 'नमस्ते'.repeat(4)
		const shell = Buffer.byteLength(lines(t.user('')))
		for (const pad of [0, 1, 2]) {
			const filler = 'a'.repeat(1024 * 1024 - Buffer.byteLength(head) - shell - 30 + pad)
			const path = session(`edge-${pad}`)
			mkdirSync(dirname(path), { recursive: true })
			const fresh = transcript({ sessionId: `edge-${pad}` })
			writeFileSync(path, head + lines(fresh.user(filler + marker)))
			captureFile(db, path, { sessionId: `edge-${pad}` })
			const stored = db.prepare('SELECT text FROM messages WHERE session_id = ? ORDER BY length(text) DESC').get(`edge-${pad}`).text
			assert.ok(stored.endsWith(marker), `alignment ${pad}`)
			assert.ok(!stored.includes('�'), `alignment ${pad}`)
		}
		const big = transcript({ sessionId: 'big' })
		const text = 'b'.repeat(2_300_000)
		const path = writeSession(session('big'), big.user(text), big.answer('after'))
		const r = captureFile(db, path, { sessionId: 'big' })
		assert.equal(r.rows, 2)
		assert.equal(db.prepare("SELECT length(text) AS n FROM messages WHERE session_id = 'big' AND role = 'prompt'").get().n, 2_300_000)
	})
})

test('a bad line is skipped, counted, and does not stop the file; a line over 32 MiB too', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		const path = writeSession(session(), t.user('before'))
		appendFileSync(path, '{"type":"user", nope\n[1,2]\n\n')
		appendFileSync(path, lines(t.user('between')))
		appendFileSync(path, `${'z'.repeat(33 * 1024 * 1024)}\n`)
		appendFileSync(path, lines(t.user('after')))
		const r = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(r.skipped, 3)
		assert.equal(r.bytes, statSync(path).size)
		assert.deepEqual(messages(db).map((m) => m.text), ['before', 'between', 'after'])
		assert.ok(db.prepare("SELECT detail FROM capture_log WHERE kind = 'bad_lines'").get())
	})
})

test('many rows are written in several transactions, none over the row limit', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		const rows = []
		for (let i = 0; i < 4500; i++) rows.push(t.user(`row ${i}`))
		const path = writeSession(session(), ...rows)
		const r = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(r.rows, 4500)
		assert.ok(r.batches >= 3, `batches ${r.batches}`)
	})
})

test('truncation, a same-size rewrite and a new inode each reset the offset with no duplicates', () => {
	withDb(({ db, root, session }) => {
		const t = transcript()
		const path = writeSession(session(), t.user('alpha'), t.user('bravo'), t.user('charl'))
		captureFile(db, path, { sessionId: 'session-1' })
		const original = readFileSync(path, 'utf8')

		// Shrunk: the first line only, plus a new row.
		const keep = original.split('\n')[0]
		writeFileSync(path, `${keep}\n`)
		let r = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(r.reset, 'shrank')
		assert.equal(r.rows, 0)
		appendFileSync(path, lines(t.user('delta')))
		r = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(r.rows, 1)
		assert.equal(count(db, 'messages'), 4)

		// Same size, same inode, other bytes.
		const size = statSync(path).size
		const inode = statSync(path).ino
		const sameSize = readFileSync(path, 'utf8').replace(/"session-1-(\d+)"/g, '"session-x-$1"')
		assert.equal(Buffer.byteLength(sameSize), size)
		writeFileSync(path, sameSize)
		assert.equal(statSync(path).ino, inode)
		r = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(r.reset, 'rewritten')
		assert.equal(r.rows, 2, 'new uuids are new rows; the old ones are not repeated')
		assert.equal(count(db, 'messages'), 6)
		assert.equal(captureFile(db, path, { sessionId: 'session-1' }).reset, null)

		// A new inode with the same content.
		const copy = join(root, 'copy.jsonl')
		writeFileSync(copy, readFileSync(path))
		renameSync(copy, path)
		r = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(r.reset, 'inode')
		assert.equal(r.rows, 0)
		assert.equal(count(db, 'messages'), 6)
		assert.equal(r.bytes, size)
		assert.equal(sessionRow(db).prompts, 6)
		assert.equal(captureFile(db, path, { sessionId: 'session-1' }).bytes, 0)
	})
})

test('a reset rebuilds the duration instead of adding it twice', () => {
	withDb(({ db, root, session }) => {
		const t = transcript({ start: 1_000_000_000_000 })
		const path = writeSession(session(), t.user('a'), t.advance(10 * MINUTE).answer('b'))
		captureFile(db, path, { sessionId: 'session-1' })
		const copy = join(root, 'copy.jsonl')
		writeFileSync(copy, readFileSync(path))
		renameSync(copy, path)
		captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(sessionRow(db).active_ms, 10 * MINUTE)
	})
})

test('deleting the source file keeps its messages, and capturing it again is harmless', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		const path = writeSession(session(), t.user('kept'))
		captureSession(db, { sessionId: 'session-1', transcriptPath: path })
		rmSync(path)
		const r = captureSession(db, { sessionId: 'session-1', transcriptPath: path })
		assert.equal(r.rows, 0)
		assert.equal(messages(db)[0].text, 'kept')
		assert.equal(count(db, 'files'), 1, 'its row stays')
	})
})

test('another tool\'s worker folder is not captured; captureSince takes files changed since then', () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-memory-capture-'))
	const keep = process.env.CLAUDE_HOME
	process.env.CLAUDE_HOME = root
	const db = openMemory(join(root, 'memory', 'memory.db'))
	try {
		const t = transcript({ sessionId: 'a' })
		const old = transcript({ sessionId: 'old' })
		const w = transcript({ sessionId: 'w' })
		writeSession(join(root, 'projects', '-tmp-app', 'a.jsonl'), t.user('recent'))
		const oldPath = writeSession(join(root, 'projects', '-tmp-app', 'old.jsonl'), old.user('old'))
		const workerPath = writeSession(join(root, 'projects', '-x--claude-mem-observer-sessions', 'w.jsonl'), w.user('worker'))
		execFileSync('touch', ['-t', '202001010000', oldPath])
		const summary = captureSince(db, Date.UTC(2021, 0, 1))
		assert.equal(summary.sessions, 1)
		assert.deepEqual(messages(db).map((m) => m.text), ['recent'])
		const direct = captureSession(db, { sessionId: 'w', transcriptPath: workerPath })
		assert.equal(direct.excluded, true)
		assert.equal(count(db, 'messages'), 1)
	} finally {
		db.close()
		keep === undefined ? delete process.env.CLAUDE_HOME : (process.env.CLAUDE_HOME = keep)
		rmSync(root, { recursive: true, force: true })
	}
})

// ── masking ─────────────────────────────────────────────────────────────────

test('the raw-byte test has a matching sample of every vendor shape', () => {
	assert.equal(VENDOR_SHAPES.length, 12)
	for (const [name, re] of VENDOR_SHAPES) assert.match(VENDOR_SAMPLES[name] ?? '', re, name)
})

test('a planted token of each shape: raw bytes of the database and -wal never hold it, in any field', () => {
	withDb(({ db, root, dbPath, session }) => {
		const repo = tempRepo(root)
		const sentinel = 'PLAINWORDSENTINELQ'
		for (const [name, token] of Object.entries(SHAPES)) {
			const sid = `plant-${name}`
			const t = transcript({ sessionId: sid, cwd: join(repo.dir, 'cwd', token), branch: `fix/${token}` })
			const sha = repo.commit(`subject with ${token} end`)
			const path = writeSession(session(sid),
				t.user(`prompt ${token} ${sentinel}`),
				t.answer(`answer ${token}`),
				t.tool('e1', 'Edit', { file_path: `/tmp/x/${token}/a.ts` }),
				t.title(`title ${token}`),
				t.away(`away ${token}`),
				t.bash('c1', `git -C ${repo.dir} commit -m x`),
				t.result('c1', `[main ${sha.slice(0, 10)}] ${token}`))
			captureFile(db, path, { sessionId: sid })
			assert.equal(db.prepare('SELECT count(*) AS n FROM session_commits WHERE session_id = ?').get(sid).n, 1, `${name}: the commit was really stored`)
		}
		const pem = '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nKcwggSjAgEAAoIBAQC7PEMBODY\n-----END RSA ' + 'PRIVATE KEY-----'
		const urlPassword = 'hunter2' + 'URLPASSWORD'
		const dotEnv = 'DB_PASSWORD=' + 'DOTENVVALUE99\nMY_API_KEY=' + 'DOTENVVALUE88'
		const t = transcript({ sessionId: 'carriers' })
		captureFile(db, writeSession(session('carriers'),
			t.user(`here\n${pem}\nand postgres://admin:${urlPassword}@db.example.com/x\n${dotEnv}`)), { sessionId: 'carriers' })

		const planted = [...Object.values(SHAPES), 'MIIEvQIBADANBgkq', 'KcwggSjAgEAAoIB', urlPassword, 'DOTENVVALUE99', 'DOTENVVALUE88']
		const scan = () => {
			const bytes = rawBytes(dbPath)
			assert.ok(bytes.includes(sentinel), 'the scan can see stored text')
			for (const p of planted) assert.ok(!bytes.includes(p), `raw bytes hold ${p.slice(0, 6)}…`)
		}
		assert.ok(existsSync(`${dbPath}-wal`))
		scan()
		db.exec('PRAGMA wal_checkpoint(PASSIVE)')
		scan()
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
		scan()
	})
})

test('if masking throws, no row is stored and a counter rises; nothing raw reaches the file', () => {
	withDb(({ db, dbPath, session }) => {
		const t = transcript()
		const raw = 'RAWTEXTTHATMUSTNOTLAND'
		const path = writeSession(session(), t.user(`hello ${raw}`), t.answer('fine answer'), t.tool('e', 'Edit', { file_path: `/tmp/${raw}` }), t.title(`title ${raw}`))
		const mask = (text) => {
			if (text.includes(raw)) throw new Error('mask failed')
			return { text, hits: [] }
		}
		const r = captureFile(db, path, { sessionId: 'session-1', mask })
		assert.equal(r.dropped, 3)
		assert.equal(r.bytes, statSync(path).size, 'dropped, not retried for ever')
		assert.deepEqual(messages(db).map((m) => m.text), ['fine answer'])
		assert.equal(count(db, 'session_files'), 0)
		assert.equal(sessionRow(db).title, null)
		assert.ok(db.prepare("SELECT detail FROM capture_log WHERE kind = 'mask_failed'").get().detail.includes('3'))
		assert.ok(!rawBytes(dbPath).includes(raw))
		const everything = writeSession(session('all'), transcript({ sessionId: 'all' }).user('anything'))
		const r2 = captureFile(db, everything, { sessionId: 'all', mask: () => { throw new Error('always') } })
		assert.equal(r2.rows, 0)
		assert.equal(r2.bytes, statSync(everything).size)
		assert.equal(captureFile(db, everything, { sessionId: 'all', mask: () => { throw new Error('always') } }).bytes, 0, 'its offset is stored under a key that holds no text')
	})
})

test('writeBatch masks every string itself, and stores the offset in the same transaction', () => {
	withDb(({ db, dbPath }) => {
		const token = SHAPES.github
		const { rows } = writeBatch(db, {
			session: { id: 's', cwd: `/c/${token}`, repo: `/r/${token}`, branch: `b/${token}`, title: `t ${token}`, entrypoint: 'cli' },
			messages: [{ uuid: 'u', block: 0, role: 'prompt', at: 1, text: `m ${token}` }],
			files: [`/f/${token}`],
			commits: [{ sha: 'a'.repeat(40), subject: `s ${token}`, at: 1 }],
			file: { path: `/p/${token}.jsonl`, sessionId: 's', agentId: null, inode: 1, size: 9, from: 0, offset: 9, tailHash: 'h' },
		})
		assert.equal(rows, 3)
		assert.ok(!rawBytes(dbPath).includes(token))
		assert.equal(db.prepare('SELECT offset FROM files').get().offset, 9)
		assert.ok(db.prepare('SELECT text FROM messages').get().text.includes('[masked:'))
	})
})

test('a commit sha that is not hex is refused, not stored', () => {
	withDb(({ db }) => {
		writeBatch(db, { session: { id: 's' }, commits: [{ sha: 'not-a-sha', subject: 'x', at: 1 }] })
		assert.equal(count(db, 'session_commits'), 0)
	})
})

// ── the database ────────────────────────────────────────────────────────────

test('the file and folder modes, WAL, schema version 1, all tables; opening twice changes nothing', () => {
	withDb(({ db, dbPath }) => {
		assert.equal(statSync(dbPath).mode & 0o777, 0o600)
		assert.equal(statSync(dirname(dbPath)).mode & 0o777, 0o700)
		assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
		assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1')
		const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
		for (const t of ['meta', 'files', 'sessions', 'messages', 'session_files', 'session_commits', 'summaries', 'archive', 'import_state', 'capture_log', 'messages_fts', 'archive_fts']) assert.ok(names.includes(t), t)
		for (const [table, columns] of Object.entries({
			files: ['path', 'session_id', 'inode', 'size', 'offset', 'tail_hash'],
			sessions: ['id', 'repo', 'cwd', 'branch', 'ticket', 'title', 'entrypoint', 'started_at', 'last_event_at', 'active_ms', 'prompts', 'answers', 'commit_attempts'],
			messages: ['id', 'session_id', 'uuid', 'block', 'role', 'at', 'agent_id', 'text'],
			session_files: ['session_id', 'path'],
			session_commits: ['session_id', 'sha', 'subject', 'at'],
			summaries: ['session_id', 'at', 'text', 'next'],
			archive: ['id', 'source_table', 'source_id', 'session_id', 'project', 'type', 'title', 'text', 'at', 'promoted_entry', 'promoted_at'],
			capture_log: ['at', 'kind', 'session_id', 'detail'],
		})) {
			const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
			for (const c of columns) assert.ok(have.includes(c), `${table}.${c}`)
		}
		for (const fts of ['messages_fts', 'archive_fts']) {
			const sql = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(fts).sql
			assert.ok(sql.includes(`tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co Mn Mc'"`), fts)
		}
		const again = openMemory(dbPath)
		assert.equal(again.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1')
		again.close()
	})
})

test('the -wal file holds the database file\'s mode', () => {
	withDb(({ db, dbPath, session }) => {
		captureFile(db, writeSession(session(), transcript().user('x')), { sessionId: 'session-1' })
		assert.equal(statSync(`${dbPath}-wal`).mode & 0o777, 0o600)
	})
})

test('a newer schema is refused, and a corrupt file is left alone byte for byte', () => {
	withDb(({ db, root, dbPath }) => {
		db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run()
		assert.throws(() => openMemory(dbPath), (e) => e.code === 'ERR_MEMORY_SCHEMA_NEWER')
		const bad = join(root, 'corrupt', 'memory.db')
		mkdirSync(dirname(bad))
		const junk = Buffer.alloc(8192, 0x5a)
		writeFileSync(bad, junk)
		assert.throws(() => openMemory(bad))
		assert.ok(readFileSync(bad).equals(junk))
	})
})

test('readOnly reads and cannot write; a missing file is an error and is not created', () => {
	withDb(({ root, dbPath, db, session }) => {
		captureFile(db, writeSession(session(), transcript().user('x')), { sessionId: 'session-1' })
		const ro = openMemory(dbPath, { readOnly: true })
		assert.equal(count(ro, 'messages'), 1)
		assert.throws(() => ro.exec("INSERT INTO meta VALUES ('a', 'b')"))
		ro.close()
		const missing = join(root, 'nope', 'memory.db')
		assert.throws(() => openMemory(missing, { readOnly: true }))
		assert.equal(existsSync(missing), false)
		assert.equal(existsSync(dirname(missing)), false)
	})
})

test('full text: whole Devanagari words and prefixes, and the index stays in step', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		captureFile(db, writeSession(session(), t.user('आमचे मंडळ छान आहे'), t.answer('plain english zebra')), { sessionId: 'session-1' })
		const find = (q) => db.prepare('SELECT m.text FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ?').all(q).map((r) => r.text)
		assert.equal(find('"मंडळ"').length, 1)
		assert.equal(find('"मंड"*').length, 1)
		assert.equal(find('zebra').length, 1)
		db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')")
		db.exec("INSERT INTO archive (source_table, source_id, title, text) VALUES ('t', 1, 'मंडळ title', 'archived otter')")
		assert.equal(db.prepare("SELECT count(*) AS n FROM archive_fts WHERE archive_fts MATCH 'otter'").get().n, 1)
		assert.equal(find('otter').length, 0, 'the archive stays apart')
		db.exec("INSERT INTO archive_fts(archive_fts) VALUES ('integrity-check')")
	})
})

test('the database module loads no secret shapes until asked, so the hook can open it; writing without the mask refuses', () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-memory-capture-'))
	try {
		const script = `
			import { registerHooks } from 'node:module'
			const seen = []
			registerHooks({ load(url, ctx, next) { seen.push(url); return next(url, ctx) } })
			const { openMemory, writeBatch } = await import(${JSON.stringify(join(HERE, 'memory-db.mjs'))})
			const db = openMemory(${JSON.stringify(join(root, 'm', 'memory.db'))})
			let refused = false
			try { writeBatch(db, { messages: [{ uuid: 'u', block: 0, role: 'prompt', session: 's', text: 'RAWRAW' }] }) } catch { refused = true }
			const rows = db.prepare('SELECT count(*) AS n FROM messages').get().n
			db.close()
			console.log(JSON.stringify({ refused, rows, seen: seen.filter((u) => /bridge|wp-brain|memory-mask|library/.test(u)) }))
		`
		const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
		assert.equal(r.status, 0, r.stderr)
		assert.deepEqual(JSON.parse(r.stdout.trim()), { refused: true, rows: 0, seen: [] })
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

// ── concurrency ─────────────────────────────────────────────────────────────

const workerEnv = (root, more = {}) => ({ ...process.env, CLAUDE_HOME: join(root, 'claude'), WP_MEMORY_DB: join(root, 'memory', 'memory.db'), WP_BRAIN_SESSIONS: join(root, 'sessions'), ...more })
const status = (root) => JSON.parse(readFileSync(join(root, 'memory', 'status.json'), 'utf8'))

test('two workers on one file at once give no duplicates and no busy error', async () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-memory-capture-'))
	try {
		const t = transcript()
		const rows = []
		for (let i = 0; i < 3000; i++) rows.push(i % 2 ? t.answer(`answer ${i}`) : t.user(`prompt ${i}`))
		const path = writeSession(join(root, 'claude', 'projects', '-tmp-app', 'session-1.jsonl'), ...rows)
		const run = () => new Promise((resolve) => {
			const p = spawn(process.execPath, [WORKER, '--session', 'session-1', '--transcript', path], { env: workerEnv(root), stdio: 'ignore' })
			p.on('close', resolve)
		})
		assert.deepEqual(await Promise.all([run(), run()]), [0, 0])
		const db = openMemory(join(root, 'memory', 'memory.db'))
		await run() // whichever stopped early, a next run finishes
		assert.equal(count(db, 'messages'), 3000)
		assert.equal(db.prepare('SELECT count(*) AS n FROM (SELECT uuid FROM messages GROUP BY uuid, block HAVING count(*) > 1)').get().n, 0)
		assert.equal(sessionRow(db).prompts, 1500)
		assert.equal(db.prepare('SELECT offset FROM files').get().offset, statSync(path).size)
		db.close()
		assert.equal(status(root).lastError, undefined)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('a busy database leaves the offset alone, no throw, and the next run catches up', () => {
	withDb(({ db, dbPath, session }) => {
		db.exec('PRAGMA busy_timeout = 10')
		const other = openMemory(dbPath)
		const path = writeSession(session(), transcript().user('waits'))
		other.exec('BEGIN IMMEDIATE')
		const r = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(r.busy, true)
		assert.equal(r.bytes, 0)
		other.exec('COMMIT')
		other.close()
		assert.equal(count(db, 'files'), 0)
		const next = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(next.rows, 1)
	})
})

test('a worker that read stale bytes loses the race cleanly: the conditional offset update refuses it', () => {
	withDb(({ db }) => {
		const file = { path: '/p.jsonl', sessionId: 's', agentId: null, inode: 1, size: 5, from: 0, offset: 5, tailHash: 'a' }
		assert.equal(writeBatch(db, { file }).stale, undefined)
		const late = writeBatch(db, { file: { ...file, offset: 3 }, messages: [{ uuid: 'u', block: 0, role: 'prompt', at: 1, text: 'late' }], session: { id: 's' } })
		assert.equal(late.stale, true)
		assert.equal(db.prepare('SELECT offset FROM files').get().offset, 5)
		assert.equal(count(db, 'messages'), 0)
	})
})

// ── the worker ──────────────────────────────────────────────────────────────

test('worker: status.json has counts and codes only, the session mark is refreshed, and nothing is written without work', () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-memory-capture-'))
	try {
		const repo = tempRepo(root)
		const sha = repo.commit('marked commit')
		const t = transcript({ cwd: repo.dir, entrypoint: 'cli' })
		const secretish = 'SENTINELPROMPTWORDS'
		const path = writeSession(join(root, 'claude', 'projects', '-tmp-app', 'session-1.jsonl'),
			t.user(`hello ${secretish}`),
			t.user('again'),
			t.tool('e1', 'Edit', { file_path: `${repo.dir}/a.ts` }),
			t.tool('e2', 'Write', { file_path: `${repo.dir}/b.ts` }),
			t.bash('c', 'git commit -m x'),
			t.result('c', `ok ${sha.slice(0, 7)}`))
		const idle = spawnSync(process.execPath, [WORKER], { env: workerEnv(root), encoding: 'utf8' })
		assert.equal(idle.status, 0)
		assert.equal(existsSync(join(root, 'memory', 'memory.db')), false, 'no arguments, no work')

		const r = spawnSync(process.execPath, [WORKER, '--session', 'session-1', '--transcript', path], { env: workerEnv(root), encoding: 'utf8' })
		assert.equal(r.status, 0, r.stderr)
		assert.equal(r.stdout, '')
		const s = status(root)
		assert.ok(s.lastWriteAt > 0)
		assert.equal(s.lastRun.rows > 0, true)
		assert.equal(s.lastRun.files, 1)
		assert.equal(s.lastError, undefined)
		assert.equal(s.drift, null)
		assert.ok(!JSON.stringify(s).includes(secretish))
		assert.equal(statSync(join(root, 'memory', 'status.json')).mode & 0o777, 0o600)
		assert.deepEqual(JSON.parse(readFileSync(join(root, 'sessions', 'session-1.memory.json'), 'utf8')), { prompts: 2, edits: 2, commits: 1, entrypoint: 'cli' })
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('worker: --since sweeps; a bad session id writes no mark outside the folder; an unusable database exits 0 with a code', () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-memory-capture-'))
	try {
		const t = transcript({ sessionId: 'swept' })
		const path = writeSession(join(root, 'claude', 'projects', '-tmp-app', 'swept.jsonl'), t.user('found by sweep'))
		const r = spawnSync(process.execPath, [WORKER, '--since', '0'], { env: workerEnv(root), encoding: 'utf8' })
		assert.equal(r.status, 0, r.stderr)
		assert.equal(status(root).lastRun.sessions, 1)
		assert.ok(existsSync(join(root, 'sessions', 'swept.memory.json')))

		const u = spawnSync(process.execPath, [WORKER, '--session', '../../escape', '--transcript', path], { env: workerEnv(root), encoding: 'utf8' })
		assert.equal(u.status, 0, u.stderr)
		assert.equal(existsSync(join(root, 'escape.memory.json')), false)

		const nonsense = spawnSync(process.execPath, [WORKER, '--since', 'soon'], { env: workerEnv(root), encoding: 'utf8' })
		assert.equal(nonsense.status, 0)
		assert.equal(status(root).lastError.code, 'BAD_ARGS')

		const badRoot = join(root, 'bad')
		mkdirSync(badRoot)
		const junk = Buffer.alloc(8192, 0x5a)
		const bad = join(badRoot, 'memory.db')
		writeFileSync(bad, junk)
		const c = spawnSync(process.execPath, [WORKER, '--session', 'swept', '--transcript', path], { env: workerEnv(root, { WP_MEMORY_DB: bad }), encoding: 'utf8' })
		assert.equal(c.status, 0, c.stderr)
		const st = JSON.parse(readFileSync(join(badRoot, 'status.json'), 'utf8'))
		assert.ok(st.lastError.at > 0)
		assert.match(st.lastError.code, /^[A-Z_0-9]+$/)
		assert.ok(readFileSync(bad).equals(junk), 'never recreated')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

// ── format drift ────────────────────────────────────────────────────────────

test('drift: assistant lines with no parsable text set it, across small runs; tool-only runs do not; new text clears it', () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-memory-capture-'))
	try {
		const projects = join(root, 'claude', 'projects', '-tmp-app')
		const t = transcript()
		const changed = () => ({ ...t.answer('x'), message: { role: 'assistant', parts: ['the format moved'] } })
		const run = (path) => spawnSync(process.execPath, [WORKER, '--session', 'session-1', '--transcript', path], { env: workerEnv(root), encoding: 'utf8' })

		const tools = []
		for (let i = 0; i < 30; i++) tools.push(t.tool(`t${i}`, 'Read', { file_path: '/x' }))
		const path = writeSession(join(projects, 'session-1.jsonl'), t.user('start'), ...tools)
		run(path)
		assert.equal(status(root).drift, null, 'a long run of tools is normal')

		// Twenty changed lines, arriving a few at a time, as a Stop hook would read them.
		for (let i = 0; i < 4; i++) {
			appendSession(path, changed(), changed(), changed(), changed(), changed())
			run(path)
		}
		const s = status(root)
		assert.ok(s.drift)
		assert.equal(s.drift.code, 'no_text')
		assert.ok(s.drift.at > 0)

		appendSession(path, t.answer('text again'))
		run(path)
		assert.equal(status(root).drift, null)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('drift: lines of an unknown kind with no message between them set it; bookkeeping does not', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		const rows = []
		for (let i = 0; i < 500; i++) rows.push(t.bookkeeping('attachment'))
		const quiet = writeSession(session(), t.user('x'), ...rows)
		assert.equal(captureFile(db, quiet, { sessionId: 'session-1' }).drift, null)
		const other = transcript({ sessionId: 'moved' })
		const moved = []
		for (let i = 0; i < 60; i++) moved.push({ ...other.user('x'), type: 'human_turn_v2' })
		const r = captureFile(db, writeSession(session('moved'), ...moved), { sessionId: 'moved' })
		assert.equal(r.drift, 'unknown_rows')
	})
})

// ── fix round 1 ─────────────────────────────────────────────────────────────

test('a line with fields of the wrong type never stops the file: strings are kept, a throwing line is skipped and counted', () => {
	withDb(({ db, session }) => {
		const t = transcript({ branch: 'fix/pay-2433-x', cwd: '/tmp/app' })
		const poison = [
			{ ...t.user('wrong branch'), gitBranch: 7 },
			{ ...t.user('wrong cwd'), cwd: { a: 1 } },
			{ ...t.user('wrong entrypoint'), entrypoint: ['x'] },
			{ ...t.user('wrong uuid'), uuid: 12 },
			{ ...t.tool(99, 'Edit', { file_path: 5 }) },
			t.assistant({ type: 'tool_use', id: 99, name: 'Bash', input: { command: 'git commit -m x' } }),
			t.result(99, 'passed'),
			{ ...t.user('x'), message: 5 },
			{ ...t.user('x'), message: { content: [null, 7, 'text'] } },
		]
		const throwing = [
			{ ...t.user('throws in Date.parse'), timestamp: { toString: 1 } },
			{ ...t.user('x'), type: { toString: 1 } },
		]
		const path = writeSession(session(), t.user('good before'), ...poison, ...throwing, t.user('good after'))
		const r = captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(r.bytes, statSync(path).size)
		assert.equal(r.skipped, 1, 'only the Date.parse line throws; an unknown type is not a bad line')
		const texts = messages(db).map((m) => m.text)
		for (const want of ['good before', 'wrong branch', 'wrong cwd', 'wrong entrypoint', 'wrong uuid', 'good after']) assert.ok(texts.includes(want), want)
		const row = sessionRow(db)
		assert.equal(row.branch, 'fix/pay-2433-x')
		assert.equal(row.cwd, '/tmp/app')
		assert.equal(row.entrypoint, 'cli')
		assert.equal(captureFile(db, path, { sessionId: 'session-1' }).bytes, 0)
	})
})

test('worker: a poison line costs no status error, and the good line before it is kept', () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-memory-capture-'))
	try {
		const t = transcript()
		const path = writeSession(join(root, 'claude', 'projects', '-tmp-app', 'session-1.jsonl'), t.user('good'), { ...t.user('poison'), gitBranch: 7 }, t.user('later'))
		const r = spawnSync(process.execPath, [WORKER, '--session', 'session-1', '--transcript', path], { env: workerEnv(root), encoding: 'utf8' })
		assert.equal(r.status, 0, r.stderr)
		assert.equal(status(root).lastError, undefined)
		const db = openMemory(join(root, 'memory', 'memory.db'))
		assert.equal(count(db, 'messages'), 3)
		db.close()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('drift: a text block whose text field moved counts; a real empty text does not', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		const rows = []
		for (let i = 0; i < 20; i++) rows.push(t.assistant({ type: 'text', value: 'the field moved' }))
		const r = captureFile(db, writeSession(session(), ...rows), { sessionId: 'session-1' })
		assert.equal(r.rows, 0)
		assert.equal(r.drift, 'no_text')
		const u = transcript({ sessionId: 'empty' })
		const fine = []
		for (let i = 0; i < 30; i++) fine.push(u.assistant({ type: 'text', text: '' }))
		assert.equal(captureFile(db, writeSession(session('empty'), ...fine), { sessionId: 'empty' }).drift, null)
	})
})

test('drift: user rows with no recognised content count, even while answers still parse; tool results and images do not', () => {
	withDb(({ db, session }) => {
		const t = transcript()
		const rows = []
		for (let i = 0; i < 20; i++) rows.push({ ...t.user('x'), message: { role: 'user', parts: ['prompts moved'] } }, t.answer(`answer ${i}`))
		const r = captureFile(db, writeSession(session(), ...rows), { sessionId: 'session-1' })
		assert.equal(r.drift, 'no_text')
		assert.equal(sessionRow(db).prompts, 0)

		const a = transcript({ sessionId: 'moved-field' })
		const moved = []
		for (let i = 0; i < 20; i++) moved.push(a.user([{ type: 'text', value: 'moved' }]), a.result(`r${i}`, 'ok'))
		assert.equal(captureFile(db, writeSession(session('moved-field'), ...moved), { sessionId: 'moved-field' }).drift, 'no_text', 'tool results between them do not clear it')

		const b = transcript({ sessionId: 'normal' })
		const normal = []
		for (let i = 0; i < 40; i++) normal.push(b.result(`n${i}`, 'ok'), b.user([{ type: 'image', source: {} }]))
		assert.equal(captureFile(db, writeSession(session('normal'), ...normal), { sessionId: 'normal' }).drift, null)

		// Across runs, and a real prompt clears it.
		const c = transcript({ sessionId: 'runs' })
		const path = writeSession(session('runs'), c.user('start'))
		for (let i = 0; i < 4; i++) {
			appendSession(path, ...Array.from({ length: 5 }, () => ({ ...c.user('x'), message: { parts: [] } })))
			captureFile(db, path, { sessionId: 'runs' })
		}
		appendSession(path, { ...c.user('x'), message: { parts: [] } })
		assert.equal(captureFile(db, path, { sessionId: 'runs' }).drift, 'no_text')
		appendSession(path, c.user('words again'))
		assert.equal(captureFile(db, path, { sessionId: 'runs' }).drift, null)
	})
})

test('worker: a mask that will not load is reported as a code before any database is opened; nothing is stored', () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-memory-capture-'))
	try {
		const hook = join(root, 'no-mask.mjs')
		writeFileSync(hook, `import { registerHooks } from 'node:module'
registerHooks({ load(url, ctx, next) { if (url.includes('memory-mask')) throw new Error('cannot load'); return next(url, ctx) } })\n`)
		const t = transcript()
		const path = writeSession(join(root, 'claude', 'projects', '-tmp-app', 'session-1.jsonl'), t.user('never stored'))
		const r = spawnSync(process.execPath, ['--import', hook, WORKER, '--session', 'session-1', '--transcript', path], { env: workerEnv(root), encoding: 'utf8' })
		assert.equal(r.status, 0, r.stderr)
		assert.equal(r.stderr, '')
		assert.equal(status(root).lastError.code, 'MASK_UNAVAILABLE')
		assert.equal(existsSync(join(root, 'memory', 'memory.db')), false)

		const script = `
			const { captureFile } = await import(${JSON.stringify(WORKER)})
			try { captureFile({}, ${JSON.stringify(path)}, { sessionId: 'session-1' }); console.log('no refusal') } catch (e) { console.log(e.code) }
		`
		const direct = spawnSync(process.execPath, ['--import', hook, '--input-type=module', '-e', script], { env: workerEnv(root), encoding: 'utf8' })
		assert.equal(direct.stdout.trim(), 'MASK_UNAVAILABLE', direct.stderr)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('prompts and answers count rows, not text blocks, also when a line is read again', () => {
	withDb(({ db, root, session }) => {
		const t = transcript()
		const path = writeSession(session(),
			t.user([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'text', text: 'three' }]),
			t.assistant({ type: 'text', text: 'four' }, { type: 'text', text: 'five' }))
		captureFile(db, path, { sessionId: 'session-1' })
		assert.deepEqual([sessionRow(db).prompts, sessionRow(db).answers, count(db, 'messages')], [1, 1, 5])
		const copy = join(root, 'copy.jsonl')
		writeFileSync(copy, readFileSync(path))
		renameSync(copy, path)
		captureFile(db, path, { sessionId: 'session-1' })
		assert.deepEqual([sessionRow(db).prompts, sessionRow(db).answers], [1, 1])
	})
})

test('a commit older than its call by over 5 minutes proves nothing; another token in the same result still can', () => {
	withDb(({ db, root, session }) => {
		const repo = tempRepo(root)
		const now = Date.now()
		const backdated = (subject, ms) => {
			const date = `${Math.floor(ms / 1000)} +0000`
			execFileSync('git', ['-C', repo.dir, 'commit', '-q', '--allow-empty', '-m', subject], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } })
			return repo.git('rev-parse', 'HEAD')
		}
		const old = backdated('from last week', now - 7 * 24 * 60 * MINUTE)
		const justBefore = backdated('just before the call', now - 4 * MINUTE)
		const t = transcript({ cwd: repo.dir, start: now })
		const path = writeSession(session(),
			t.bash('a', 'git commit -m x; git log --oneline -1'),
			t.result('a', `${old.slice(0, 7)} from last week`),
			t.bash('b', 'git commit -m y'),
			t.result('b', `${old.slice(0, 7)} then ${justBefore.slice(0, 7)}`))
		captureFile(db, path, { sessionId: 'session-1' })
		assert.deepEqual(db.prepare('SELECT sha FROM session_commits').all().map((r) => r.sha), [justBefore])
		assert.equal(sessionRow(db).commit_attempts, 1)
	})
})

test('the call time survives a run: its result in the next run is still checked against it', () => {
	withDb(({ db, root, session }) => {
		const repo = tempRepo(root)
		const now = Date.now()
		const date = `${Math.floor((now - 60 * MINUTE) / 1000)} +0000`
		execFileSync('git', ['-C', repo.dir, 'commit', '-q', '--allow-empty', '-m', 'old'], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } })
		const old = repo.git('rev-parse', 'HEAD')
		const t = transcript({ cwd: repo.dir, start: now })
		const path = writeSession(session(), t.bash('a', 'git commit -m x'))
		captureFile(db, path, { sessionId: 'session-1' })
		appendSession(path, t.result('a', `ok ${old.slice(0, 7)}`))
		captureFile(db, path, { sessionId: 'session-1' })
		assert.equal(count(db, 'session_commits'), 0)
		assert.equal(sessionRow(db).commit_attempts, 1)
	})
})

test('capture_log kind and detail go through the mask too', () => {
	withDb(({ db, dbPath }) => {
		const token = SHAPES.github
		writeBatch(db, { session: { id: 's' }, log: [{ kind: `k ${token}`, detail: `d ${token}` }] })
		assert.ok(!rawBytes(dbPath).includes(token))
		const row = db.prepare('SELECT kind, detail FROM capture_log').get()
		assert.ok(row.kind.includes('[masked:') && row.detail.includes('[masked:'))
	})
})

test('a busy session stops at the file that was busy, so subagents do not each wait out the timeout', () => {
	withDb(({ db, dbPath, session }) => {
		db.exec('PRAGMA busy_timeout = 10')
		const t = transcript()
		const main = writeSession(session(), t.user('main'))
		for (const id of ['a', 'b', 'c']) {
			const s = transcript()
			writeSession(join(main.replace(/\.jsonl$/, ''), 'subagents', `agent-${id}.jsonl`), s.user(id))
		}
		const other = openMemory(dbPath)
		other.exec('BEGIN IMMEDIATE')
		const r = captureSession(db, { sessionId: 'session-1', transcriptPath: main })
		other.exec('COMMIT')
		other.close()
		assert.equal(r.busy, true)
		assert.equal(r.files, 1)
		assert.equal(captureSession(db, { sessionId: 'session-1', transcriptPath: main }).files, 4)
		assert.equal(count(db, 'messages'), 4)
	})
})

// ── search, show and backfill ───────────────────────────────────────────────

const SEARCH_DAY = Date.UTC(2026, 9, 1, 9)

/** Two repos' sessions with prompts, answers and a subagent's text, all synthetic. */
function seeded(db, session) {
	const a = transcript({ sessionId: 'session-a', cwd: '/tmp/alpha', start: SEARCH_DAY })
	const pa = writeSession(session('session-a'), a.user('How do I tune the quokka cache'), a.answer('The quokka cache needs a longer expiry, quokka quokka'), a.advance(MINUTE).turnEnd())
	writeSession(join(pa.replace(/\.jsonl$/, ''), 'subagents', 'agent-x.jsonl'), a.user('Subagent only word: platypus'))
	const b = transcript({ sessionId: 'session-b', cwd: '/tmp/beta', start: SEARCH_DAY + 40 * 86_400_000 })
	const pb = writeSession(session('session-b'), b.user('Fix the wombat bug'), b.answer('Replaced the wombat loop; the quokka was fine'))
	captureSession(db, { sessionId: 'session-a', transcriptPath: pa })
	captureSession(db, { sessionId: 'session-b', transcriptPath: pb })
}

test('search finds a word in a prompt and in an answer, ranks by bm25, and filters by each option', () => {
	withDb(({ db, session }) => {
		seeded(db, session)
		const hits = searchMemory(db, 'quokka')
		assert.deepEqual(hits.map((h) => `${h.session_id}:${h.role}`).sort(), ['session-a:answer', 'session-a:prompt', 'session-b:answer'])
		assert.equal(hits[0].session_id, 'session-a', 'the row with the word three times ranks first')
		assert.equal(hits[0].role, 'answer')
		assert.deepEqual(Object.keys(hits[0]).sort(), ['at', 'repo', 'role', 'session_id', 'snippet'])
		assert.equal(searchMemory(db, 'quokka', { role: 'prompt' }).length, 1)
		assert.equal(searchMemory(db, 'quokka', { session: 'session-b' }).length, 1)
		assert.equal(searchMemory(db, 'quokka', { session: 'session-' }).length, 3, 'a prefix, as show takes')
		assert.equal(searchMemory(db, 'quokka', { session: 'session-%' }).length, 0, '% in a session id is literal')
		assert.equal(searchMemory(db, 'quokka', { repo: '%' }).length, 0, '% in a repo name is literal')
		assert.equal(searchMemory(db, 'quokka', { repo: 'alph_' }).length, 0, '_ in a repo name is literal')
		assert.equal(searchMemory(db, 'quokka', { repo: 'ALPHA' }).length, 0, 'case counts')
		assert.equal(searchMemory(db, 'quokka', { repo: '/tmp/beta' })[0].session_id, 'session-b')
		assert.equal(searchMemory(db, 'quokka', { repo: 'alpha' }).length, 2, 'a repo can be named by its folder')
		assert.equal(searchMemory(db, 'quokka', { since: SEARCH_DAY + 20 * 86_400_000 }).length, 1)
		assert.equal(searchMemory(db, 'quokka', { limit: 2 }).length, 2)
		assert.equal(searchMemory(db, 'quokka wombat').length, 1, 'words are all required')
	})
})

test('search leaves subagent text out unless asked, and never searches the injected role', () => {
	withDb(({ db, session }) => {
		seeded(db, session)
		assert.deepEqual(searchMemory(db, 'platypus'), [])
		assert.equal(searchMemory(db, 'platypus', { agents: true }).length, 1)
		const t = transcript({ sessionId: 'session-c' })
		const path = writeSession(session('session-c'), t.user('Injected zebra text', { promptSource: 'system' }), t.user('plain prompt'))
		captureSession(db, { sessionId: 'session-c', transcriptPath: path })
		assert.equal(count(db, 'messages', "role = 'injected'"), 1)
		assert.deepEqual(searchMemory(db, 'zebra'), [])
	})
})

test('a snippet is one line of at most 200 characters, even when the raw match window is not', () => {
	withDb(({ db, session }) => {
		const t = transcript({ sessionId: 'session-long' })
		// One 5,000-character token and newlines sit inside the match window, so the raw snippet is over 5,000 characters with line breaks.
		const text = `needle\n\nline two\n${'x'.repeat(5000)}\nline four`
		captureSession(db, { sessionId: 'session-long', transcriptPath: writeSession(session('session-long'), t.user(text)) })
		const raw = db.prepare("SELECT snippet(messages_fts, 0, '', '', '…', 24) AS s FROM messages_fts WHERE messages_fts MATCH '\"needle\"*'").get().s
		assert.ok(raw.length > 5000 && raw.includes('\n'), 'the test input really does break the cap before it is cut')
		const [hit] = searchMemory(db, 'needle')
		assert.ok([...hit.snippet].length <= 200, `length ${[...hit.snippet].length}`)
		assert.ok(!hit.snippet.includes('\n'))
		assert.ok(hit.snippet.startsWith('needle'))
	})
})

test('odd queries never raise, and a Marathi word is found whole and by prefix', () => {
	withDb(({ db, session }) => {
		const t = transcript({ sessionId: 'session-m' })
		captureSession(db, { sessionId: 'session-m', transcriptPath: writeSession(session('session-m'), t.user('foo-bar baz मंडळ बैठक')) })
		for (const q of ['foo-bar', '"unbalanced', 'AND', 'OR NOT', '*', '', '   ', '(', 'a"b', 'NEAR(', null, undefined, 'foo:bar', '-']) {
			assert.doesNotThrow(() => searchMemory(db, q), JSON.stringify(q))
		}
		assert.equal(ftsQuery('*'), null)
		assert.equal(ftsQuery(''), null)
		assert.equal(searchMemory(db, 'foo-bar').length, 1)
		assert.equal(searchMemory(db, 'मंडळ').length, 1, 'whole word')
		assert.equal(searchMemory(db, 'मंड').length, 1, 'prefix of a word with vowel signs')
		assert.equal(searchMemory(db, 'बैठ').length, 1)
	})
})

test('archive rows never appear in a message search', () => {
	withDb(({ db, session }) => {
		seeded(db, session)
		db.prepare("INSERT INTO archive (source_table, source_id, title, text) VALUES ('observations', '1', 'quokka title', 'quokka archive body')").run()
		assert.equal(count(db, 'archive_fts', "archive_fts MATCH 'quokka'"), 1, 'the archive row is indexed')
		assert.ok(searchMemory(db, 'quokka').every((h) => !h.snippet.includes('archive body')))
		assert.equal(searchMemory(db, 'quokka').length, 3)
	})
})

test('show gives facts and the summary, and the masked text only when asked', () => {
	withDb(({ db, session }) => {
		seeded(db, session)
		writeBatch(db, { summary: { session: 'session-a', at: 1, text: 'Tuned the cache.', next: 'Measure it' } })
		const plain = showSession(db, 'session-a')
		assert.equal(plain.facts.repo, '/tmp/alpha')
		assert.equal(plain.summary, 'Tuned the cache.')
		assert.equal(plain.messages, undefined)
		const full = showSession(db, 'session-a', { text: true })
		assert.deepEqual(full.messages.map((m) => m.role), ['prompt', 'answer'], 'subagent text is not in it')
		assert.equal(showSession(db, 'session-').ambiguous.length, 2)
		assert.equal(showSession(db, 'session-b', { text: false }).facts.id, 'session-b')
		assert.equal(showSession(db, 'nothing-like-it'), null)
	})
})

/** The CLI's sandbox with capture on (or off), its own HOME, a synthetic projects folder and a memory database path that does not exist yet. */
function cliBox(t, { memory = true, config = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'wp-backfill-'))
	const dbPath = join(root, 'memory', 'memory.db')
	const box = brainSandbox({ config: { memory, capture_since: 1, ...config }, env: { HOME: root, WP_MEMORY_DB: dbPath, CLAUDE_CONFIG_DIR: join(root, 'claude-home') } })
	t.after(() => {
		rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
	})
	const projects = join(box.root, 'claude-home', 'projects')
	return { ...box, dbPath, projects, file: (id, project = '-tmp-app') => join(projects, project, `${id}.jsonl`) }
}

/** Synthetic session files: n main files in one project, each with one subagent file, and one in another tool's worker folder. */
function manyFiles(box, n = 5) {
	for (let i = 0; i < n; i++) {
		const id = `old-${i}`
		const t = transcript({ sessionId: id, start: Date.UTC(2026, 8, 1, 9) + i * 3600_000 })
		const main = writeSession(box.file(id), t.user(`question ${i} about topic${i}`), t.answer(`answer ${i}`), t.turnEnd())
		writeSession(join(main.replace(/\.jsonl$/, ''), 'subagents', 'agent-s.jsonl'), t.user(`subagent ${i}`))
		utimesSync(main, new Date(Date.UTC(2026, 8, 1) + i * 3600_000), new Date(Date.UTC(2026, 8, 1) + i * 3600_000))
	}
	const w = transcript({ sessionId: 'worker-1' })
	writeSession(box.file('worker-1', '-tmp--claude-mem-observer-sessions'), w.user('worker text'))
}

test('backfill without --yes writes nothing, not even the database file, and says it reads everything on disk', (t) => {
	const box = cliBox(t)
	manyFiles(box)
	const r = box.run('memory', 'backfill')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /Dry run: 10 session files \(5 main, 5 subagent\)/)
	assert.match(r.out, /MB on disk\. Nothing was written/)
	assert.match(r.out, /everything on disk, including any period capture was off/)
	assert.ok(!existsSync(box.dbPath) && !existsSync(dirname(box.dbPath)), 'no database file, no folder')
	assert.equal(box.run('memory', 'backfill', '--yes').status, 0)
	assert.ok(existsSync(box.dbPath))
})

test('backfill with capture off refuses with one clear line, in a dry run and with --yes', (t) => {
	const box = cliBox(t, { memory: false })
	manyFiles(box)
	for (const args of [['memory', 'backfill'], ['memory', 'backfill', '--yes']]) {
		const r = box.run(...args)
		assert.equal(r.status, 1)
		assert.equal(r.err.trim().split('\n').length, 1)
		assert.match(r.err, /Session memory is off\. Turn it on first with: wp-brain memory on/)
	}
	assert.ok(!existsSync(box.dbPath))
})

test('backfill lists main files first and subagents after, and leaves another tool\'s worker folder out', (t) => {
	const box = cliBox(t)
	manyFiles(box)
	const plan = backfillPlan(box.projects)
	assert.equal(plan.files.length, 10)
	assert.deepEqual(plan.files.map((f) => f.agentId === null), [...Array(5).fill(true), ...Array(5).fill(false)])
	assert.ok(plan.files.every((f) => !f.path.includes('--claude-mem-')))
	assert.equal(plan.bytes, plan.files.reduce((n, f) => n + statSync(f.path).size, 0))
})

test('backfill reads files from before capture began, and old files it filled are never missed', (t) => {
	const box = cliBox(t)
	manyFiles(box)
	const r = box.run('memory', 'backfill', '--yes')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /Backfill done: 10 files/)
	const db = openMemory(box.dbPath)
	try {
		assert.equal(count(db, 'sessions'), 5)
		assert.equal(count(db, 'messages', "role = 'prompt' AND agent_id IS NULL"), 5)
		assert.equal(count(db, 'messages', 'agent_id IS NOT NULL'), 5)
		assert.equal(searchMemory(db, 'topic3').length, 1)
		assert.equal(count(db, 'messages', "text LIKE '%worker text%'"), 0)
		const now = Date.now()
		assert.deepEqual(missedSessions(db, mainTranscripts(box.projects), { now, since: 1 }), [], 'every old file counts as captured through its offset')
	} finally {
		db.close()
	}
	const again = box.run('memory', 'backfill', '--yes')
	assert.match(again.out, /0 rows added/)
})

test('backfill reads files from before capture began and from the weeks it was off, and none is reported missed', (t) => {
	// Every file is older than both bounds: capture began on 20 Oct and was turned on again on 25 Oct, the files are from 1 Sep.
	const since = Date.UTC(2026, 9, 20)
	const resumed = Date.UTC(2026, 9, 25)
	const box = cliBox(t, { config: { capture_since: since, capture_resumed_at: resumed } })
	manyFiles(box)
	assert.ok(mainTranscripts(box.projects).every((f) => f.mtimeMs < since), 'the files are older than capture_since')
	const r = box.run('memory', 'backfill', '--yes')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /Backfill done: 10 files, 15 rows added/)
	const db = openMemory(box.dbPath)
	try {
		assert.equal(count(db, 'sessions'), 5)
		assert.equal(searchMemory(db, 'topic4').length, 1)
		for (const bound of [since, resumed, 1]) {
			assert.deepEqual(missedSessions(db, mainTranscripts(box.projects), { now: Date.now(), since: bound }), [], `since ${bound}`)
		}
	} finally {
		db.close()
	}
})

test('progress prints every 100 files', () => {
	withDb(({ db, root }) => {
		const files = []
		for (let i = 0; i < 205; i++) {
			const t = transcript({ sessionId: `p-${i}` })
			files.push({ path: writeSession(join(root, 'projects', '-p', `p-${i}.jsonl`), t.user(`tiny ${i}`)), sessionId: `p-${i}`, agentId: null, size: 1 })
		}
		const seen = []
		backfill(db, { files, bytes: 0 }, { onProgress: (p) => seen.push(p.done) })
		assert.deepEqual(seen, [100, 200, 205])
	})
})

test('a backfill killed partway and run again has no duplicates and reaches the same counts', (t) => {
	const box = cliBox(t)
	manyFiles(box, 6)
	const script = join(box.root, 'kill-after-three.mjs')
	writeFileSync(script, `import { loadMask, openMemory } from ${JSON.stringify(pathToFileURL(join(HERE, 'memory-db.mjs')).href)}
import { backfill, backfillPlan } from ${JSON.stringify(pathToFileURL(WORKER).href)}
await loadMask()
const db = openMemory(process.env.WP_MEMORY_DB)
backfill(db, backfillPlan(process.argv[2]), { onFile: (f, done) => { if (done === 3) process.kill(process.pid, 'SIGKILL') } })
`)
	const killed = spawnSync(process.execPath, [script, box.projects], { env: { ...process.env, HOME: box.root, WP_MEMORY_DB: box.dbPath }, encoding: 'utf8' })
	assert.equal(killed.signal, 'SIGKILL')
	const partial = openMemory(box.dbPath)
	const seen = count(partial, 'messages')
	partial.close()
	assert.ok(seen > 0 && seen < 18, `killed partway: ${seen} of 18 rows`)
	assert.equal(box.run('memory', 'backfill', '--yes').status, 0)

	const reference = join(box.root, 'reference.db')
	const ref = openMemory(reference)
	try {
		backfill(ref, backfillPlan(box.projects))
	} finally {
		ref.close()
	}
	const rows = (path) => {
		const db = openMemory(path, { readOnly: true })
		try {
			return {
				messages: db.prepare('SELECT uuid, block, role, text, agent_id FROM messages ORDER BY uuid, block').all().map((r) => ({ ...r })),
				sessions: db.prepare('SELECT id, prompts, answers FROM sessions ORDER BY id').all().map((r) => ({ ...r })),
			}
		} finally {
			db.close()
		}
	}
	const got = rows(box.dbPath)
	assert.equal(got.messages.length, 18)
	assert.equal(new Set(got.messages.map((m) => `${m.uuid}:${m.block}`)).size, 18, 'no duplicates')
	assert.deepEqual(got, rows(reference))
})

test('no hook can start a backfill', () => {
	for (const name of ['memory-hook.mjs', 'memory-note.mjs']) assert.ok(!/backfill/i.test(readFileSync(join(HERE, name), 'utf8')), name)
})

test('search, brief, recall and db rebuild never show session text, and a brain.db rebuild leaves memory.db untouched', (t) => {
	const box = cliBox(t)
	const db = openMemory(box.dbPath)
	const s = transcript({ sessionId: 'sentinel-session' })
	const sentinel = 'zzsentinelword'
	captureSession(db, { sessionId: 'sentinel-session', transcriptPath: writeSession(box.file('sentinel-session'), s.user(`please handle ${sentinel} for the quokka lesson`), s.answer(`${sentinel} done`)) })
	assert.equal(searchMemory(db, sentinel).length, 2)
	db.close()
	assert.equal(box.run('add', 'learning', 'Quokka lesson about gloves and patience', '--no-push').status, 0)
	const outputs = [
		box.run('search', sentinel), box.run('search', 'quokka lesson'), box.run('recall', 'please handle the quokka lesson gloves'),
		box.run('brief', 'ABC-1', '--about', 'quokka lesson gloves'), box.run('db', 'rebuild'), box.run('list'), box.run('db', 'status'),
	]
	assert.match(outputs[1].out, /Quokka lesson about gloves/, 'the brain side works')
	outputs.forEach((o, i) => assert.ok(!(o.out + o.err).includes(sentinel), `session text never shows (command ${i}): ${o.out.slice(0, 300)}`))
	const before = readFileSync(box.dbPath)
	rmSync(box.dbFile, { force: true })
	assert.equal(box.run('db', 'rebuild').status, 0)
	assert.ok(existsSync(box.dbFile))
	assert.ok(readFileSync(box.dbPath).equals(before), 'memory.db is byte-identical')
	const found = box.run('memory', 'search', sentinel, '--json')
	assert.equal(found.status, 0, found.err)
	assert.equal(JSON.parse(found.out).length, 2, 'only memory search finds it')
})

test('memory search and show through the CLI', (t) => {
	const box = cliBox(t)
	manyFiles(box, 2)
	assert.equal(box.run('memory', 'backfill', '--yes').status, 0)
	const text = box.run('memory', 'search', 'topic1')
	assert.equal(text.status, 0, text.err)
	assert.match(text.out, /prompt .*old-1 .*topic1/)
	assert.equal(JSON.parse(box.run('memory', 'search', 'subagent', '--json').out).length, 0)
	assert.equal(JSON.parse(box.run('memory', 'search', 'subagent', '--agents', '--json').out).length, 2)
	assert.equal(JSON.parse(box.run('memory', 'search', 'question', '--limit', '1', '--json').out).length, 1)
	assert.match(box.run('memory', 'search', 'question', '--limit', '500', '--json').err, /capped at 100/)
	assert.equal(JSON.parse(box.run('memory', 'search', 'question', '--session', 'old-', '--json').out).length, 2, 'a session prefix')
	assert.equal(JSON.parse(box.run('memory', 'search', 'question', '--since', '1d', '--json').out).length, 0, 'those sessions are older than a day')
	assert.equal(box.run('memory', 'search', 'question', '--role', 'bogus').status, 1)
	assert.equal(box.run('memory', 'search', '*').out.includes('Nothing in your sessions'), true)
	const show = box.run('memory', 'show', 'old-1')
	assert.match(show.out, /Session old-1/)
	assert.ok(!show.out.includes('question 1 about topic1'), 'no text without --text')
	assert.ok(box.run('memory', 'show', 'old-1', '--text').out.includes('question 1 about topic1'))
})
