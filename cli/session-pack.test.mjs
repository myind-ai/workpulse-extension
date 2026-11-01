// node --test cli/session-pack.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { brainSandbox } from './sandbox.mjs'
import { folderFiles, packFolder, projectMemoryFiles, unpack } from './session-pack.mjs'

function box(t) {
	const root = mkdtempSync(join(tmpdir(), 'wp-pack-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	const from = join(root, 'from')
	mkdirSync(join(from, 'app'), { recursive: true })
	writeFileSync(join(from, 'app', 'a.md'), 'first file')
	writeFileSync(join(from, 'b.md'), 'second file')
	return { root, from, pack: join(root, 'p', 'pack.db') }
}

const rows = (path) => {
	const db = new DatabaseSync(path, { readOnly: true })
	try {
		return db.prepare('SELECT path, content, mtime FROM files ORDER BY path').all().map((r) => ({ path: r.path, text: Buffer.from(r.content).toString(), mtime: r.mtime }))
	} finally {
		db.close()
	}
}

test('a folder packs into a table of relative path, content and mtime, private to the owner', (t) => {
	const b = box(t)
	utimesSync(join(b.from, 'b.md'), 1_000_000, 1_000_000)
	const r = packFolder(folderFiles(b.from), b.pack)
	assert.deepEqual([r.changed, r.files, r.bytes], [true, 2, 21])
	const got = rows(b.pack)
	assert.deepEqual(got.map((x) => [x.path, x.text]), [['app/a.md', 'first file'], ['b.md', 'second file']])
	assert.equal(got[1].mtime, 1_000_000_000)
	assert.equal(statSync(b.pack).mode & 0o777, 0o600)
	assert.deepEqual(readdirSync(join(b.root, 'p')), ['pack.db'], 'no temp file left')
})

test('unchanged content leaves the pack alone, new content replaces it whole', (t) => {
	const b = box(t)
	packFolder(folderFiles(b.from), b.pack)
	const before = statSync(b.pack, { bigint: true })
	utimesSync(join(b.from, 'b.md'), 2_000_000, 2_000_000) // a new time alone is not new content
	assert.equal(packFolder(folderFiles(b.from), b.pack).changed, false)
	const same = statSync(b.pack, { bigint: true })
	assert.equal(same.mtimeNs, before.mtimeNs)
	assert.equal(same.ino, before.ino)
	writeFileSync(join(b.from, 'b.md'), 'changed')
	assert.equal(packFolder(folderFiles(b.from), b.pack).changed, true)
	assert.equal(rows(b.pack)[1].text, 'changed')
})

test('links and hidden names stay out, and an emptied folder never empties a pack that holds files', (t) => {
	const b = box(t)
	writeFileSync(join(b.from, '.DS_Store'), 'x')
	writeFileSync(join(b.from, '.a.md.1.partial'), 'half written')
	symlinkSync('/etc/hosts', join(b.from, 'linked.md'))
	symlinkSync(join(b.from, 'app'), join(b.from, 'linked-folder'))
	assert.deepEqual(folderFiles(b.from).map((f) => f.rel).sort(), ['app/a.md', 'b.md'])
	packFolder(folderFiles(b.from), b.pack)
	assert.throws(() => packFolder([], b.pack), /holds 2 file/)
	assert.equal(rows(b.pack).length, 2)
	assert.equal(packFolder([], join(b.root, 'p', 'never.db')).files, 0)
	assert.equal(existsSync(join(b.root, 'p', 'never.db')), false, 'nothing to pack makes no file')
})

test('a file that cannot be read is counted, not dropped in silence; one that vanished is neither', (t) => {
	const b = box(t)
	const locked = join(b.from, 'locked.md')
	writeFileSync(locked, 'x')
	chmodSync(locked, 0o000)
	const r = packFolder([...folderFiles(b.from), { rel: 'gone.md', abs: join(b.from, 'gone.md') }], b.pack)
	assert.equal(r.unreadable, 1)
	assert.equal(r.files, 2)
})

test('a damaged pack is rebuilt: it is made from the folder and holds nothing else', (t) => {
	const b = box(t)
	mkdirSync(join(b.root, 'p'))
	writeFileSync(b.pack, 'not a database')
	assert.equal(packFolder(folderFiles(b.from), b.pack).changed, true)
	assert.equal(rows(b.pack).length, 2)
})

test('project memory: each project\'s memory folder, another tool\'s worker folders left out', (t) => {
	const b = box(t)
	const projects = join(b.root, 'projects')
	mkdirSync(join(projects, '-x-app', 'memory'), { recursive: true })
	writeFileSync(join(projects, '-x-app', 'memory', 'MEMORY.md'), 'kept')
	writeFileSync(join(projects, '-x-app', 'session.jsonl'), 'never this')
	mkdirSync(join(projects, '-x--claude-mem-observer', 'memory'), { recursive: true })
	writeFileSync(join(projects, '-x--claude-mem-observer', 'memory', 'MEMORY.md'), 'not this')
	assert.deepEqual(projectMemoryFiles(projects).map((f) => f.rel), ['-x-app/memory/MEMORY.md'])
	assert.deepEqual(projectMemoryFiles(join(b.root, 'none')), [])
})

test('unpack restores the files with their times, and refuses to overwrite anything', (t) => {
	const b = box(t)
	utimesSync(join(b.from, 'b.md'), 1_000_000, 1_000_000)
	packFolder(folderFiles(b.from), b.pack)
	const to = join(b.root, 'to')
	assert.equal(unpack(b.pack, to).files, 2)
	assert.equal(readFileSync(join(to, 'app', 'a.md'), 'utf8'), 'first file')
	assert.equal(statSync(join(to, 'b.md')).mtimeMs, 1_000_000_000)
	assert.equal(statSync(join(to, 'b.md')).mode & 0o777, 0o600)
	assert.equal(statSync(join(to, 'app')).mode & 0o777, 0o700)
	rmSync(join(to, 'app'), { recursive: true })
	writeFileSync(join(to, 'b.md'), 'my own')
	assert.throws(() => unpack(b.pack, to), /already there/)
	assert.equal(readFileSync(join(to, 'b.md'), 'utf8'), 'my own')
	assert.equal(existsSync(join(to, 'app')), false, 'refused before anything was written')
})

test('unpack refuses a pack whose paths leave the folder, and a file that is no pack', (t) => {
	const b = box(t)
	mkdirSync(join(b.root, 'p'))
	for (const bad of ['../escape.md', '/abs.md', 'a/../../b.md', 'a\\b.md', '']) {
		const path = join(b.root, 'p', `bad${Math.random()}.db`)
		const db = new DatabaseSync(path)
		db.exec('CREATE TABLE files (path TEXT PRIMARY KEY, content BLOB NOT NULL, mtime INTEGER NOT NULL)')
		db.prepare('INSERT INTO files VALUES (?, ?, 0)').run(bad, Buffer.from('x'))
		db.close()
		assert.throws(() => unpack(path, join(b.root, 'to')), /not a plain relative path/, bad)
	}
	assert.equal(existsSync(join(b.root, 'escape.md')), false)
	const other = join(b.root, 'p', 'other.db')
	const db = new DatabaseSync(other)
	db.exec('CREATE TABLE t (v)')
	db.close()
	assert.throws(() => unpack(other, join(b.root, 'to')), /not a pack/)
})

test('unpack never writes through a link inside the target', (t) => {
	const b = box(t)
	packFolder(folderFiles(b.from), b.pack)
	const to = join(b.root, 'to')
	mkdirSync(to)
	const elsewhere = join(b.root, 'elsewhere')
	mkdirSync(elsewhere)
	symlinkSync(elsewhere, join(to, 'app'))
	assert.throws(() => unpack(b.pack, to), /link/)
	assert.deepEqual(readdirSync(elsewhere), [])
})

test('CLI: memory unpack needs --to and refuses to overwrite', (t) => {
	const b = box(t)
	const sb = brainSandbox()
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	packFolder(folderFiles(b.from), b.pack)
	const to = join(b.root, 'to')
	assert.equal(sb.run('memory', 'unpack', b.pack).status, 1)
	const r = sb.run('memory', 'unpack', b.pack, '--to', to)
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /2 files/)
	assert.equal(readFileSync(join(to, 'b.md'), 'utf8'), 'second file')
	const again = sb.run('memory', 'unpack', b.pack, '--to', to)
	assert.equal(again.status, 1)
	assert.match(again.err, /already there/)
})
