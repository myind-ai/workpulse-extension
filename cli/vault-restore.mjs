// wp-brain vault restore: brings one item back from the vault into a folder, checking every step.
// Order: download each part and check its SHA-256, join, decrypt (database), gunzip, check the whole-file SHA-256,
// integrity_check (database), and only then move into --to under the original name. Until then nothing is in --to.
// All temp work, plaintext included, is under <stagingDir>/restore-<random>/ (0700, files 0600), which this run removes
// itself; a backup's resumable staged items beside it are never touched. Shares the staging lock with backup.
import { randomBytes } from 'node:crypto'
import { chmodSync, constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { sqlite } from './brain-db.mjs'
import { accountOf, allManifests, clearStalePlaintext, formatBytes, git, prepare, privateFile, pullRebase, requireCloneOfRepo, requirePrivate, withLock } from './vault.mjs'
import { decryptFile, fingerprint } from './vault-crypto.mjs'
import { bareName } from './vault-manifest.mjs'
import { gunzipTo, joinParts, sha256File } from './vault-pack.mjs'

const PREFIX = 'restore-'

/** The clone brought level with its origin when it can be; offline, the clone as it is still answers. */
function refresh(ctx) {
	try {
		const branch = git(ctx, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
		if (branch === 'HEAD') return
		pullRebase(ctx, branch)
	} catch {
		ctx.log('Could not refresh the manifest from the vault repository; using the clone as it is.')
	}
}

/** The item to restore: an id, else the newest item with that name on any device. */
function pick(ctx, { id, name }) {
	const items = allManifests(ctx).flatMap((m) => m.items.map((it) => ({ ...it, device: m.device })))
	const hits = id ? items.filter((i) => i.id === id) : items.filter((i) => i.name === name)
	if (!hits.length && id && name) return pick(ctx, { name })
	if (!hits.length) throw new Error('There is nothing in the vault by that name or id. `wp-brain vault restore` with no argument lists what can be restored.')
	return hits.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
}

/** The key for a database item: missing and mismatched are refused here, before anything is downloaded. */
function keyFor(ctx, item) {
	const key = ctx.keystore.get(accountOf(ctx.cfg))
	if (key === null || key === undefined) throw new Error('There is no vault key on this Mac, so this database cannot be decrypted. Put the key back with `wp-brain vault key import` (from your offline copy), then run again.')
	if (item.keyFp && fingerprint(key) !== item.keyFp) throw new Error(`wrong key: this database was encrypted with the key whose fingerprint is ${item.keyFp}, and the key on this Mac is ${fingerprint(key)}. Import the right key with \`wp-brain vault key import\`.`)
	return key
}

const nearestExisting = (p) => {
	let d = resolve(p)
	while (!existsSync(d) && dirname(d) !== d) d = dirname(d)
	return d
}

const partsTotal = (item) => item.parts.reduce((a, p) => a + p.size, 0)

/** Parts, the joined file, and for a database the gzip and the snapshot all sit in staging at once, in the worst case. */
function checkDisk(ctx, item, to) {
	const total = partsTotal(item)
	const staging = Math.ceil(1.1 * (item.kind === 'database' ? 2 * total + item.size : total + item.size))
	const haveStaging = ctx.freeBytes(ctx.stagingDir)
	if (haveStaging < staging) throw new Error(`Not enough free disk for restoring in ${ctx.stagingDir}: needs ${formatBytes(staging)}, has ${formatBytes(haveStaging)}. Nothing was written.`)
	const there = Math.ceil(1.1 * item.size)
	const haveTo = ctx.freeBytes(nearestExisting(to))
	if (haveTo < there) throw new Error(`Not enough free disk in ${to}: needs ${formatBytes(there)}, has ${formatBytes(haveTo)}. Nothing was written.`)
}

async function download(ctx, item, work) {
	let there
	try {
		there = new Set((await ctx.storage.listAssets(item.release)).map((a) => a.name))
	} catch (e) {
		if (/not found/i.test(e.message)) throw new Error(`The snapshot is incomplete: release ${item.release} is gone from the vault. Nothing was written.`)
		throw new Error(`Release ${item.release} could not be read (${`${e.message}`.slice(0, 200)}). Nothing was written.`)
	}
	const missing = item.parts.filter((p) => !there.has(p.asset)).map((p) => p.asset)
	if (missing.length) throw new Error(`The snapshot is incomplete: release ${item.release} no longer holds ${missing.join(', ')}. Nothing was written.`)
	const files = []
	for (const part of item.parts) {
		const file = await ctx.storage.getAsset(item.release, part.asset, work)
		if (statSync(file).size !== part.size || (await sha256File(file)) !== part.sha256) throw new Error(`Part ${part.asset} of release ${item.release} is damaged: what came back differs from what the manifest lists. Nothing was written.`)
		files.push(file)
	}
	return files
}

function integrityOk(file) {
	const DatabaseSync = sqlite()
	if (!DatabaseSync) throw new Error('node:sqlite is not available in this Node, so the database cannot be checked.')
	const db = new DatabaseSync(file, { readOnly: true })
	try {
		return db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]).join('; ')
	} finally {
		db.close()
	}
}

