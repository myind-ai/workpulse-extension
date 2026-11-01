// wp-brain vault: the commands on top of the manifest, packing, crypto and storage modules.
// Every outside thing comes in through `ctx`, so tests pass fakes: { cfg, storage, keystore, clone, now, log, stagingDir, partBytes, freeBytes, repoVisibility }.
// cfg is parseVaultConfig's result. Only runVaultCli builds the real githubStorage and Keychain keystore.
//
// Staging: <stagingDir>/<item key>/ holds state.json (tag, part names, sizes, hashes, needsUpload, source identity) and,
// for a database, its encrypted parts. Plaintext lives there only while it is being packed. A failed run leaves the
// staging, and the next run reuses it and the same tag, so one snapshot never has two releases.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { assertNoLinks, fileSecretsIn, isLinkSafe, linkFree, repoVisibility } from './library.mjs'
import { encryptFile, fingerprint, keystore as macKeystore } from './vault-crypto.mjs'
import { runKeyCli } from './vault-key.mjs'
import { findOrphans, parseVaultConfig, readManifest, writeManifest } from './vault-manifest.mjs'
import { PART_BYTES, gzipTo, sha256File, snapshotSqlite, splitFile } from './vault-pack.mjs'
import { prune } from './vault-prune.mjs'
import { restore } from './vault-restore.mjs'
import { githubStorage } from './vault-storage.mjs'

const MAX_ASSET = 2 * 1024 ** 3
const ROLL_AT = 900 // a release holds up to 1000 assets; a new videos-NNNN starts well before that
const VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.opus']
const LOCK = '.lock'
const STATE = 'state.json'
export const USAGE = 'Usage: wp-brain vault init [--yes] | key export|confirm|import | backup [--videos] [--databases] [--yes] [--dry-run] [--discard-staged] | list | status | restore <name|id> --to DIR [--force] | prune [--keep N] [--yes]'
const RESTORE_FLAGS = ['to', 'force']
const PRUNE_FLAGS = ['keep', 'yes']
const BACKUP_FLAGS = ['videos', 'databases', 'yes', 'dry-run', 'discard-staged']
const SQLITE_HEAD = Buffer.from('SQLite format 3\0')
const NOT_YET = 'not there yet'

const looksSecret = (s) => fileSecretsIn(s).length > 0
/** What a tool said, for a message: nothing at all when it looks like it holds a secret. Judged whole, before it is cut short. */
export const shown = (text) => (looksSecret(text) ? '' : ` ${text.slice(0, 300)}`)
const hash16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
export const accountOf = (cfg) => cfg.repo.split('/')[0]
export const vaultClone = () => join(homedir(), '.workpulse', 'vault')

export function formatBytes(n) {
	if (n < 1024) return `${n} B`
	const units = ['KB', 'MB', 'GB', 'TB']
	let v = n
	let u = -1
	do {
		v /= 1024
		u++
	} while (v >= 1024 && u < units.length - 1)
	return `${v.toFixed(1)} ${units[u]}`
}

const freeBytesOn = (dir) => {
	const s = statfsSync(dir)
	return Number(s.bavail) * Number(s.bsize)
}

/** ctx with its defaults filled in; `now` becomes a function returning epoch ms. */
export function prepare(ctx) {
	const now = ctx.now
	return {
		log: console.log,
		stagingDir: join(homedir(), '.workpulse', 'vault-tmp'),
		freeBytes: freeBytesOn,
		repoVisibility,
		cloneRepo: cloneRepoOf,
		...ctx,
		nowMs: () => new Date(typeof now === 'function' ? now() : now ?? Date.now()).getTime(),
	}
}

function partBytesOf(ctx) {
	const raw = ctx.partBytes ?? process.env.WP_VAULT_PART_BYTES ?? PART_BYTES
	const n = Number(raw)
	if (!Number.isInteger(n) || n < 1) throw new Error('The part size must be a positive whole number of bytes.')
	if (n >= MAX_ASSET) throw new Error('The part size must stay under 2 GiB: a release asset at or over that is refused.')
	return n
}

// ── manifests ───────────────────────────────────────────────────────────────

export const manifestRel = (device) => `manifest/${device}.json`

/** One device's manifest (empty when it has none yet), read never through a link. */
export function ownManifest(ctx) {
	const rel = manifestRel(ctx.cfg.device)
	assertNoLinks(ctx.clone, rel)
	return readManifest(join(ctx.clone, rel)) ?? { version: 1, device: ctx.cfg.device, items: [] }
}

/** Every device's manifest in the clone; a linked file or folder is not read. */
export function allManifests(ctx) {
	const dir = join(ctx.clone, 'manifest')
	if (!linkFree(ctx.clone, 'manifest') || !existsSync(dir)) return []
	return readdirSync(dir)
		.filter((f) => f.endsWith('.json') && lstatSync(join(dir, f)).isFile())
		.sort()
		.map((f) => readManifest(join(dir, f)))
}

export const git = (ctx, ...args) => execFileSync('git', ['-C', ctx.clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } })

/** "owner/name" for a GitHub https or ssh remote URL, or null. The manifest goes where the storage's assets go only if this matches. */
export function repoFromUrl(url) {
	const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@(?:ssh\.)?github\.com[:/](?:443\/)?)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim())
	return m ? `${m[1]}/${m[2]}` : null
}

/** The repository the clone's origin fetches from and pushes to, or null when it has none, any URL differs, or one isn't GitHub. Reads local config only. */
export function cloneRepoOf(clone) {
	try {
		// --all: a remote can hold several URLs, and git push goes to every one of them.
		const urls = (...flags) => git({ clone }, 'remote', 'get-url', ...flags, '--all', 'origin').trim().split('\n')
		const repos = [...urls(), ...urls('--push')].map(repoFromUrl)
		return repos.every((r) => r && r.toLowerCase() === repos[0].toLowerCase()) ? repos[0] : null
	} catch {
		return null
	}
}

