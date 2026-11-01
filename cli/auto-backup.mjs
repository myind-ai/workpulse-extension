// `wp-brain backup-all` and what it remembers: runs the parts in order, keeps each one's last result in backup-status.json, and says when
// something has stopped working. The parts themselves are in backup-parts.mjs, and the daily schedule in backup-schedule.mjs.
//
// The session-start hook reads backup-status.mjs, not this file, as this one reaches the vault. No session text is ever stored or printed
// here: a part's result is its state, a short reason and numbers, and a run started by the schedule prints no reason at all.

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { PARTS, isTime, label, readBackupStatus, staleBackupLine, staleParts, writeBackupStatus } from './backup-status.mjs'
import { backupStatusPath, captureLowerBound, claudeDocsDir, extraPackPath, mainTranscripts, memoryDbPath, projectsRoot, realPlace, sessionsMdDir, sessionsPackPath } from './claude-files.mjs'

export { PARTS, readBackupStatus, staleBackupLine, staleParts, writeBackupStatus }
const REASON_CHARS = 200

const minute = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

const numbers = (counts) => Object.fromEntries(Object.entries(counts ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)))

function record(status, name, result, at) {
	const old = status.parts?.[name] ?? {}
	const tried = result.state !== 'skipped'
	// A restore test not run for lack of disk or a clone says nothing new: an earlier failure stands, and being overdue is counted from here.
	const restore = name !== 'restore' ? {} : {
		...(result.state === 'failed' ? { failedAt: at } : result.due && old.failedAt ? { failedAt: old.failedAt } : {}),
		...(result.due ? { dueSkippedSince: old.dueSkippedSince ?? at } : {}),
	}
	status.parts = {
		...status.parts,
		[name]: {
			state: result.state,
			at,
			lastSuccessAt: result.state === 'done' ? at : old.lastSuccessAt ?? null,
			firstTriedAt: old.firstTriedAt ?? (tried ? at : null),
			...(result.reason ? { reason: result.reason } : {}),
			...(result.icloud ? { icloud: true } : {}),
			counts: result.counts ? numbers(result.counts) : old.counts ?? {},
			...restore,
		},
	}
}

// ── iCloud ──────────────────────────────────────────────────────────────────

const desktopSync = () => {
	if (process.env.WP_ICLOUD_DESKTOP !== undefined) return process.env.WP_ICLOUD_DESKTOP === '1'
	if (process.platform !== 'darwin') return false
	const r = spawnSync('defaults', ['read', 'com.apple.finder', 'FXICloudDriveDesktop'], { encoding: 'utf8', timeout: 3000 })
	return r.status === 0 && r.stdout.trim() === '1'
}

/** One line when the readable files would sync to iCloud, else null. Desktop & Documents sync carries only those two folders, so WP_SESSIONS_MD elsewhere is a way out. */
export function icloudWarning(dir = sessionsMdDir()) {
	// Lower-cased: the Mac's disk ignores case, so ~/documents is ~/Documents.
	const place = realPlace(dir).toLowerCase()
	if (place.includes('/library/mobile documents/')) return 'WARNING: plain session text would leave this machine: this folder syncs to iCloud'
	const home = realPlace(homedir()).toLowerCase()
	const carried = ['documents', 'desktop'].some((name) => `${place}/`.startsWith(`${join(home, name)}/`))
	return carried && desktopSync() ? 'WARNING: plain session text would leave this machine: iCloud Desktop & Documents is on' : null
}

/** Why export must not write plain text, or null. `backup.allowICloud` is the owner's own choice otherwise. */
export function icloudRefusal(cfg, dir = sessionsMdDir()) {
	if (cfg?.backup?.allowICloud === true) return null
	const warning = icloudWarning(dir)
	return warning && `${warning.replace(/^WARNING: /, '')}. Nothing written. To allow: "backup": {"allowICloud": true} in brain.json, or WP_SESSIONS_MD to a folder that does not sync`
}

/** The iCloud question exists only for someone with session text to sync: memory on, or a Markdown folder already there. Asked of nobody else, so nobody else pays for `defaults`. */
const icloudApplies = (cfg) => cfg?.memory === true || existsSync(sessionsMdDir())

/** What `backup status` and `doctor` say about iCloud, or null when it doesn't apply. */
function icloudState(cfg) {
	if (!icloudApplies(cfg)) return null
	const warning = icloudWarning()
	if (warning && cfg?.backup?.allowICloud === true) return { ok: true, detail: 'allowed by backup.allowICloud: session files sync to iCloud' }
	return { ok: !warning, detail: warning ?? 'no sign of it' }
}