const NO_LINKS = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'])

/** Copies from to a new dest, failing with EEXIST if dest exists; a copy that fails midway leaves no dest. */
function copyExclusive(from, dest, secret, copy = copyFileSync) {
	if (secret) privateFile(dest) // 'wx': EEXIST here too, and the file is 0600 from its first byte
	let made = secret
	try {
		copy(from, dest, secret ? 0 : constants.COPYFILE_EXCL)
		made = true
		if (secret) chmodSync(dest, 0o600)
	} catch (e) {
		if (made || e.code !== 'EEXIST') rmSync(dest, { force: true })
		throw e
	}
}

/**
 * The real name, from a finished temp copy beside it, never replacing anything. Without hard links there is no atomic
 * "rename unless it exists", so: O_EXCL claims the name (EEXIST means someone else has it, and nothing was touched), then the
 * rename goes over this run's own empty claim. A kill in that instant leaves an empty file, never a truncated one that looks
 * whole. Only a writer that ignores O_EXCL and opens the name in that same instant could lose out.
 */
function publishExclusive(tmp, dest) {
	privateFile(dest)
	try {
		renameSync(tmp, dest)
	} catch (e) {
		rmSync(dest, { force: true }) // this run's empty claim
		throw e
	}
}

/**
 * Moves the checked file to dest and returns true, or false when `force` is off and dest appeared meanwhile (kept).
 * Without force it never replaces: a hard link fails on an existing name. Where links can't be made (another disk, FAT/exFAT,
 * some network mounts) the copy goes to a temp name first, so a hard kill during it can leave only that `.partial-` file,
 * never a truncated file under the real name that the next run would call kept. With force: a rename, or a copy through a temp name.
 */
function place(file, dest, secret, force, link = linkSync, copy = copyFileSync) {
	const throughTemp = (publish) => {
		const tmp = `${dest}.partial-${randomBytes(4).toString('hex')}`
		try {
			copyExclusive(file, tmp, secret, copy)
			publish(tmp)
		} finally {
			rmSync(tmp, { force: true })
		}
	}
	if (!force) {
		try {
			link(file, dest)
		} catch (e) {
			if (e.code === 'EEXIST') return false
			if (!NO_LINKS.has(e.code)) throw e
			try {
				throughTemp((tmp) => {
					try {
						publishExclusive(tmp, dest)
					} catch (p) {
						if (p.code === 'EEXIST') p.kept = true
						throw p
					}
				})
			} catch (c) {
				if (c.kept) return false
				throw c
			}
		}
		rmSync(file, { force: true })
		return true
	}
	try {
		renameSync(file, dest)
		return true
	} catch (e) {
		if (e.code !== 'EXDEV') throw e
	}
	throughTemp((tmp) => renameSync(tmp, dest))
	return true
}

const exists = (p) => {
	try {
		lstatSync(p)
		return true
	} catch (e) {
		if (e.code === 'ENOENT') return false
		throw e
	}
}

/**
 * Restores one item into `to` under its original name. Returns { files, kept }: the files written, and the
 * files that were already there and left alone (without `force`). opts: { id, name, to, force }.
 */
