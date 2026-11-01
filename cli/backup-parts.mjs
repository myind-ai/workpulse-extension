// The parts of `wp-brain backup-all`, in order: capture sweep, export, library, config, pack, vault, restore test. Each returns
// { state: 'done' | 'skipped' | 'failed', reason?, counts? }; not being set up is skipped, not failed. Plain session text goes only to the
// local Markdown folder (never one that syncs to iCloud, unless backup.allowICloud says so) and, encrypted, the vault: nothing here writes under the Brain clone except `library add` and `config backup`,
// which take learning notes and skills. Each is called as code, not by spawning the CLI; `libraryAdd` and `configBackup` come from wp-brain.mjs.

import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { captureLowerBound, claudeDocsDir, extraPackPath, memoryDbPath, projectsRoot, sessionsMdDir, sessionsPackPath } from './claude-files.mjs'
import { libraryPath, listLibrary, pickFiles } from './library.mjs'
import { folderFiles, packFolder, projectMemoryFiles } from './session-pack.mjs'

const DAY = 86_400_000
const RESTORE_EVERY = 30 * DAY
const MAX_SHARE_OF_FREE = 0.25

const skipped = (reason, counts) => ({ state: 'skipped', reason, ...(counts ? { counts } : {}) })
const failed = (reason, counts) => ({ state: 'failed', reason, ...(counts ? { counts } : {}) })
const done = (counts) => ({ state: 'done', counts })
const overdueSkip = (reason, counts) => ({ ...skipped(reason, counts), due: true }) // a test that should have run and didn't: backup-status.mjs warns after 30 days

async function capturePart(cfg) {
	if (cfg.memory !== true) return skipped('session memory is off')
	const since = captureLowerBound(cfg)
	if (since === null) return skipped('brain.json has no capture_since')
	const started = Date.now()
	const { runWorker } = await import('./memory-capture.mjs')
	const { readStatus } = await import('./memory-note.mjs')
	runWorker(['--since', String(since)]) // the worker catches everything and reports in status.json
	const status = readStatus()
	if (status.lastError?.at >= started) return failed(`capture stopped (${status.lastError.code})`)
	const run = status.lastRun?.at >= started ? status.lastRun : {}
	const counts = { sessions: run.sessions ?? 0, rows: run.rows ?? 0 }
	if (status.drift) return failed(`the session file format changed (${status.drift.code})`, counts)
	return run.busy ? failed('the database stayed busy; the next run carries on', counts) : done(counts)
}

async function exportPart(cfg) {
	if (cfg.memory !== true) return skipped('session memory is off')
	if (!existsSync(memoryDbPath()) && captureLowerBound(cfg) === null) return skipped('nothing captured yet')
	const { errorCode, openMemory } = await import('./memory-db.mjs')
	const { assertOutsideBrain, exportSessions } = await import('./memory-export.mjs')
	assertOutsideBrain(sessionsMdDir(), cfg.clone)
	const { icloudRefusal } = await import('./auto-backup.mjs')
	const refusal = icloudRefusal(cfg)
	if (refusal) return { ...failed(refusal), icloud: true }
	let db
	try {
		db = openMemory(memoryDbPath(), { readOnly: true })
	} catch (e) {
		return failed(`the database did not open (${errorCode(e)})`)
	}
	try {
		const r = exportSessions(db, { root: sessionsMdDir() })
		const counts = { sessions: r.sessions, written: r.written, unchanged: r.unchanged, kept: r.kept, bytes: r.bytes }
		return r.errors ? failed(`${r.errors} session file(s) could not be written (${r.lastErrorCode})`, counts) : done(counts)
	} finally {
		db.close()
	}
}

/** The source type of a learning folder: where the Brain already has it, else its meta.json, else `manual`. */
function typeOf(abs, folder, inClone) {
	if (inClone.has(folder)) return inClone.get(folder)
	try {
		const type = JSON.parse(readFileSync(join(abs, 'meta.json'), 'utf8')).source_type
		if (typeof type === 'string' && type) return type
	} catch { /* no meta.json: the notes still go */ }
	return 'manual'
}

/** Whether a folder holds a file the Brain's copy doesn't have, or has differently. Compared by content, so a restored folder isn't new. */
function differs(abs, keep, cloneDir) {
	return keep.some((name) => {
		try {
			return !readFileSync(join(abs, name)).equals(readFileSync(join(cloneDir, name)))
		} catch {
			return true
		}
	})
}

