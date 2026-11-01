// The daily schedule for `wp-brain backup-all`: one macOS LaunchAgent, installed only when the owner says yes, removable.
// StartCalendarInterval, as macOS runs a missed one at the next wake. Low priority. Its log gets numbers only (`--scheduled`) and is 0600.
// launchd has a bare PATH and no shell, so the plist names node, the CLI and a PATH that finds git, gh and age. It holds paths, never a secret.
//
// WP_LAUNCH_AGENTS_DIR and WP_LAUNCHCTL are the tests' seams. A changed folder with no launchctl of its own is refused, so a test can't reach the real one.

import { spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { readBackupStatus, writeBackupStatus } from './backup-status.mjs'
import { backupStatusPath } from './claude-files.mjs'

export const LABEL = 'com.workpulse.backup-all'
const HOUR = 3
const MINUTE = 30
const KEPT_ENV = ['CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'WP_BRAIN_CONFIG', 'WP_BRAIN_SESSIONS', 'WP_MEMORY_DB', 'WP_SESSIONS_MD', 'WP_SESSIONS_PACK', 'WP_BACKUP_STATUS', 'YT_LEARN_ROOT', 'WP_CLAUDE_DOCS']

const agentsDir = () => process.env.WP_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents')
export const plistPath = () => join(agentsDir(), `${LABEL}.plist`)
const logPath = () => join(dirname(backupStatusPath()), 'backup-all.log')

function launchctl(args) {
	const seam = process.env.WP_LAUNCHCTL
	if (!seam && process.env.WP_LAUNCH_AGENTS_DIR) throw new Error('WP_LAUNCH_AGENTS_DIR is set with no WP_LAUNCHCTL, so the real launchctl was not called.')
	return spawnSync(seam || '/bin/launchctl', args, { encoding: 'utf8', timeout: 15_000 })
}

const domain = () => `gui/${process.getuid()}`
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** The plist's text. */
export function plistText({ node, cli, log, env = {} }) {
	const strings = (list) => list.map((s) => `\t\t<string>${xml(s)}</string>`).join('\n')
	const pairs = Object.entries(env).map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`).join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${strings([node, cli, 'backup-all', '--scheduled'])}
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>${HOUR}</integer>
		<key>Minute</key>
		<integer>${MINUTE}</integer>
	</dict>
	<key>ProcessType</key>
	<string>Background</string>
	<key>Nice</key>
	<integer>10</integer>
	<key>LowPriorityIO</key>
	<true/>
	<key>Umask</key>
	<integer>63</integer>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
	<key>EnvironmentVariables</key>
	<dict>
${pairs}
	</dict>
</dict>
</plist>
`
}

const toolPath = (node) => [...new Set([dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':')

/** `wp-brain backup schedule on`. A launchctl that refuses leaves no plist behind. */
export function scheduleOn({ cliPath, now = Date.now() }) {
	if (process.platform !== 'darwin' && !process.env.WP_LAUNCHCTL) throw new Error('The daily schedule needs macOS. Run wp-brain backup-all from your own scheduler.')
	const log = logPath()
	mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
	closeSync(openSync(log, 'a', 0o600))
	chmodSync(log, 0o600)
	const node = process.execPath
	const env = { PATH: toolPath(node), ...Object.fromEntries(KEPT_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]])) }
	const path = plistPath()
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, plistText({ node, cli: cliPath, log, env }), { mode: 0o644 })
	renameSync(tmp, path)
	launchctl(['bootout', `${domain()}/${LABEL}`]) // an older one may be loaded; not loaded is fine
	const r = launchctl(['bootstrap', domain(), path])
	if (r.status !== 0) {
		rmSync(path, { force: true })
		throw new Error(`launchctl did not load the schedule, so it stays off (${r.error?.code ?? `exit ${r.status}`}).`)
	}
	const status = readBackupStatus()
	writeBackupStatus({ ...(status.damaged ? {} : status), scheduleOnAt: now })
	return { path, log }
}

const NOT_LOADED = new Set([3, 113]) // launchctl's "no such process" and "could not find service"

/** `wp-brain backup schedule off`. Always asks launchctl, as a plist deleted by hand leaves the job loaded. Returns whether it was on. The log and the backups stay. Throws when launchctl fails, with the plist gone. */
export function scheduleOff() {
	const path = plistPath()
	const had = existsSync(path)
	const r = launchctl(['bootout', `${domain()}/${LABEL}`])
	rmSync(path, { force: true })
	const status = readBackupStatus()
	if (!status.damaged && status.scheduleOnAt !== undefined) {
		delete status.scheduleOnAt
		writeBackupStatus(status)
	}
	if (r.status === 0) return true
	if (NOT_LOADED.has(r.status) || r.error?.code === 'ENOENT') return had
	throw new Error(`launchctl could not unload the daily backup (${r.error?.code ?? `exit ${r.status}`}), so it may run until you log out. Its plist is gone.`)
}

/** What is installed: { on, problem }. `problem` names a node or CLI that moved, or another copy of the CLI. Reads the plist only. */
export function scheduleState(cliPath) {
	let text
	try {
		text = readFileSync(plistPath(), 'utf8')
	} catch {
		return { on: false, problem: null }
	}
	const args = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? ''
	const [node, cli] = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]))
	const missing = [node, cli].find((p) => !p || !existsSync(p))
	if (missing !== undefined) return { on: true, problem: `it points at ${missing || 'nothing'}, which does not exist: run wp-brain backup schedule on again` }
	if (cliPath && cli !== cliPath) return { on: true, problem: `it points at another copy, ${cli}: run wp-brain backup schedule on again` }
	return { on: true, problem: null }
}

/** The schedule's words for `backup status` and `doctor`. */
export function scheduleText(state) {
	if (!state.on) return 'off: wp-brain backup schedule on'
	const at = `${String(HOUR).padStart(2, '0')}:${String(MINUTE).padStart(2, '0')}`
	return state.problem ? `on, but ${state.problem}` : `on, daily at ${at}, or at the next wake`
}