// ── running it ──────────────────────────────────────────────────────────────

const countText = (counts) => Object.entries(counts ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')

/** A reason safe to keep: one line, cut short, and withheld whole when it looks like it holds a secret. */
function safeReason(text, fileSecretsIn) {
	const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
	if (!flat) return ''
	return fileSecretsIn(flat).length ? 'withheld: it looked like it held a secret' : flat.replaceAll(homedir(), '~').slice(0, REASON_CHARS)
}

/** Runs one part with the console shut: a part's own lines can name folders, and a scheduled log holds counts only. */
async function runPart(fn, args) {
	const { log, error } = console
	console.log = () => {}
	console.error = () => {}
	try {
		return await fn(args)
	} catch (e) {
		return { state: 'failed', reason: e.message }
	} finally {
		console.log = log
		console.error = error
	}
}

/**
 * Every part, in order, each reporting done, skipped or failed. One failing never stops the rest. Each result is stored as it comes, so a
 * killed run keeps what it did. Returns { results, failed }. `scheduled` prints numbers only.
 */
export async function backupAll({ cfg, parts, print = console.log, now = Date.now, scheduled = false }) {
	const { withLock } = await import('./vault.mjs')
	const { fileSecretsIn } = await import('./library.mjs')
	const lockCtx = { stagingDir: join(dirname(backupStatusPath()), 'backup-all-run') }
	const whole = async () => {
		const status = readBackupStatus()
		if (status.damaged) delete status.damaged
		const results = []
		for (const name of PARTS) {
			const result = await runPart(parts[name], { status, now: now(), cfg })
			const clean = { name, state: result.state ?? 'failed', reason: safeReason(result.reason, fileSecretsIn), counts: numbers(result.counts), ...(result.due ? { due: true } : {}), ...(result.icloud ? { icloud: true } : {}) }
			results.push(clean)
			record(status, name, { ...clean, counts: result.counts ? clean.counts : undefined }, now())
			status.lastRunAt = now()
			try {
				writeBackupStatus(status)
			} catch (e) {
				print(`could not save the backup status (${e.code ?? 'error'})`)
			}
			print(`${label(name).padEnd(13)} ${clean.state.padEnd(8)} ${[countText(clean.counts), scheduled ? '' : clean.reason].filter(Boolean).join('  ')}`.trimEnd())
		}
		const warning = icloudApplies(cfg) ? icloudWarning() : null
		if (warning) print(warning)
		const failed = results.filter((r) => r.state === 'failed').map((r) => r.name)
		print(failed.length ? `Failed: ${failed.map(label).join(', ')}` : `Backup finished: ${results.filter((r) => r.state === 'done').length} done, ${results.filter((r) => r.state === 'skipped').length} skipped.`)
		return { results, failed }
	}
	try {
		return await withLock(lockCtx, whole)
	} catch (e) {
		if (e.code !== 'ERR_VAULT_BUSY' || e.lockPath !== join(lockCtx.stagingDir, '.lock')) throw e
		throw new Error(`A backup-all is already running. If it is not, delete ${join(lockCtx.stagingDir, '.lock')} and run again.`, { cause: e })
	}
}

// ── what `backup status` and `doctor` say ───────────────────────────────────

const WIDTH = 80
const fit = (line) => {
	const chars = [...line]
	return chars.length > WIDTH ? `${chars.slice(0, WIDTH - 1).join('')}…` : line
}

function size(n) {
	if (n < 1024) return `${n} B`
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
	return `${(n / 1024 ** 3).toFixed(1)} GB`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

function partDetail(name, p) {
	if (!p) return 'never run'
	const ok = isTime(p.lastSuccessAt) ? `last success ${minute(p.lastSuccessAt)}` : 'no success yet'
	if (p.state === 'skipped' && name !== 'restore') return `${ok}${p.reason ? `; ${p.reason}` : ''}`
	if (p.state === 'failed') return `${ok}${p.reason ? `; ${p.reason}` : ''}`
	const counts = name === 'restore' ? countText(p.counts) : ''
	return [ok, p.state === 'skipped' ? p.reason : '', counts].filter(Boolean).join('; ')
}

const packPaths = (cfg) => [...(cfg?.memory === true ? [memoryDbPath(), `${memoryDbPath()}-wal`, sessionsPackPath()] : []), ...(cfg?.backup?.claudeDocs === true ? [extraPackPath('claude-docs')] : []), ...(cfg?.backup?.projectMemory === true ? [extraPackPath('project-memory')] : [])]

/** What is not backed up yet, as counts and sizes. Reads file times only. */
async function pendingLines(cfg, status) {
	if (cfg?.memory !== true) return ['Not exported: not judged, session memory is off']
	const success = (name) => status.parts?.[name]?.lastSuccessAt ?? 0
	const lower = captureLowerBound(cfg) ?? 0
	const sessions = mainTranscripts(projectsRoot()).filter((t) => t.mtimeMs > Math.max(success('export'), lower))
	const { folderFiles } = await import('./session-pack.mjs')
	const packedAt = success('pack')
	const md = folderFiles(sessionsMdDir()).map((f) => statSync(f.abs, { throwIfNoEntry: false })).filter((st) => st && st.mtimeMs > packedAt)
	const lines = [
		`Not exported: ${plural(sessions.length, 'session file')}, ${size(sessions.reduce((a, t) => a + t.size, 0))} newer than the last export`,
		`Not packed: ${plural(md.length, 'file')}, ${size(md.reduce((a, st) => a + st.size, 0))} newer than the pack`,
	]
	if (!cfg.vault) lines.push('Not in the vault: all of it, no vault is set up')
	else {
		const changed = packPaths(cfg).map((p) => statSync(p, { throwIfNoEntry: false })).filter((st) => st && st.mtimeMs > success('vault'))
		lines.push(`Not in the vault: ${plural(changed.length, 'file')}, ${size(changed.reduce((a, st) => a + st.size, 0))} changed since its last backup`)
	}
	return lines
}

/** Whether a switch is on: the two folders stay out until the owner answers. Someone with neither memory nor a vault has no such choice to make. */
const leftOutLines = (cfg) => cfg?.memory !== true && !cfg?.vault ? [] : [
	...(cfg?.backup?.claudeDocs === true ? [] : [`Left out (owner's choice): ${claudeDocsDir().replace(homedir(), '~')}`]),
	...(cfg?.backup?.projectMemory === true ? [] : ["Left out (owner's choice): project memory"]),
]

/** `wp-brain backup status`: one screen, no text. */
export async function backupStatusLines(cfg, { now = Date.now(), cliPath } = {}) {
	const status = readBackupStatus()
	const lines = [`Backup status, ${minute(now)} UTC${status.damaged ? ': the record could not be read' : ''}`]
	for (const name of PARTS) {
		const p = status.parts?.[name]
		lines.push(`${label(name).padEnd(13)} ${(p?.state ?? 'never').padEnd(8)} ${partDetail(name, p)}`)
	}
	lines.push(...(await pendingLines(cfg, status)))
	const leftOut = status.parts?.config?.counts?.leftOut
	lines.push(`Left out of config backup: ${typeof leftOut === 'number' ? `${plural(leftOut, 'file')} (sensitive names, configSkip)` : 'not known until it runs'}`)
	const tooBig = status.parts?.pack?.counts?.tooBig
	if (tooBig) lines.push(`Left out of packs: ${plural(tooBig, 'file')} over 32 MiB`)
	lines.push(...leftOutLines(cfg))
	const icloud = icloudState(cfg)
	if (icloud) lines.push(`iCloud: ${icloud.detail}`)
	const { scheduleState, scheduleText } = await import('./backup-schedule.mjs')
	lines.push(`Schedule: ${scheduleText(scheduleState(cliPath))}`)
	const stale = staleParts(status, now)
	if (stale.length) lines.push(`WARNING: not succeeding: ${stale.map(label).join(', ')}`)
	return lines.map(fit)
}

/** The rows of `wp-brain doctor`. Never critical: a backup that stopped is loud, but it isn't a broken link. */
export async function backupRows({ cfg, now = Date.now(), cliPath } = {}) {
	const row = (ok, what, detail) => ({ ok, what, detail, critical: false })
	const status = readBackupStatus()
	const rows = []
	if (status.damaged) rows.push(row(false, 'Backup', `the record at ${backupStatusPath()} could not be read: wp-brain backup-all`))
	else if (!isTime(status.lastRunAt)) rows.push(row(true, 'Backup', 'never run: wp-brain backup-all'))
	else {
		const stale = new Set(staleParts(status, now))
		for (const name of PARTS) {
			const p = status.parts?.[name]
			rows.push(row(p?.state !== 'failed' && !stale.has(name), `Backup ${label(name)}`, `${p?.state ?? 'never'}: ${partDetail(name, p)}`))
		}
	}
	const icloud = icloudState(cfg)
	if (icloud) rows.push(row(icloud.ok, 'Backup iCloud', icloud.detail))
	const { scheduleState, scheduleText } = await import('./backup-schedule.mjs')
	const schedule = scheduleState(cliPath)
	rows.push(row(!schedule.problem, 'Backup schedule', scheduleText(schedule)))
	return rows
}