async function libraryPart(cfg, { libraryAdd }) {
	if (cfg.library !== true) return skipped('the library is off')
	const root = process.env.YT_LEARN_ROOT || join(homedir(), 'Documents', 'youtube-learning')
	if (!existsSync(root)) return skipped('no learning folder yet')
	const inClone = new Map(listLibrary(cfg.clone, () => '').map((l) => [l.folder, l.type]))
	let added = 0
	const problems = []
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue
		const abs = join(root, entry.name)
		try {
			const { keep } = pickFiles(abs)
			if (!keep.length) continue
			const type = typeOf(abs, entry.name, inClone)
			if (!differs(abs, keep, join(cfg.clone, libraryPath(type, entry.name)))) continue
			await libraryAdd(abs, type)
			added++
		} catch (e) {
			problems.push(`${entry.name}: ${e.message}`)
		}
	}
	const counts = { added, ...(problems.length ? { failed: problems.length } : {}) }
	return problems.length ? failed(`${problems.length} folder(s) not backed up. ${problems[0]}`, counts) : done(counts)
}

async function configPart(cfg, { configBackup }) {
	if (cfg.library !== true) return skipped('the library is off')
	const r = await configBackup()
	return done({ kept: r.kept, leftOut: r.leftOut })
}

async function packPart(cfg) {
	const jobs = [
		...(cfg.memory === true ? [{ files: () => folderFiles(sessionsMdDir()), path: sessionsPackPath() }] : []),
		...(cfg.backup?.claudeDocs === true ? [{ files: () => folderFiles(claudeDocsDir()), path: extraPackPath('claude-docs') }] : []),
		...(cfg.backup?.projectMemory === true ? [{ files: () => projectMemoryFiles(projectsRoot()), path: extraPackPath('project-memory') }] : []),
	]
	if (!jobs.length) return skipped('nothing to pack is switched on')
	const counts = { files: 0, bytes: 0, changed: 0 }
	const problems = []
	for (const job of jobs) {
		try {
			const r = packFolder(job.files(), job.path)
			counts.files += r.files
			counts.bytes += r.bytes
			counts.changed += r.changed ? 1 : 0
			if (r.tooBig) counts.tooBig = (counts.tooBig ?? 0) + r.tooBig
			if (r.unreadable) counts.unreadable = (counts.unreadable ?? 0) + r.unreadable
		} catch (e) {
			problems.push(`${basename(job.path)}: ${e.message}`)
		}
	}
	if (problems.length) return failed(problems[0], counts)
	if (counts.unreadable) return failed(`${counts.unreadable} file(s) could not be read, so they are not in the pack`, counts)
	return counts.files ? done(counts) : skipped('no files to pack yet')
}

/** The vault's context with its real storage and Keychain, unless a test gives its own. Null when there is no vault. */
async function vaultContext(cfg, deps) {
	const { parseVaultConfig } = await import('./vault-manifest.mjs')
	const v = parseVaultConfig(cfg)
	if (!v) return null
	const given = deps.vault ?? {}
	const { vaultClone } = await import('./vault.mjs')
	return {
		storage: given.storage ?? (await import('./vault-storage.mjs')).githubStorage(v.repo),
		keystore: given.keystore ?? (await import('./vault-crypto.mjs')).keystore,
		clone: given.clone ?? vaultClone(),
		...(deps.now ? { now: deps.now } : {}),
		...given,
		cfg: v,
		log: () => {},
	}
}

/** A database's size and time, with its -wal's when that holds anything: an empty one comes and goes with every read-only open. Null when it isn't a plain file. */
function sourceMark(path) {
	const st = lstatSync(path, { throwIfNoEntry: false })
	if (!st?.isFile()) return null
	const wal = statSync(`${path}-wal`, { throwIfNoEntry: false })
	return { size: st.size, mtimeMs: st.mtimeMs, ...(wal?.size ? { walSize: wal.size, walMtimeMs: wal.mtimeMs } : {}) }
}

const sameMark = (a, b) => !!a && !!b && ['size', 'mtimeMs', 'walSize', 'walMtimeMs'].every((k) => a[k] === b[k])

/**
 * Databases whose source hasn't changed since their last upload stay put and are counted; `vault backup` by hand has no such check. The marks live
 * in status.vaultSources, written only after an upload is checked and listed, and an item gone from the manifest goes up again. Uploading nothing is
 * skipped, never a success. The memory database itself left out while memory is on is a failure.
 */
