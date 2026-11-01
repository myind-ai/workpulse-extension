// The record of `wp-brain backup-all`, and the one line session start gives when a part has stopped. The session-start hook imports this
// file, so it stays light: built-ins and claude-files.mjs only. That line reads one small file and writes nothing.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { backupStatusPath } from './claude-files.mjs'

export const PARTS = ['capture', 'export', 'library', 'config', 'pack', 'vault', 'restore']
export const label = (name) => (name === 'restore' ? 'restore test' : name)
export const isTime = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0
const DAY = 86_400_000
const STALE = 3 * DAY
const RESTORE_OVERDUE = 30 * DAY

/** The status: {} when there is none, { damaged: true } when it can't be read. */
export function readBackupStatus() {
	let text
	try {
		text = readFileSync(backupStatusPath(), 'utf8')
	} catch {
		return {}
	}
	try {
		const parsed = JSON.parse(text)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { damaged: true }
	} catch {
		return { damaged: true }
	}
}

export function writeBackupStatus(status) {
	const path = backupStatusPath()
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const tmp = `${path}.${process.pid}.tmp`
	try {
		writeFileSync(tmp, `${JSON.stringify(status, null, '\t')}\n`, { mode: 0o600 })
		chmodSync(tmp, 0o600)
		renameSync(tmp, path)
	} catch (e) {
		rmSync(tmp, { force: true })
		throw e
	}
}

/** The parts that need saying: no success for 3 days, a failed restore test at once and until one passes, or one due and skipped for over 30 days. A part that is turned off is quiet. Only known names. */
export function staleParts(status, now = Date.now()) {
	const out = []
	for (const name of PARTS) {
		const p = status?.parts?.[name]
		if (!p || typeof p !== 'object') continue
		if (name === 'restore') {
			if (p.state === 'failed' || isTime(p.failedAt) || (isTime(p.dueSkippedSince) && now - p.dueSkippedSince > RESTORE_OVERDUE)) out.push(name)
			continue
		}
		if (p.state === 'skipped') continue
		const since = isTime(p.lastSuccessAt) ? p.lastSuccessAt : p.firstTriedAt
		if (isTime(since) && now - since > STALE) out.push(name)
	}
	return out
}

/** One line for session start, or null. Silent when the schedule was never turned on and no backup ever ran. */
export function staleBackupLine({ now = Date.now() } = {}) {
	const status = readBackupStatus()
	if (status.damaged) return 'WARNING: the backup record could not be read. Run: wp-brain backup-all'
	if (!isTime(status.lastRunAt) && isTime(status.scheduleOnAt) && now - status.scheduleOnAt > STALE) return 'WARNING: the daily backup is on but has not run for 3 days or more. Run: wp-brain backup status'
	const parts = staleParts(status, now)
	const refused = status.parts?.export?.icloud === true // told at once: nothing has been written since the first refusal, and the owner should know why
	if (refused && parts.every((name) => name === 'export')) return 'WARNING: session files are not being written, as that folder syncs to iCloud. Run: wp-brain backup status'
	const named = refused ? PARTS.filter((name) => name === 'export' || parts.includes(name)) : parts
	return named.length ? `WARNING: backup not succeeding (3+ days, or a failed or overdue restore test): ${named.map((name) => (refused && name === 'export' ? 'export (iCloud)' : label(name))).join(', ')}. Run: wp-brain backup status` : null
}