export async function restore(rawCtx, opts = {}) {
	const ctx = prepare(rawCtx)
	if (!opts.id && !opts.name) throw new Error('Name or id the item to restore. `wp-brain vault restore` with no argument lists them.')
	if (typeof opts.to !== 'string' || !opts.to) throw new Error('Restore needs a folder to put the file in: --to DIR.')

	// Everything below holds the staging lock: the pull changes the clone a running backup syncs, and plaintext is cleared first, as backup does, so a refused run clears too.
	return withLock(ctx, async () => {
		clearStalePlaintext(ctx) // also removes restore-* folders of killed runs; staged backup items keep state.json and their encrypted parts
		requirePrivate(ctx)
		requireCloneOfRepo(ctx)
		refresh(ctx)
		const item = pick(ctx, opts)
		if (!bareName(item.name)) throw new Error(`Item ${item.id} (${item.kind}) has a name that is not a bare filename, so nothing was restored.`)
		if (item.parts.some((p) => !bareName(p.asset))) throw new Error(`Item ${item.id} (${item.kind}) lists a part name that is not a bare filename, so nothing was restored.`)
		const to = resolve(opts.to)
		if (exists(to) && !statSync(to).isDirectory()) throw new Error(`${to} is not a folder.`)
		const dest = join(to, item.name)
		const kept = () => {
			const empty = item.size > 0 && lstatSync(dest).size === 0
			ctx.log(`kept ${dest}: it is already there${empty ? ", and it is empty, which a restore killed at its very last step can leave; if it isn't yours, delete it and run again" : ''} (use --force to replace it)`)
			return { files: [], kept: [dest] }
		}
		if (exists(dest) && !opts.force) return kept()
		if (exists(dest) && lstatSync(dest).isDirectory()) throw new Error(`${dest} is a folder, so it was not replaced.`)
		const secret = item.kind === 'database'
		const beside = secret ? [`${dest}-wal`, `${dest}-shm`].filter(exists) : []
		if (beside.length) throw new Error(`${beside.join(' and ')} sit${beside.length === 1 ? 's' : ''} beside ${dest}: SQLite could replay that old log into the restored database. Move or delete ${beside.length === 1 ? 'it' : 'them'}, then run again.`)
		const key = secret ? keyFor(ctx, item) : null

		checkDisk(ctx, item, to)
		const work = join(ctx.stagingDir, `${PREFIX}${randomBytes(6).toString('hex')}`)
		mkdirSync(work, { mode: 0o700 })
		try {
			const parts = join(work, 'parts')
			mkdirSync(parts, { mode: 0o700 })
			const files = await download(ctx, item, parts)
			const joined = join(work, 'joined')
			if (secret) privateFile(joined)
			await joinParts(files, joined)
			rmSync(parts, { recursive: true, force: true })

			let result = joined
			if (secret) {
				const gz = join(work, 'snapshot.gz')
				await decryptFile(joined, gz, key)
				rmSync(joined)
				result = join(work, 'snapshot.db')
				privateFile(result)
				await gunzipTo(gz, result)
				rmSync(gz)
			}
			if (statSync(result).size !== item.size || (await sha256File(result)) !== item.sha256) throw new Error(`${item.name} does not match the checksum the manifest lists after it was put together, so it was not restored. Nothing was written.`)
			if (secret) {
				const verdict = integrityOk(result)
				if (verdict !== 'ok') throw new Error(`The restored database failed its integrity check (${verdict.slice(0, 200)}), so it was not restored. Nothing was written.`)
				chmodSync(result, 0o600)
			}
			mkdirSync(to, { recursive: true })
			if (!place(result, dest, secret, !!opts.force, ctx.linkFile, ctx.copyFile)) return kept() // it appeared while the parts came down
			// A name picks the newest match on any device, so say which one came back.
			ctx.log(`restored ${dest} (${formatBytes(item.size)}), from device ${item.device}, dated ${String(item.date).slice(0, 16).replace('T', ' ')} UTC`)
			return { files: [dest], kept: [] }
		} finally {
			rmSync(work, { recursive: true, force: true })
		}
	})
}