/** Refuses unless the clone's origin is cfg.repo: the private check covers cfg.repo, and names and checksums go to origin. Never prints the URL, which can hold a token. */
export function requireCloneOfRepo(ctx) {
	const { cfg } = ctx
	if (!existsSync(join(ctx.clone, '.git'))) throw new Error(`There is no vault clone at ${ctx.clone}: run \`wp-brain vault init\`.`)
	const repo = ctx.cloneRepo(ctx.clone)
	if (repo?.toLowerCase() !== cfg.repo.toLowerCase()) throw new Error(`The vault clone at ${ctx.clone} does not push to ${cfg.repo}${repo ? ` (its origin is ${repo})` : ''}, so its manifest would go somewhere the private check never looked. Nothing was read or uploaded.`)
}

/** Refuses unless the vault repository is private; unknown counts as not private. */
export function requirePrivate(ctx) {
	const visibility = ctx.repoVisibility(ctx.cfg.repo)
	if (visibility !== 'private') throw new Error(`${ctx.cfg.repo} is ${visibility === 'public' ? 'a public repository' : 'a repository whose visibility could not be told'}. The vault only uses a private repository; nothing was read or uploaded.`)
}

/** The git operation left unfinished in the clone, or null. Committing during one would conclude it. */
function unfinishedOp(ctx) {
	const gitDir = git(ctx, 'rev-parse', '--absolute-git-dir').trim()
	const there = (...names) => names.some((n) => existsSync(join(gitDir, n)))
	return there('rebase-merge', 'rebase-apply') ? 'rebase' : there('MERGE_HEAD') ? 'merge' : there('CHERRY_PICK_HEAD') ? 'cherry-pick' : there('REVERT_HEAD') ? 'revert' : null
}

/** An error no later run gets past by itself: the owner has to act on the clone first. */
const needsOwner = (message) => Object.assign(new Error(message), { needsOwner: true })

/** Pulls with a rebase; a conflict in this pull is undone, so this call never leaves the clone mid-rebase. An operation already under way is the owner's: it is left as it is, with no pull. */
export function pullRebase(ctx, branch) {
	const op = unfinishedOp(ctx)
	if (op) throw needsOwner(`A ${op} is unfinished in the clone. Finish it or undo it, then run again.`)
	try {
		git(ctx, 'pull', '-q', '--rebase', 'origin', branch)
	} catch (e) {
		if (unfinishedOp(ctx) !== 'rebase') throw e
		let undone = true
		try {
			git(ctx, 'rebase', '--abort')
		} catch {
			undone = false // still mid-rebase: the next run stops and says so
		}
		throw needsOwner(undone ? 'This manifest conflicts with what is on the remote, so the rebase was undone. Sort out the conflict in the clone by hand, then run again.' : 'This manifest conflicts with what is on the remote, and the rebase could not be undone: the clone is still in the middle of it. Finish or undo it by hand, then run again.')
	}
}