async function vaultPart(cfg, deps, { status }) {
	const ctx = await vaultContext(cfg, deps)
	if (!ctx) return skipped('no vault set up')
	const { databases } = ctx.cfg
	if (!databases.length && !deps.videos) return skipped('no databases to back up')
	const { backup, ownManifest } = await import('./vault.mjs')
	const listed = new Set(ownManifest(ctx).items.map((i) => i.id))
	const known = status.vaultSources ?? {}
	const marks = new Map(databases.map((p) => [p, sourceMark(p)]))
	const stays = (p) => sameMark(marks.get(p), known[p]) && listed.has(known[p].id)
	const toSend = databases.filter((p) => !stays(p))
	const unchanged = databases.length - toSend.length
	const r = toSend.length || deps.videos
		? await backup({ ...ctx, cfg: { ...ctx.cfg, databases: toSend } }, deps.videos ? { yes: true } : { yes: true, databases: true })
		: { uploaded: [], skipped: [] }
	const sources = Object.fromEntries(databases.filter(stays).map((p) => [p, known[p]]))
	for (const item of r.uploaded) {
		// Marked before the upload, so a write during it goes up next time. A resumed snapshot is from an earlier run and says nothing about the file today, so it goes up again.
		if (item.kind === 'database' && !item.resumed && marks.get(item.path)) sources[item.path] = { ...marks.get(item.path), id: item.id }
	}
	status.vaultSources = sources
	const counts = { uploaded: r.uploaded.length, unchanged, skipped: r.skipped.length, bytes: r.uploaded.reduce((a, u) => a + u.size, 0) }
	const memoryName = basename(memoryDbPath())
	const memoryLeft = cfg.memory === true ? r.skipped.find((s) => s.name === memoryName) : null
	if (memoryLeft) {
		const { readStatus } = await import('./memory-note.mjs')
		if (memoryLeft.why === 'symlink' || typeof readStatus().lastWriteAt === 'number') return failed(`${memoryName} was not backed up: ${memoryLeft.why}`, counts)
	}
	if (r.uploaded.length) return done(counts)
	return skipped(`nothing uploaded: ${[...(unchanged ? [`${unchanged} unchanged`] : []), ...r.skipped.map((s) => `${s.name} ${s.why}`)].join('; ')}`, counts)
}

/** The newest memory database in the vault comes back into a fresh folder through the real restore, is checked and counted, and the folder goes. */
async function restorePart(cfg, deps, { status, now }) {
	const ctx = await vaultContext(cfg, deps)
	if (!ctx) return skipped('no vault set up')
	const last = status.parts?.restore?.lastSuccessAt
	if (typeof last === 'number' && now - last <= RESTORE_EVERY) return skipped('not due')
	const { list, prepare } = await import('./vault.mjs')
	if (!existsSync(join(ctx.clone, '.git'))) return overdueSkip('no vault clone on this Mac')
	const name = basename(memoryDbPath())
	const item = list(ctx).filter((i) => i.kind === 'database' && i.name === name).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
	if (!item) return cfg.memory === true ? overdueSkip(`no ${name} in the vault yet`) : skipped(`no ${name} in the vault yet`)
	const { stagingDir, freeBytes } = prepare(ctx)
	mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
	if (item.size > MAX_SHARE_OF_FREE * freeBytes(stagingDir)) return overdueSkip('the snapshot is over 25% of free disk', { bytes: item.size })
	const { restore } = await import('./vault-restore.mjs')
	const to = join(stagingDir, `restore-test-${randomBytes(6).toString('hex')}`) // a killed run's folder here is cleared by the next vault run
	try {
		await restore(ctx, { id: item.id, to })
		const db = new DatabaseSync(join(to, item.name), { readOnly: true })
		try {
			const verdict = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]).join('; ')
			if (verdict !== 'ok') return failed('the restored database failed its integrity check')
			const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n
			return done({ messages: count('messages'), sessions: count('sessions'), bytes: item.size })
		} finally {
			db.close()
		}
	} finally {
		rmSync(to, { recursive: true, force: true })
	}
}

/** The parts for backupAll, each taking { status, now }. deps: { libraryAdd, configBackup, vault (test seams), videos, now }. */
export function realParts(cfg, deps) {
	return {
		capture: () => capturePart(cfg),
		export: () => exportPart(cfg),
		library: () => libraryPart(cfg, deps),
		config: () => configPart(cfg, deps),
		pack: () => packPart(cfg),
		vault: (run) => vaultPart(cfg, deps, run),
		restore: (run) => restorePart(cfg, deps, run),
	}
}

