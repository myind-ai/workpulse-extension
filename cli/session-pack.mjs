// A folder of files as one small SQLite file, so the vault can carry it as an ordinary database item: same encryption,
// integrity check, prune and restore, and no new kind of item. The pack is made from the folder and holds nothing else, so it is
// safe to rebuild; `wp-brain memory unpack` is the way back, and it never overwrites.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { isExcludedProject } from './claude-files.mjs'

const MAX_FILE = 32 * 1024 * 1024 // one oversized file in a docs folder must not fill memory or the vault

/** Every regular file below `root`, as { rel, abs }. Links and hidden names stay out, so a temp file or a `.DS_Store` is never packed. A missing folder has none. */
export function folderFiles(root, prefix = '') {
	let entries
	try {
		entries = readdirSync(root, { withFileTypes: true })
	} catch {
		return []
	}
	return entries.filter((e) => !e.name.startsWith('.')).flatMap((e) => {
		const abs = join(root, e.name)
		const rel = `${prefix}${e.name}`
		if (e.isDirectory()) return folderFiles(abs, `${rel}/`)
		return e.isFile() ? [{ rel, abs }] : []
	})
}

/** The files of each project's `memory` folder, another tool's worker folders left out. */
export function projectMemoryFiles(projects) {
	let entries
	try {
		entries = readdirSync(projects, { withFileTypes: true })
	} catch {
		return []
	}
	return entries.filter((e) => e.isDirectory() && !isExcludedProject(e.name)).flatMap((e) => folderFiles(join(projects, e.name, 'memory'), `${e.name}/memory/`))
}

const readAll = (files) => {
	const out = []
	let tooBig = 0
	let unreadable = 0
	for (const f of files) {
		try {
			const st = lstatSync(f.abs)
			if (!st.isFile()) continue
			if (st.size > MAX_FILE) {
				tooBig++
				continue
			}
			out.push({ rel: f.rel, content: readFileSync(f.abs), mtime: Math.round(st.mtimeMs) })
		} catch (e) {
			if (e.code !== 'ENOENT') unreadable++ // gone between listing and reading is fine; anything else would drop a file in silence
		}
	}
	return { rows: out, tooBig, unreadable }
}

/** What the pack holds: a Map of path to content, or null when it is missing or damaged. */
function packed(path) {
	if (!existsSync(path)) return null
	try {
		const db = new DatabaseSync(path, { readOnly: true })
		try {
			return new Map(db.prepare('SELECT path, content FROM files').all().map((r) => [r.path, Buffer.from(r.content)]))
		} finally {
			db.close()
		}
	} catch {
		return null
	}
}

function writePack(rows, pack) {
	mkdirSync(dirname(pack), { recursive: true, mode: 0o700 })
	const tmp = `${pack}.${process.pid}.partial`
	rmSync(tmp, { force: true })
	writeFileSync(tmp, '', { mode: 0o600, flag: 'wx' })
	try {
		const db = new DatabaseSync(tmp)
		try {
			db.exec('CREATE TABLE files (path TEXT PRIMARY KEY, content BLOB NOT NULL, mtime INTEGER NOT NULL)')
			db.exec('BEGIN')
			const add = db.prepare('INSERT INTO files (path, content, mtime) VALUES (?, ?, ?)')
			for (const r of rows) add.run(r.rel, r.content, r.mtime)
			db.exec('COMMIT')
		} finally {
			db.close()
		}
		chmodSync(tmp, 0o600)
		renameSync(tmp, pack)
	} catch (e) {
		rmSync(tmp, { force: true })
		rmSync(`${tmp}-journal`, { force: true })
		throw e
	}
}

/**
 * Brings the pack level with `files`. Unchanged content leaves the file alone, whatever the times say; otherwise a new one goes in by
 * rename. No files and an existing pack with some is refused: a moved folder must not turn the backup into an empty one.
 * Returns { changed, files, bytes, tooBig, unreadable }.
 */
export function packFolder(files, pack) {
	const { rows, tooBig, unreadable } = readAll(files)
	const bytes = rows.reduce((sum, r) => sum + r.content.length, 0)
	const before = packed(pack)
	if (!rows.length) {
		if (before?.size) throw new Error(`The folder has no files, and its pack holds ${before.size} file(s), so the pack was left as it is.`)
		return { changed: false, files: 0, bytes: 0, tooBig, unreadable }
	}
	const same = before && before.size === rows.length && rows.every((r) => before.get(r.rel)?.equals(r.content))
	if (!same) writePack(rows, pack)
	return { changed: !same, files: rows.length, bytes, tooBig, unreadable }
}

const plainRelative = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !/[\\\0]/.test(p) && p.split('/').every((seg) => seg && seg !== '.' && seg !== '..')

const lstatOrNull = (p) => {
	try {
		return lstatSync(p)
	} catch (e) {
		if (e.code === 'ENOENT') return null
		throw e
	}
}

/** Puts a pack's files under `to`. Everything is checked first, so a refusal writes nothing: a path that leaves the folder, a link on the way, or a file already there. */
export function unpack(dbPath, to) {
	let rows
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true })
		try {
			rows = db.prepare('SELECT path, content, mtime FROM files').all()
		} finally {
			db.close()
		}
	} catch {
		throw new Error(`${dbPath} is not a pack, so nothing was written.`)
	}
	for (const r of rows) {
		if (!plainRelative(r.path)) throw new Error(`The pack holds a name that is not a plain relative path, so nothing was written.`)
		const parts = r.path.split('/')
		for (let i = 1; i <= parts.length; i++) {
			const here = join(to, ...parts.slice(0, i))
			const st = lstatOrNull(here)
			if (!st) break
			if (st.isSymbolicLink()) throw new Error(`${here} is a link, so nothing was written.`)
			if (i === parts.length || !st.isDirectory()) throw new Error(`${here} is already there, so nothing was written. Unpack into an empty folder.`)
		}
	}
	for (const r of rows) {
		const dest = join(to, ...r.path.split('/'))
		mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
		writeFileSync(dest, Buffer.from(r.content), { mode: 0o600, flag: 'wx' })
		utimesSync(dest, new Date(r.mtime), new Date(r.mtime))
	}
	return { files: rows.length }
}