/** Commits this device's manifest if it changed, then brings the clone level with its own origin. Nothing else is committed or pushed. */
export function syncManifest(ctx) {
	const rel = manifestRel(ctx.cfg.device)
	try {
		const op = unfinishedOp(ctx)
		if (op) throw needsOwner(`A ${op} is unfinished in the clone. Finish it or undo it, then run again.`)
		const branch = git(ctx, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
		if (branch === 'HEAD') throw needsOwner('The clone is not on a branch. Switch it to its branch with git, then run again.')
		if (existsSync(join(ctx.clone, rel))) {
			git(ctx, 'add', '--', rel)
			if (git(ctx, 'diff', '--cached', '--name-only', '--', rel).trim()) git(ctx, 'commit', '-q', '-m', `vault: manifest of ${ctx.cfg.device}`, '--', rel)
		}
		pullRebase(ctx, branch)
		git(ctx, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
	} catch (e) {
		if (e.needsOwner) throw new Error(`The vault manifest was not pushed (${ctx.clone}), and no run pushes it until this is sorted out. ${e.message}`)
		throw new Error(`The vault manifest could not be synced with the vault repository (${ctx.clone}). Any new item is saved in the clone, and the next run pushes it.${shown(`${e.stderr || e.message}`.trim())}`)
	}
}

/** Adds items to this device's manifest (by id, so a repeat replaces), then commits and pushes. */
function recordItems(ctx, items) {
	const m = ownManifest(ctx)
	const ids = new Set(items.map((i) => i.id))
	m.items = [...m.items.filter((i) => !ids.has(i.id)), ...items]
	writeManifest(join(ctx.clone, manifestRel(ctx.cfg.device)), m)
	syncManifest(ctx)
}

/** Every item any device has listed, each with its `device`, newest first. */
export function list(rawCtx) {
	const ctx = prepare(rawCtx)
	return allManifests(ctx)
		.flatMap((m) => m.items.map((it) => ({ ...it, device: m.device })))
		.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.name.localeCompare(b.name))
}

// ── finding the sources (lstat, plus the first bytes of a file going up as a video) ──

/** True when the file starts with SQLite's own header. Unreadable is false: the read that hashes it fails loudly. */
function isSqlite(path) {
	let fd
	try {
		fd = openSync(path, 'r')
		const head = Buffer.alloc(SQLITE_HEAD.length)
		return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(SQLITE_HEAD)
	} catch {
		return false
	} finally {
		if (fd !== undefined) closeSync(fd)
	}
}


/** Files named in vault.videos. A folder is walked for video and audio files; a link is skipped and reported, never followed. Stops on a secret-shaped name. */
function findVideos(cfg) {
	const found = []
	const skipped = []
	cfg.videos.forEach((root, i) => {
		const where = looksSecret(root) ? `vault.videos entry ${i + 1}` : root
		let position = 0
		const visit = (abs, rel) => {
			let st
			try {
				st = lstatSync(abs)
			} catch {
				throw new Error(`The vault source ${where} was not found.`)
			}
			if (rel && !st.isDirectory()) position++
			const shown = () => (looksSecret(rel) ? `(position ${position} in ${where})` : rel)
			if (st.isSymbolicLink()) skipped.push({ name: rel ? shown() : where, why: 'symlink' })
			else if (st.isDirectory()) {
				for (const name of readdirSync(abs).sort()) {
					if (!name.startsWith('.')) visit(join(abs, name), rel ? `${rel}/${name}` : name)
				}
			} else if (st.isFile()) {
				const name = basename(abs)
				if (rel && !VIDEO_EXT.includes(extname(name).toLowerCase())) skipped.push({ name: shown(), why: 'not a video' })
				else {
					if (looksSecret(name)) throw new Error(`Stopped before any upload: the file at position ${Math.max(position, 1)} in ${where} has a name that looks like it holds a secret. Rename it and run again.`)
					// Videos are not encrypted, so a database here would go up in the clear.
					if (isSqlite(abs)) throw new Error(`Stopped before any upload: ${rel ? shown() : where} is a SQLite database, and what is listed under "videos" is not encrypted. Move it to "databases" in the "vault" section of brain.json, so that it is encrypted, and run again.`)
					found.push({ path: abs, name, size: st.size })
				}
			}
		}
		visit(root, '')
	})
	return { found, skipped }
}

function findDatabases(cfg) {
	const found = []
	const skipped = []
	cfg.databases.forEach((path, i) => {
		const where = `vault.databases entry ${i + 1}`
		const name = basename(path)
		if (looksSecret(path)) throw new Error(`Stopped before any upload: ${where} has a name that looks like it holds a secret. Rename it and run again.`)
		if (isLinkSafe(path)) {
			skipped.push({ name, why: 'symlink' })
			return
		}
		let st
		try {
			st = lstatSync(path)
		} catch {
			if (cfg.defaultDatabases?.includes(path)) {
				skipped.push({ name, why: NOT_YET })
				return
			}
			throw new Error(`The vault source ${path} was not found.`)
		}
		if (!st.isFile()) throw new Error(`The vault source ${path} is not a file.`)
		found.push({ path, name, size: st.size })
	})
	return { found, skipped }
}

/** The file's whole hash and one hash per part, from one streaming read. */
async function hashWithParts(path, partBytes) {
	const whole = createHash('sha256')
	const parts = []
	let cur = createHash('sha256')
	let inPart = 0
	let total = 0
	for await (const chunk of createReadStream(path)) {
		whole.update(chunk)
		total += chunk.length
		let at = 0
		while (at < chunk.length) {
			const take = Math.min(chunk.length - at, partBytes - inPart)
			cur.update(chunk.subarray(at, at + take))
			inPart += take
			at += take
			if (inPart === partBytes) {
				parts.push({ size: inPart, sha256: cur.digest('hex') })
				cur = createHash('sha256')
				inPart = 0
			}
		}
	}
	if (inPart > 0 || parts.length === 0) parts.push({ size: inPart, sha256: cur.digest('hex') })
	return { sha256: whole.digest('hex'), size: total, parts }
}

/** Hashes a video; a file that changed during the read gets one more read, then the run fails naming it. */
async function readVideo(video, partBytes) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const before = lstatSync(video.path)
		const h = await hashWithParts(video.path, partBytes)
		const after = lstatSync(video.path)
		if (before.size === after.size && before.mtimeMs === after.mtimeMs && h.size === after.size) return { ...video, ...h, mtimeMs: after.mtimeMs }
	}
	throw new Error(`${video.name} keeps changing while it is being read, so it was not backed up. Run again when nothing is writing to it.`)
}

// ── staging ─────────────────────────────────────────────────────────────────

const itemKey = (kind, path) => `${kind}-${hash16(path)}`

function writeState(dir, state) {
	const tmp = join(dir, `${STATE}.partial`)
	writeFileSync(tmp, JSON.stringify(state, null, '\t'), { mode: 0o600 })
	renameSync(tmp, join(dir, STATE))
}

function readState(dir) {
	try {
		const s = JSON.parse(readFileSync(join(dir, STATE), 'utf8'))
		return typeof s.tag === 'string' && Array.isArray(s.parts) ? s : null
	} catch {
		return null
	}
}

/** Tags of the releases the staged items of an unfinished backup use; a resumable run owns them. */
export function stagedTags(ctx) {
	if (!existsSync(ctx.stagingDir)) return new Set()
	const tags = new Set()
	for (const entry of readdirSync(ctx.stagingDir)) {
		const p = join(ctx.stagingDir, entry)
		const state = lstatSync(p).isDirectory() ? readState(p) : null
		if (state) tags.add(state.tag)
	}
	return tags
}

function ensureStaging(ctx) {
	if (isLinkSafe(ctx.stagingDir)) throw new Error(`The vault staging folder ${ctx.stagingDir} is a symlink. Nothing was changed.`)
	mkdirSync(ctx.stagingDir, { recursive: true, mode: 0o700 })
	chmodSync(ctx.stagingDir, 0o700)
}

const isAlive = (pid) => {
	if (!Number.isInteger(pid) || pid <= 0) return false // process.kill(0, 0) would succeed: this names no run at all
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return e.code === 'EPERM'
	}
}

const readLock = (path) => {
	try {
		return readFileSync(path, 'utf8')
	} catch (e) {
		if (e.code === 'ENOENT') return null
		throw e
	}
}

