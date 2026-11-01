import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { sqlite } from './brain-db.mjs'
import { PART_BYTES, gunzipTo, gzipTo, joinParts, sha256File, snapshotSqlite, splitFile } from './vault-pack.mjs'

const root = mkdtempSync(join(tmpdir(), 'vault-pack-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const dir = () => mkdtempSync(join(root, `t${n++}-`))
const DatabaseSync = sqlite()
const count = (file) => {
	const db = new DatabaseSync(file, { readOnly: true })
	try {
		return db.prepare('SELECT count(*) AS c FROM t').get().c
	} finally {
		db.close()
	}
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

describe('snapshotSqlite', () => {
	test('a database written by another process is copied consistently, and stays writable', async () => {
		const d = dir()
		const src = join(d, 'src.db')
		const db = new DatabaseSync(src)
		db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1),(2),(3)')
		const writer = join(d, 'writer.mjs')
		writeFileSync(writer, `
			const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
			const db = new DatabaseSync(process.argv[2])
			db.exec('PRAGMA busy_timeout=5000')
			process.stdout.write('go\\n')
			for (let i = 0; i < 100000; i++) { db.exec('INSERT INTO t VALUES (' + i + ')') }
		`)
		const child = spawn(process.execPath, ['--no-warnings', writer, src], { stdio: ['pipe', 'pipe', 'inherit'] })
		try {
			await new Promise((r) => child.stdout.once('data', r))
			const start = count(src)
			const snap = join(d, 'snap.db')
			await snapshotSqlite(src, snap)
			const end = count(src)
			const got = count(snap)
			assert.ok(got >= start && got <= end, `${start} <= ${got} <= ${end}`)
			const chk = new DatabaseSync(snap, { readOnly: true })
			assert.equal(chk.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
			chk.close()
		} finally {
			child.kill('SIGKILL')
			await new Promise((r) => child.once('exit', r))
		}
		db.exec('INSERT INTO t VALUES (999)')
		db.close()
	})

	test('committed rows are included, an open transaction is not', async () => {
		const d = dir()
		const src = join(d, 'src.db')
		const db = new DatabaseSync(src)
		db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1),(2)')
		db.exec('BEGIN; INSERT INTO t VALUES (3),(4)')
		const snap = join(d, 'snap.db')
		await snapshotSqlite(src, snap)
		assert.equal(count(snap), 2)
		db.exec('COMMIT')
		const snap2 = join(d, 'snap2.db')
		await snapshotSqlite(src, snap2)
		assert.equal(count(snap2), 4)
		db.close()
	})

	test('a WAL database that nobody has open (no -shm) still snapshots, and its content is unchanged', async () => {
		const d = dir()
		const src = join(d, 'src.db')
		const db = new DatabaseSync(src)
		db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1),(2)')
		db.close()
		rmSync(`${src}-shm`, { force: true })
		rmSync(`${src}-wal`, { force: true })
		const before = await sha256File(src)
		const snap = join(d, 'snap.db')
		await snapshotSqlite(src, snap)
		assert.equal(count(snap), 2)
		assert.equal(await sha256File(src), before)
	})

	test('a missing source throws and leaves no dest', async () => {
		const d = dir()
		await assert.rejects(snapshotSqlite(join(d, 'nope.db'), join(d, 'snap.db')))
		assert.equal(existsSync(join(d, 'snap.db')), false)
	})

	test('a file that is not a database throws and leaves no dest', async () => {
		const d = dir()
		writeFileSync(join(d, 'bad.db'), randomBytes(5000))
		await assert.rejects(snapshotSqlite(join(d, 'bad.db'), join(d, 'snap.db')))
		assert.equal(existsSync(join(d, 'snap.db')), false)
	})

	test('prints no ExperimentalWarning', () => {
		const d = dir()
		const src = join(d, 'src.db')
		const db = new DatabaseSync(src)
		db.exec('CREATE TABLE t(x)')
		db.close()
		const mod = fileURLToPath(new URL('./vault-pack.mjs', import.meta.url))
		const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(mod)}).then((m) => m.snapshotSqlite(${JSON.stringify(src)}, ${JSON.stringify(join(d, 's.db'))}))`], { encoding: 'utf8' })
		assert.equal(r.status, 0, r.stderr)
		assert.doesNotMatch(r.stderr, /ExperimentalWarning/)
	})
})

describe('splitFile and joinParts', () => {
	test('2,500 bytes with 1000-byte parts gives 1000, 1000, 500 and joins back identically', async () => {
		const d = dir()
		const data = randomBytes(2500)
		writeFileSync(join(d, 'f.bin'), data)
		const parts = await splitFile(join(d, 'f.bin'), d, 'f.bin', 1000)
		assert.deepEqual(parts.map((p) => p.size), [1000, 1000, 500])
		assert.deepEqual(parts.map((p) => p.file.split('/').pop()), ['f.bin.part001', 'f.bin.part002', 'f.bin.part003'])
		assert.equal(parts[1].sha256, sha(data.subarray(1000, 2000)))
		await joinParts(parts.map((p) => p.file), join(d, 'joined.bin'))
		assert.equal(await sha256File(join(d, 'joined.bin')), sha(data))
	})

	test('exactly partBytes gives one part, partBytes + 1 gives two, empty gives one empty part', async () => {
		const d = dir()
		writeFileSync(join(d, 'a'), randomBytes(1000))
		writeFileSync(join(d, 'b'), randomBytes(1001))
		writeFileSync(join(d, 'c'), '')
		assert.equal((await splitFile(join(d, 'a'), d, 'a', 1000)).length, 1)
		assert.deepEqual((await splitFile(join(d, 'b'), d, 'b', 1000)).map((p) => p.size), [1000, 1])
		const c = await splitFile(join(d, 'c'), d, 'c', 1000)
		assert.deepEqual(c.map((p) => p.size), [0])
		assert.equal(c[0].sha256, sha(Buffer.alloc(0)))
	})

	test('a missing source rejects and leaves no parts', async () => {
		const d = dir()
		await assert.rejects(splitFile(join(d, 'nope'), d, 'nope', 1000))
		assert.deepEqual(readdirSync(d), [])
	})

	test('joining many parts prints no MaxListenersExceededWarning and keeps the bytes', async () => {
		const d = dir()
		const data = randomBytes(40)
		writeFileSync(join(d, 'f'), data)
		const parts = await splitFile(join(d, 'f'), d, 'f', 2) // 20 parts
		const warnings = []
		const on = (w) => warnings.push(w.name)
		process.on('warning', on)
		await joinParts(parts.map((p) => p.file), join(d, 'joined'))
		await new Promise((r) => setTimeout(r, 20))
		process.off('warning', on)
		assert.deepEqual(warnings, [])
		assert.equal(await sha256File(join(d, 'joined')), sha(data))
	})

	test('a missing part makes joinParts reject and leaves no dest', async () => {
		const d = dir()
		writeFileSync(join(d, 'p1'), 'abc')
		await assert.rejects(joinParts([join(d, 'p1'), join(d, 'gone')], join(d, 'out')))
		assert.equal(existsSync(join(d, 'out')), false)
	})

	test('PART_BYTES is 1.9 GiB, below the 2 GiB asset limit', () => {
		assert.ok(PART_BYTES < 2 * 1024 ** 3)
		assert.equal(PART_BYTES, Math.floor(1.9 * 1024 ** 3))
	})
})

describe('gzip', () => {
	test('round trips', async () => {
		const d = dir()
		const data = Buffer.concat([randomBytes(3000), Buffer.alloc(200000, 7)])
		writeFileSync(join(d, 'f'), data)
		await gzipTo(join(d, 'f'), join(d, 'f.gz'))
		await gunzipTo(join(d, 'f.gz'), join(d, 'back'))
		assert.equal(readFileSync(join(d, 'back')).equals(data), true)
	})

	test('a truncated gzip rejects and leaves no dest', async () => {
		const d = dir()
		writeFileSync(join(d, 'f'), randomBytes(50000))
		await gzipTo(join(d, 'f'), join(d, 'f.gz'))
		truncateSync(join(d, 'f.gz'), 20000)
		await assert.rejects(gunzipTo(join(d, 'f.gz'), join(d, 'back')))
		assert.equal(existsSync(join(d, 'back')), false)
	})
})

describe('failure cleanup', () => {
	test('a write failing mid-part leaves no part files, not even the half-written one', () => {
		const d = dir()
		writeFileSync(join(d, 'f.bin'), randomBytes(300000))
		const mod = fileURLToPath(new URL('./vault-pack.mjs', import.meta.url))
		const script = `import(${JSON.stringify(mod)}).then((m) => m.splitFile(${JSON.stringify(join(d, 'f.bin'))}, ${JSON.stringify(d)}, 'f.bin', 200000)).then(() => process.exit(3), () => process.exit(0))`
		// a 64 KiB file-size limit: the first part is cut off mid-write
		const r = spawnSync('/bin/sh', ['-c', `ulimit -f 128; exec "$0" -e "$1"`, process.execPath, script], { encoding: 'utf8' })
		assert.equal(r.status, 0, `splitFile should have rejected: ${r.stderr}`)
		assert.deepEqual(readdirSync(d).filter((f) => f.includes('.part')), [])
	})

	test('the snapshot is 0600 whatever the umask, and a failed one leaves no file', async () => {
		const d = dir()
		const src = join(d, 'src.db')
		const DB = sqlite()
		const db = new DB(src)
		db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (1)')
		db.close()
		const old = process.umask(0)
		try {
			await snapshotSqlite(src, join(d, 'snap.db'))
		} finally {
			process.umask(old)
		}
		assert.equal(statSync(join(d, 'snap.db')).mode & 0o777, 0o600)
		const copy = new DB(join(d, 'snap.db'), { readOnly: true })
		assert.equal(copy.prepare('SELECT count(*) AS c FROM t').get().c, 1)
		copy.close()
		await assert.rejects(snapshotSqlite(join(d, 'nope.db'), join(d, 'snap2.db')))
		assert.equal(existsSync(join(d, 'snap2.db')), false)
	})

	test('snapshotSqlite refuses an existing destination and leaves it untouched', async () => {
		const d = dir()
		const src = join(d, 'src.db')
		const db = new DatabaseSync(src)
		db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1)')
		db.close()
		writeFileSync(join(d, 'snap.db'), 'precious')
		await assert.rejects(snapshotSqlite(src, join(d, 'snap.db')), /already exists/)
		assert.equal(readFileSync(join(d, 'snap.db'), 'utf8'), 'precious')
	})
})
