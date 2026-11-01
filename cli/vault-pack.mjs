// Packing for the vault: live-safe SQLite snapshots, gzip and splitting into parts under the release-asset limit.
// Everything streams; no file is ever read whole. Reuses sqlite() from brain-db.mjs (it hides the ExperimentalWarning).
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, createWriteStream, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

import { sqlite } from './brain-db.mjs'

/** A release asset must stay under 2 GiB: parts are 1.9 GiB. */
export const PART_BYTES = Math.floor(1.9 * 1024 ** 3)

/**
 * A consistent copy of a live SQLite database: VACUUM INTO on a read-only connection, then an integrity check
 * of the copy. Never copies the file, never reads -wal or -shm itself. The copy is 0600 from its first byte. Throws, leaving no dest, unless the copy is ok.
 */
export async function snapshotSqlite(srcDb, destFile) {
	const DatabaseSync = sqlite()
	if (!DatabaseSync) throw new Error('node:sqlite is not available in this Node')
	if (existsSync(destFile)) throw new Error('snapshot destination already exists')
	try {
		const src = new DatabaseSync(srcDb, { readOnly: true })
		try {
			writeFileSync(destFile, '', { mode: 0o600, flag: 'wx' }) // VACUUM INTO accepts an empty file and keeps its mode, so the copy is never readable by others
			src.prepare('VACUUM INTO ?').run(destFile)
		} finally {
			src.close()
		}
		const copy = new DatabaseSync(destFile, { readOnly: true })
		try {
			const rows = copy.prepare('PRAGMA integrity_check').all()
			const result = rows.map((r) => Object.values(r)[0]).join('; ')
			if (result !== 'ok') throw new Error(`snapshot failed its integrity check: ${result}`.slice(0, 300))
		} finally {
			copy.close()
		}
	} catch (e) {
		rmSync(destFile, { force: true })
		throw e
	}
}

export async function sha256File(path) {
	const h = createHash('sha256')
	for await (const chunk of createReadStream(path)) h.update(chunk)
	return h.digest('hex')
}

/** Streams src to dest through `transform`; on any failure dest is removed. */
async function through(src, dest, transform) {
	try {
		await pipeline(createReadStream(src), transform, createWriteStream(dest))
	} catch (e) {
		rmSync(dest, { force: true })
		throw e
	}
}

export const gzipTo = (src, dest) => through(src, dest, createGzip())
export const gunzipTo = (src, dest) => through(src, dest, createGunzip())

/** Cuts src into out/<base>.part001, .part002 ... of at most `partBytes`. An empty file gives one empty part. */
export async function splitFile(src, outDir, base, partBytes = PART_BYTES) {
	if (!Number.isInteger(partBytes) || partBytes < 1) throw new Error('partBytes must be a positive integer')
	const total = statSync(src).size
	const count = Math.max(1, Math.ceil(total / partBytes))
	const parts = []
	let file
	try {
		for (let i = 0; i < count; i++) {
			file = join(outDir, `${base}.part${String(i + 1).padStart(3, '0')}`)
			const start = i * partBytes
			const end = Math.min(total, start + partBytes) - 1
			const h = createHash('sha256')
			if (total === 0) writeFileSync(file, '')
			else {
				const input = createReadStream(src, { start, end })
				input.on('data', (c) => h.update(c))
				await pipeline(input, createWriteStream(file))
			}
			parts.push({ file, size: statSync(file).size, sha256: h.digest('hex') })
		}
	} catch (e) {
		for (const p of parts) rmSync(p.file, { force: true })
		if (file) rmSync(file, { force: true })
		throw e
	}
	return parts
}

/** Appends the parts, in the order given, into dest, through one pipeline (a pipeline per part piles listeners on dest). On failure dest is removed. */
export async function joinParts(files, dest) {
	async function* chunks() {
		for (const f of files) yield* createReadStream(f)
	}
	try {
		await pipeline(Readable.from(chunks()), createWriteStream(dest))
	} catch (e) {
		rmSync(dest, { force: true })
		throw e
	}
}