/** A pid can be reused after a reboot, so the lock may be stale: the message says how to tell, and where it is. */
const lockBusy = (lock, pid) => Object.assign(new Error(`A vault run is already running${pid ? ` (process ${pid})` : ''}. If it is not, ${pid ? `and \`ps -p ${pid}\` shows something else, ` : ''}delete ${lock} and run again.`), { code: 'ERR_VAULT_BUSY', lockPath: lock })

/** Puts a dead run's lock aside and removes it. If what came aside is no longer that lock, another run just took over: it goes back, and this run stops. */
function removeDeadLock(lock, seen) {
	const aside = `${lock}.${process.pid}.stale`
	try {
		renameSync(lock, aside)
	} catch (e) {
		if (e.code === 'ENOENT') return
		throw e
	}
	const taken = readLock(aside)
	try {
		if (taken !== seen) {
			linkSync(aside, lock)
			throw lockBusy(lock, taken.trim())
		}
	} finally {
		rmSync(aside, { force: true })
	}
}

/** Runs fn holding the staging folder: a second live run would delete this one's plaintext and race it for the release. */
export async function withLock(ctx, fn) {
	ensureStaging(ctx)
	const lock = join(ctx.stagingDir, LOCK)
	const mine = String(process.pid)
	const seen = readLock(lock)
	if (seen !== null) {
		const pid = Number(seen.trim())
		if (seen.trim() && isAlive(pid)) throw lockBusy(lock, pid)
		removeDeadLock(lock, seen)
	}
	// Written first and linked into place, so that a lock is never seen empty and only one run can make it.
	const tmp = `${lock}.${mine}.partial`
	writeFileSync(tmp, mine, { mode: 0o600 })
	try {
		linkSync(tmp, lock)
	} catch (e) {
		if (e.code === 'EEXIST') throw lockBusy(lock)
		throw e
	} finally {
		rmSync(tmp, { force: true })
	}
	try {
		return await fn()
	} finally {
		if (readLock(lock) === mine) rmSync(lock, { force: true }) // a lock this run doesn't hold is someone else's
	}
}

/** Removes what a hard kill may have left: anything but state.json and a database's encrypted parts. An item with no state.json starts over. */
export function clearStalePlaintext(ctx) {
	for (const entry of readdirSync(ctx.stagingDir)) {
		const p = join(ctx.stagingDir, entry)
		if (entry.startsWith(LOCK)) {
			// A live run's lock files are its own; a killed run's leftovers hold only a pid.
			if (entry !== LOCK && !isAlive(Number(entry.split('.')[2]))) rmSync(p, { force: true })
			continue
		}
		const state = lstatSync(p).isDirectory() ? readState(p) : null
		if (!state) {
			rmSync(p, { recursive: true, force: true })
			continue
		}
		const keep = new Set([STATE, ...(state.kind === 'database' ? state.parts.map((x) => x.asset) : [])])
		for (const f of readdirSync(p)) if (!keep.has(f)) rmSync(join(p, f), { recursive: true, force: true })
	}
}

function discardStaging(ctx) {
	for (const entry of readdirSync(ctx.stagingDir)) if (!entry.startsWith(LOCK)) rmSync(join(ctx.stagingDir, entry), { recursive: true, force: true })
}

/** An empty file only the owner can read, so that plaintext written into it never is world-readable. */
export const privateFile = (path) => writeFileSync(path, '', { mode: 0o600, flag: 'wx' })

/** Snapshot, gzip, encrypt, split. Plaintext goes right after encryption; on any failure the whole item folder goes. */
async function stageDatabase(ctx, db, position, tag, key, keyFp) {
	const dir = join(ctx.stagingDir, itemKey('database', db.path))
	rmSync(dir, { recursive: true, force: true })
	mkdirSync(dir, { mode: 0o700 })
	try {
		const snapshot = join(dir, 'snapshot.db')
		await snapshotSqlite(db.path, snapshot)
		const size = statSync(snapshot).size
		const sha256 = await sha256File(snapshot)
		const gz = `${snapshot}.gz`
		privateFile(gz)
		await gzipTo(snapshot, gz)
		const enc = `${gz}.age`
		await encryptFile(gz, enc, key)
		rmSync(snapshot)
		rmSync(gz)
		const parts = await splitFile(enc, dir, `${sha256.slice(0, 8)}-${position}`, ctx.partBytes)
		rmSync(enc)
		const state = {
			id: newId(),
			kind: 'database',
			name: db.name,
			path: db.path,
			tag,
			size,
			sha256,
			date: new Date(ctx.nowMs()).toISOString(),
			keyFp,
			// New ciphertext: an asset of the same name and size in a reused release is not this one, so every part must go.
			parts: parts.map((p) => ({ asset: basename(p.file), size: p.size, sha256: p.sha256, needsUpload: true })),
		}
		writeState(dir, state)
		return state
	} catch (e) {
		rmSync(dir, { recursive: true, force: true })
		throw e
	}
}

const newId = () => `i-${randomBytes(8).toString('hex')}`

/** A staged database that can still be used: same key, every part there and undamaged. */
async function reusableDatabase(dir, keyFp) {
	const state = readState(dir)
	if (!state || state.kind !== 'database' || state.keyFp !== keyFp) return null
	for (const p of state.parts) {
		const file = join(dir, p.asset)
		if (!existsSync(file) || statSync(file).size !== p.size || (await sha256File(file)) !== p.sha256) return null
	}
	return state
}

// ── release work ────────────────────────────────────────────────────────────

/** Uploads what is not there yet: a part with the right name and size is skipped, unless the check marked it needsUpload. */
async function sendParts(ctx, state, dir, fileFor, afterSend = () => {}) {
	const there = new Map((await ctx.storage.listAssets(state.tag)).map((a) => [a.name, a.size]))
	for (const [i, part] of state.parts.entries()) {
		if (!part.needsUpload && there.get(part.asset) === part.size) continue
		const file = await fileFor(part, i)
		// Marked first: an upload killed halfway can leave an asset of the right size that is not good.
		part.needsUpload = true
		writeState(dir, state)
		await ctx.storage.putAsset(state.tag, file, part.asset)
		part.needsUpload = false
		writeState(dir, state)
		afterSend(file)
	}
}

/** Downloads every part back and compares its SHA-256. Damaged parts are marked for the next run, and the error names them. */
async function checkParts(ctx, state, dir) {
	const back = join(dir, 'verify')
	rmSync(back, { recursive: true, force: true })
	mkdirSync(back, { mode: 0o700 })
	const bad = []
	try {
		for (const part of state.parts) {
			let copy
			try {
				copy = await ctx.storage.getAsset(state.tag, part.asset, back)
			} catch (e) {
				part.needsUpload = true
				writeState(dir, state)
				throw e
			}
			if ((await sha256File(copy)) !== part.sha256) {
				part.needsUpload = true
				bad.push(part.asset)
			}
			rmSync(copy, { force: true })
		}
	} finally {
		rmSync(back, { recursive: true, force: true })
	}
	if (bad.length) {
		writeState(dir, state)
		throw new Error(`The post-upload check failed for ${bad.join(', ')} in release ${state.tag}: what came back differs from what was sent. Nothing was listed in the manifest; run again to upload it once more.`)
	}
}

const toItem = (state, verifiedAt) => ({
	id: state.id,
	kind: state.kind,
	name: state.name,
	size: state.size,
	sha256: state.sha256,
	date: state.date,
	release: state.tag,
	encrypted: state.kind === 'database',
	...(state.keyFp ? { keyFp: state.keyFp } : {}),
	parts: state.parts.map(({ asset, size, sha256 }) => ({ asset, size, sha256 })),
	verifiedAt,
})

const snapshotTag = (ctx) => `snap-${new Date(ctx.nowMs()).toISOString().replace(/[-:]|\.\d+/g, '')}-${ctx.cfg.device}`

/** One snapshot release: upload every database in it, check them all, publish, list them, push, clean. */
async function finishSnapshot(ctx, tag, staged) {
	await ctx.storage.createRelease(tag, { draft: true })
	for (const { state, dir } of staged) await sendParts(ctx, state, dir, (part) => join(dir, part.asset))
	for (const { state, dir } of staged) await checkParts(ctx, state, dir)
	await ctx.storage.publishRelease(tag)
	const verifiedAt = new Date(ctx.nowMs()).toISOString()
	recordItems(ctx, staged.map(({ state }) => toItem(state, verifiedAt)))
	for (const { dir } of staged) rmSync(dir, { recursive: true, force: true })
}

async function backupDatabases(ctx, dbs, key, keyFp) {
	const listed = new Set(ownManifest(ctx).items.map((i) => i.id))
	const staged = []
	let unfinishedTag = null // a release an earlier run started: reused, even when what it staged is not, so no second draft appears
	for (const db of dbs) {
		const dir = join(ctx.stagingDir, itemKey('database', db.path))
		const earlier = readState(dir)
		if (earlier && !listed.has(earlier.id)) unfinishedTag ??= earlier.tag
		const state = await reusableDatabase(dir, keyFp)
		if (state && !listed.has(state.id)) staged.push({ db, dir, state })
		else {
			rmSync(dir, { recursive: true, force: true }) // already listed, or not usable
			staged.push({ db, dir, state: null })
		}
	}
	const tag = unfinishedTag ?? snapshotTag(ctx)
	for (const [i, s] of staged.entries()) {
		s.resumed = !!s.state
		if (s.state) ctx.log(`resuming the staged snapshot of ${s.db.name} from ${s.state.date}`)
		else s.state = await stageDatabase(ctx, s.db, i + 1, tag, key, keyFp)
	}
	const tags = [...new Set(staged.map((s) => s.state.tag))]
	for (const t of tags) await finishSnapshot(ctx, t, staged.filter((s) => s.state.tag === t))
	return { snapshot: tag, uploaded: staged.map(({ db, state, resumed }) => ({ ...summary(state), path: db.path, resumed })) }
}

const summary = (state) => ({ id: state.id, kind: state.kind, name: state.name, size: state.size, release: state.tag, parts: state.parts.length })

/** The newest videos-NNNN with room for `need` more assets, created as a draft when there is none. */
async function openVideosRelease(ctx, need) {
	const rolling = (await ctx.storage.listReleases()).map((r) => r.tag).filter((t) => /^videos-\d{4,}$/.test(t)).sort()
	const last = rolling.at(-1)
	const nameOf = (n) => `videos-${String(n).padStart(4, '0')}`
	let tag = nameOf(1)
	if (last) {
		const count = (await ctx.storage.listAssets(last)).length
		tag = count + need > ROLL_AT ? nameOf(Number(last.slice('videos-'.length)) + 1) : last
	}
	await ctx.storage.createRelease(tag, { draft: true })
	return tag
}

/** Cuts one byte range of the source into staging, and checks it is what was hashed. */
async function cutPart(video, state, i, dest) {
	const part = state.parts[i]
	assertUnchanged(video, state)
	rmSync(dest, { force: true })
	privateFile(dest)
	if (part.size > 0) {
		const start = i * state.partBytes
		await pipeline(createReadStream(video.path, { start, end: start + part.size - 1 }), createWriteStream(dest))
	}
	if ((await sha256File(dest)) !== part.sha256) {
		rmSync(dest, { force: true })
		throw new Error(`${video.name} changed since it was hashed, so it was not backed up. Run again.`)
	}
	return dest
}

function assertUnchanged(video, state) {
	const st = lstatSync(video.path)
	if (st.isSymbolicLink() || st.size !== state.size || st.mtimeMs !== state.mtimeMs) throw new Error(`${video.name} changed since it was hashed, so it was not backed up. Run again.`)
}

async function backupVideo(ctx, video, position) {
	const dir = join(ctx.stagingDir, itemKey('video', video.path))
	let state = readState(dir)
	if (!state || state.sha256 !== video.sha256 || state.size !== video.size || state.mtimeMs !== video.mtimeMs || state.partBytes !== ctx.partBytes) {
		rmSync(dir, { recursive: true, force: true })
		mkdirSync(dir, { mode: 0o700 })
		const tag = await openVideosRelease(ctx, video.parts.length)
		const base = `${video.sha256.slice(0, 8)}-${position}`
		state = {
			id: newId(),
			kind: 'video',
			name: video.name,
			path: video.path,
			tag,
			size: video.size,
			sha256: video.sha256,
			mtimeMs: video.mtimeMs,
			partBytes: ctx.partBytes,
			date: new Date(ctx.nowMs()).toISOString(),
			parts: video.parts.map((p, i) => ({ asset: `${base}.part${String(i + 1).padStart(3, '0')}`, size: p.size, sha256: p.sha256, needsUpload: false })),
		}
		writeState(dir, state)
	} else {
		ctx.log(`resuming the upload of ${video.name}`)
		await ctx.storage.createRelease(state.tag, { draft: true }) // its release may have been deleted since
	}
	assertUnchanged(video, state)
	await sendParts(ctx, state, dir, (part, i) => cutPart(video, state, i, join(dir, part.asset)), (file) => rmSync(file, { force: true }))
	await checkParts(ctx, state, dir)
	const release = (await ctx.storage.listReleases()).find((r) => r.tag === state.tag)
	if (release?.draft) await ctx.storage.publishRelease(state.tag)
	recordItems(ctx, [toItem(state, new Date(ctx.nowMs()).toISOString())])
	rmSync(dir, { recursive: true, force: true })
	return summary(state)
}

// ── backup ──────────────────────────────────────────────────────────────────

/** Space for every database's snapshot, its gzip and its ciphertext at the worst case, or for one cut part of a video and its download. */
function diskNeeded(dbs, videos, partBytes) {
	const dbSizes = dbs.map((d) => d.size)
	const forDbs = dbSizes.reduce((a, b) => a + b, 0) + 2 * Math.max(0, ...dbSizes)
	const forVideos = 2 * Math.min(partBytes, Math.max(0, ...videos.map((v) => v.size)))
	return Math.ceil(1.1 * Math.max(forDbs, forVideos))
}

/** Whether an offline copy of this very key is recorded. A record that names no fingerprint counts. */
export const copyRecorded = (cfg, key) => !!cfg.keyBackedUpAt && (!cfg.keyBackedUpFp || cfg.keyBackedUpFp === fingerprint(key))

/** Refuses unless the key is there and its offline copy is recorded. A Keychain that cannot be read keeps its own error. */
function requireKey(ctx) {
	const key = ctx.keystore.get(accountOf(ctx.cfg))
	if (key === null || key === undefined) throw new Error('There is no vault key on this Mac, and a new one would orphan every old backup: run `wp-brain vault key import`.')
	if (!copyRecorded(ctx.cfg, key)) throw new Error('Encrypted backups need an offline copy of the vault key first, because losing the key loses them. In your own terminal run `wp-brain vault key export`, keep the copy off this Mac, then run `wp-brain vault key confirm`.')
	return key
}

function printPlan(ctx, dbs, videos, partBytes) {
	for (const d of dbs) ctx.log(`would snapshot, encrypt and upload database ${d.name} (${formatBytes(d.size)})`)
	for (const v of videos) {
		if (v.duplicate) ctx.log(`skipped ${v.name}: already in the vault`)
		else ctx.log(`would upload video ${v.name} (${formatBytes(v.size)}, ${Math.max(1, Math.ceil(v.size / partBytes))} part(s))`)
	}
	const total = [...dbs, ...videos.filter((v) => !v.duplicate)].reduce((a, b) => a + b.size, 0)
	ctx.log(`Dry run: nothing was uploaded or changed (about ${formatBytes(total)} to go). Add --yes to upload.`)
}

/**
 * Backs up the configured sources. Without opts.yes, or with opts.dryRun, it only says what would go.
 * Returns { uploaded, skipped, snapshot }. opts: { yes, dryRun, videos, databases, discardStaged }.
 */
export async function backup(rawCtx, opts = {}) {
	const ctx = prepare(rawCtx)
	const { cfg, log } = ctx
	const dry = !!opts.dryRun || !opts.yes
	if (opts.discardStaged && !opts.dryRun) {
		await withLock(ctx, async () => discardStaging(ctx))
		log('Discarded what was staged. A draft release it had started stays until `wp-brain vault prune`; `wp-brain vault status` shows it.')
		if (!opts.yes) return { uploaded: [], skipped: [], snapshot: null }
	}

	// First of all on a real run, so that a refused one clears too. A dry run changes nothing.
	if (!dry && existsSync(ctx.stagingDir)) await withLock(ctx, async () => clearStalePlaintext(ctx))

	requirePrivate(ctx)
	requireCloneOfRepo(ctx)
	ctx.partBytes = partBytesOf(ctx)

	const wantDbs = opts.databases || !opts.videos
	const wantVideos = opts.videos || !opts.databases
	let key = null
	if (wantDbs && cfg.databases.length) key = requireKey(ctx)

	// Names first, for every source: a secret-shaped one stops the run before anything is staged or uploaded.
	const dbFound = wantDbs ? findDatabases(cfg) : { found: [], skipped: [] }
	const videoFound = wantVideos ? findVideos(cfg) : { found: [], skipped: [] }
	const skipped = [...dbFound.skipped, ...videoFound.skipped]
	for (const s of skipped) if (s.why === 'symlink' || s.why === NOT_YET) log(`skipped ${s.name}: ${s.why}`)
	const notVideos = skipped.filter((s) => s.why === 'not a video').length
	if (notVideos) log(`left out ${notVideos} file(s) that are not video or audio`)

	const run = async () => {
		if (!dry) syncManifest(ctx)
		const listed = allManifests(ctx).flatMap((m) => m.items.filter((i) => i.kind === 'video'))
		const seen = new Set(listed.map((i) => i.sha256)) // the same content twice in one run counts once
		const sizes = new Set(listed.map((i) => i.size))
		const videos = []
		for (const v of videoFound.found) {
			// A dry run reads a file only when a listed video has its size. A real run needs the hash anyway.
			if (dry && !sizes.has(v.size)) {
				videos.push({ ...v, duplicate: false })
				continue
			}
			const read = await readVideo(v, ctx.partBytes)
			videos.push({ ...read, duplicate: seen.has(read.sha256) })
			seen.add(read.sha256)
		}
		if (dry) {
			printPlan(ctx, dbFound.found, videos, ctx.partBytes)
			for (const v of videos) if (v.duplicate) skipped.push({ name: v.name, why: 'already in the vault' })
			return { uploaded: [], skipped, snapshot: null, dryRun: true }
		}

		const toSend = videos.filter((v) => !v.duplicate)
		const toStage = dbFound.found.filter((d) => !readState(join(ctx.stagingDir, itemKey('database', d.path))))
		const need = diskNeeded(toStage, toSend, ctx.partBytes)
		const have = ctx.freeBytes(ctx.stagingDir)
		if (have < need) throw new Error(`Not enough free disk for staging in ${ctx.stagingDir}: needs ${formatBytes(need)}, has ${formatBytes(have)}. Nothing was staged or uploaded.`)

		const uploaded = []
		let snapshot = null
		if (dbFound.found.length) {
			const r = await backupDatabases(ctx, dbFound.found, key, fingerprint(key))
			snapshot = r.snapshot
			uploaded.push(...r.uploaded)
		}
		for (const v of videos.filter((x) => x.duplicate)) {
			rmSync(join(ctx.stagingDir, itemKey('video', v.path)), { recursive: true, force: true }) // listed already: what was staged is finished
			log(`skipped ${v.name}: already in the vault`)
			skipped.push({ name: v.name, why: 'already in the vault' })
		}
		for (const [i, v] of toSend.entries()) uploaded.push(await backupVideo(ctx, v, i + 1))
		for (const u of uploaded) log(`uploaded and checked ${u.kind} ${u.name} (${formatBytes(u.size)}, ${u.parts} part(s)) in ${u.release}`)
		return { uploaded, skipped, snapshot }
	}
	return dry ? run() : withLock(ctx, run)
}

// ── status ──────────────────────────────────────────────────────────────────

/** What the vault holds and what is off. Reads only; never holds the key in what it returns. */
export async function status(rawCtx) {
	const ctx = prepare(rawCtx)
	const { cfg } = ctx
	const cloned = existsSync(join(ctx.clone, '.git'))
	const items = cloned ? list(ctx) : []
	let keyPresent = null
	let keyFp = null
	let keyError = null
	let keyBackedUpAt = cfg.keyBackedUpAt
	try {
		const key = ctx.keystore.get(accountOf(cfg))
		keyPresent = key !== null && key !== undefined
		keyFp = keyPresent ? fingerprint(key) : null
		if (keyPresent && !copyRecorded(cfg, key)) keyBackedUpAt = null
	} catch (e) {
		keyError = e.message
	}
	let orphans = null
	let unlisted = null
	let storageError = null
	// With no manifests here, every release would look like an orphan.
	if (cloned) try {
		const releases = await ctx.storage.listReleases()
		orphans = findOrphans(releases.map((r) => ({ tagName: r.tag, createdAt: r.createdAt })), allManifests(ctx), ctx.nowMs())
		const listed = new Set(items.flatMap((i) => (i.parts ?? []).map((p) => `${i.release}\0${p.asset}`)))
		unlisted = []
		for (const r of releases) {
			if (orphans.includes(r.tag) || !/^(snap|videos)-/.test(r.tag)) continue
			for (const a of await ctx.storage.listAssets(r.tag)) {
				if (!listed.has(`${r.tag}\0${a.name}`)) unlisted.push({ release: r.tag, name: a.name, size: a.size })
			}
		}
	} catch (e) {
		storageError = e.message
	}
	const verified = items.map((i) => i.verifiedAt).filter(Boolean).sort()
	return {
		noClone: cloned ? null : noCloneText(ctx.clone),
		repo: cfg.repo,
		visibility: ctx.repoVisibility(cfg.repo),
		keyPresent,
		keyFp,
		keyError,
		keyBackedUpAt,
		items,
		lastVerifiedAt: verified.at(-1) ?? null,
		orphans,
		unlisted,
		storageError,
	}
}

// ── the command line ────────────────────────────────────────────────────────

const noCloneText = (clone) => `There is no vault clone on this Mac (${clone}), so this cannot say what the vault holds. Anything backed up is still on GitHub. Run \`wp-brain vault init\`.`

export function printList(log, items) {
	if (!items.length) log('The vault lists nothing yet.')
	for (const i of items) log(`${i.date.slice(0, 10)}  ${i.kind.padEnd(8)}  ${formatBytes(i.size).padStart(9)}  ${i.sha256.slice(0, 8)}  ${i.verifiedAt ? 'checked' : 'UNCHECKED'}  ${i.id}  ${i.device}  ${i.name}`)
}

function printStatus(log, s) {
	log(`Repository:    ${s.repo} (${s.visibility})`)
	log(`Key:           ${s.keyError ?? (s.keyPresent ? `present, fingerprint ${s.keyFp}` : 'missing on this Mac')}`)
	log(`Offline copy:  ${s.keyBackedUpAt ? `recorded ${s.keyBackedUpAt}` : 'not recorded'}`)
	if (s.noClone) log(`Items:         not known. ${s.noClone}`)
	else log(`Items:         ${s.items.length}${s.lastVerifiedAt ? `, last checked ${s.lastVerifiedAt}` : ''}`)
	if (s.storageError) log(`Releases:      could not be read: ${s.storageError}`)
	for (const t of s.orphans ?? []) log(`Orphan:        ${t} (no manifest lists it; older than a day)`)
	for (const a of s.unlisted ?? []) log(`Unlisted:      ${a.release}/${a.name} (${formatBytes(a.size)})`)
}

/** `wp-brain vault <sub>`. deps.cfg is brain.json; the rest default to the real thing and tests replace them. */
export async function runVaultCli({ pos, opt }, deps = {}) {
	const [sub] = pos
	if (sub === 'init' || sub === 'key') return runKeyCli({ pos, opt }, deps)
	if (!['backup', 'list', 'status', 'restore', 'prune'].includes(sub)) throw new Error(USAGE)
	if (sub === 'backup') {
		const unknown = Object.keys(opt).filter((k) => !BACKUP_FLAGS.includes(k))
		if (unknown.length) throw new Error(`Unknown option --${unknown[0]}. ${USAGE}`)
		if (pos.length > 1) throw new Error(`backup takes no argument besides its flags: it goes through what the config lists, so nothing was uploaded. ${USAGE}`)
		// parseArgs lets a flag swallow a following word; `backup --videos one.mp4` must not mean every video.
		for (const [k, v] of Object.entries(opt)) if (v !== true) throw new Error(`--${k} takes no value: it was followed by a word, so nothing was uploaded. ${USAGE}`)
	}
	if (sub === 'list' || sub === 'status') {
		const [flag] = Object.keys(opt)
		if (flag) throw new Error(`Unknown option --${flag}. ${USAGE}`)
		if (pos.length > 1) throw new Error(`${sub} takes no argument. ${USAGE}`)
	}
	const { cfg: rawCfg, ...rest } = deps
	const cfg = parseVaultConfig(rawCfg)
	if (!cfg) throw new Error('The vault is off: brain.json has no "vault" section. Run `wp-brain vault init`.')
	const log = rest.log ?? console.log
	const ctx = {
		storage: rest.storage ?? githubStorage(cfg.repo),
		keystore: rest.keystore ?? macKeystore,
		clone: rest.clone ?? vaultClone(),
		...rest,
		cfg,
		log,
	}
	const listOrSay = () => (existsSync(join(ctx.clone, '.git')) ? printList(log, list(ctx)) : log(noCloneText(ctx.clone)))
	if (sub === 'list') return listOrSay()
	if (sub === 'restore') {
		const unknown = Object.keys(opt).filter((k) => !RESTORE_FLAGS.includes(k))
		if (unknown.length) throw new Error(`Unknown option --${unknown[0]}. ${USAGE}`)
		// parseArgs lets `--force` swallow a following word: that word is the name.
		const swallowed = typeof opt.force === 'string' ? opt.force : undefined
		if (pos.length > 2 || (pos.length === 2 && swallowed !== undefined)) throw new Error(`restore takes one name or id. ${USAGE}`)
		const target = pos[1] ?? swallowed
		if (target === undefined) return listOrSay()
		if (opt.to !== undefined && typeof opt.to !== 'string') throw new Error(`--to needs a folder. ${USAGE}`)
		const r = await restore(ctx, { name: target, id: /^i-[0-9a-f]{16}$/.test(target) ? target : undefined, to: opt.to, force: !!opt.force })
		if (r.kept.length === 0) log(`Done: restored ${r.files.length} file(s).`)
		return
	}
	if (sub === 'prune') {
		const unknown = Object.keys(opt).filter((k) => !PRUNE_FLAGS.includes(k))
		if (unknown.length) throw new Error(`Unknown option --${unknown[0]}. ${USAGE}`)
		if (pos.length > 1) throw new Error(`prune takes no argument besides its flags. ${USAGE}`)
		// parseArgs lets `--yes` swallow a following word; a delete needs the flag exactly.
		if (opt.yes !== undefined && opt.yes !== true) throw new Error(`--yes takes no value: it was followed by a word, so nothing was deleted. ${USAGE}`)
		const keep = opt.keep === undefined ? undefined : /^\d+$/.test(String(opt.keep)) ? Number(opt.keep) : opt.keep // a bad value is refused by prune
		const r = await prune(ctx, { keep, yes: opt.yes === true })
		if (r.failed.length) throw new Error(`${r.failed.length} release(s) could not be deleted: ${r.failed.map((f) => f.tag).join(', ')}. Their manifest items stay; run again.`)
		return
	}
	if (sub === 'status') return printStatus(log, await status(ctx))
	const r = await backup(ctx, { yes: !!opt.yes, dryRun: !!opt['dry-run'], videos: !!opt.videos, databases: !!opt.databases, discardStaged: !!opt['discard-staged'] })
	if (!r.dryRun) log(`Done: ${r.uploaded.length} uploaded, ${r.skipped.length} skipped.`)
}
