// The session-memory hook: node "<path>/cli/memory-hook.mjs" session-start|stop|session-end [--plugin]
//
// Starts the capture worker in the background and returns. Session start also gives the last-session note; Stop may ask for a
// summary (a documented block, one extra turn, at most two a session) from small files alone, never opening the database. Capture is off unless brain.json says "memory": true.
// While off it reads nothing but brain.json, prints nothing and starts nothing. A missing or broken file is off too, with one exception: a run without --plugin can only be
// the copy `memory on` installed, so that person opted in, and session start tells them nothing is being captured.
//
// It catches everything and exits 0. The copy `memory on` puts in settings.json carries no `2>/dev/null || true`: for someone
// who turned this on, a broken `node` should show as a hook error, because swallowing that is how capture goes quiet. The
// plugin's copy does swallow it, as everyone with the plugin runs it, on or off. It stands aside only for a settings copy that can run.
//
// An old `node` on PATH must reach the warning, not crash where nobody sees: nothing here is newer than Node 14 can parse
// (no `?.`, `??` or top-level await), built-ins are imported without the `node:` prefix, and claude-files.mjs loads only
// after the version check. It must stay cheap: never load wp-brain.mjs or bridge.ts here (plan: 156 ms against 92 ms for node).

import { spawn } from 'child_process'
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { isatty } from 'tty'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const NEEDS = [22, 18]
const SAFE_ID = /^[\w-]+$/ // what the worker accepts, and all that can go into a file name
const SETTINGS_EVENT = { 'session-start': 'SessionStart', stop: 'Stop', 'session-end': 'SessionEnd' }
const CANNOT_READ = 'WARNING: session memory cannot read brain.json, so nothing is being captured.'
const MAX_MISSED_ARG = 200 // sessions named to the worker's log; the warning's count is not capped, and an argument can't grow without limit

/** brain.json when capture is on, null when it says off, undefined when it can't be read as a config. Only the exact value true is on. */
function captureConfig() {
	const path = process.env.WP_BRAIN_CONFIG || join(homedir(), '.config', 'workpulse', 'brain.json')
	try {
		const cfg = JSON.parse(readFileSync(path, 'utf8'))
		if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return undefined
		return cfg.memory === true ? cfg : null
	} catch {
		return undefined
	}
}

function nodeIsTooOld(version) {
	const [major, minor] = version.split('.').map(Number)
	return major < NEEDS[0] || (major === NEEDS[0] && minor < NEEDS[1])
}

/** Starts the worker and lets it go: this process doesn't wait, and the worker outlives it. */
export function spawnWorker(args) {
	const script = process.env.WP_MEMORY_WORKER || join(here, 'memory-capture.mjs')
	const child = spawn(process.execPath, [script].concat(args), { detached: true, stdio: 'ignore' })
	child.on('error', () => {}) // the next session start notices what was not captured
	child.unref()
}

function hookInput() {
	if (isatty(0)) return {} // run by hand: nothing is coming
	try {
		const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
		return input && typeof input === 'object' ? input : {}
	} catch {
		return {}
	}
}

/** The session this hook fired for. No usable id means nothing to start: the next sweep finds the file anyway. */
function captureSession(files, input) {
	const id = input.session_id
	if (typeof id !== 'string' || !SAFE_ID.test(id)) return
	const given = input.transcript_path
	const path = typeof given === 'string' && given ? given : files.findTranscript(files.projectsRoot(), id)
	if (!path) return
	spawnWorker(['--session', id, '--transcript', path])
}

/** Catches up from when capture started or last resumed. A flag set by hand with no date never sweeps the whole backlog.
 * The hook opens the database read-only, so what it found goes to the worker, which logs it. */
function sweep(cfg, files, missed, noteTokens) {
	const since = files.captureLowerBound(cfg)
	const args = since === null ? [] : ['--since', String(since)]
	if (since !== null && missed.length) args.push('--missed', JSON.stringify(missed.slice(0, MAX_MISSED_ARG).map((m) => ({ sessionId: m.sessionId, path: m.path }))))
	if (noteTokens) args.push('--note-shown', String(noteTokens))
	if (args.length) spawnWorker(args)
}

function say(text) {
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }))
}

/** Too old to run capture, and maybe to load anything at all: then the plain words, without a count. */
async function warnTooOld(cfg, version) {
	let text = null
	try {
		text = (await (await import('./memory-note.mjs')).captureCheck(cfg, { tooOld: true })).text
	} catch { /* below */ }
	say(text || `WARNING: session memory cannot run on Node ${version} (it needs ${NEEDS.join('.')} or newer), so nothing is being captured.`)
}

/** What capture missed, before the sweep hides it, and the list for the sweep. A check that can't run says that too: quiet is what "healthy" looks like. */
async function missedCheck(cfg) {
	try {
		return await (await import('./memory-note.mjs')).captureCheck(cfg)
	} catch {
		return { text: 'WARNING: session memory could not check its capture. Run: wp-brain memory status', missed: [] }
	}
}

/** One line when a backup part has stopped, on a fresh start only. It reads one small file and never runs a backup. */
async function backupLine(input) {
	try {
		const { freshStart } = await import('./memory-note.mjs')
		return freshStart(input) ? (await import('./backup-status.mjs')).staleBackupLine() : null
	} catch {
		return null
	}
}

/** The warning, the backup line and the last-session note, in one additionalContext, then the sweep. The note costs a git call and a read, and only on a fresh start. */
async function sessionStart(cfg, files, input) {
	const { text, missed } = await missedCheck(cfg)
	const backup = await backupLine(input)
	let note = null
	try {
		note = await (await import('./memory-note.mjs')).sessionNote(input, { besides: backup || '' })
	} catch { /* a missing note is not a failure of capture */ }
	const context = [text, backup, note && note.text].filter(Boolean).join('\n')
	if (context) say(context)
	sweep(cfg, files, missed, note && note.tokens)
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return null
	}
}

/** The asks so far: null when none is recorded, undefined for a file that isn't a good record. Only the hook writes it, whole, so a bad one is damage, and a cap that failed open would repeat on every Stop. */
function askRecord(path) {
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		return error.code === 'ENOENT' ? null : undefined
	}
	try {
		const asked = JSON.parse(text)
		return asked && Number.isInteger(asked.count) && asked.count >= 0 ? asked : undefined
	} catch {
		return undefined
	}
}

/** Asks Claude for the session's summary when it is due, reading only the worker's counts and this hook's own record; never the database.
 * The ask is recorded before it is made: one that can't be recorded would otherwise repeat every turn. */
async function askForSummary(files, input) {
	const id = input.session_id
	if (input.stop_hook_active || typeof id !== 'string' || !SAFE_ID.test(id)) return
	const dir = files.memorySessionsDir()
	const mark = readJson(join(dir, `${id}.memory.json`))
	if (!mark || typeof mark !== 'object') return
	const askPath = join(dir, `${id}.memory-ask.json`)
	const asked = askRecord(askPath)
	if (asked === undefined) return
	const { asCount, summaryAsk } = await import('./memory-note.mjs')
	const reason = summaryAsk({ ...mark, asked }, input)
	if (!reason) return
	const temp = `${askPath}.${process.pid}.tmp`
	try {
		writeFileSync(temp, JSON.stringify({ count: asCount(asked && asked.count) + 1, prompts: asCount(mark.prompts), commits: asCount(mark.commits) }))
		renameSync(temp, askPath) // never an empty file, which would read as damage
	} catch (error) {
		rmSync(temp, { force: true })
		throw error
	}
	process.stdout.write(JSON.stringify({ decision: 'block', reason }))
}

async function main([event, ...flags]) {
	if (!Object.keys(SETTINGS_EVENT).includes(event)) return
	const cfg = captureConfig()
	if (cfg === undefined && event === 'session-start' && !flags.includes('--plugin')) say(CANNOT_READ)
	if (!cfg) return
	const version = process.env.WP_MEMORY_NODE_VERSION || process.versions.node
	if (nodeIsTooOld(version)) {
		if (event === 'session-start') await warnTooOld(cfg, version)
		return
	}
	const files = await import('./claude-files.mjs')
	if (flags.includes('--plugin') && files.settingsRunsMemoryHook(SETTINGS_EVENT[event])) return
	const input = hookInput()
	// Another tool's worker session: nothing to capture, on any event.
	if (typeof input.transcript_path === 'string' && files.isExcludedProject(basename(dirname(input.transcript_path)))) return
	if (event === 'session-start') return sessionStart(cfg, files, input)
	captureSession(files, input)
	if (event === 'stop') await askForSummary(files, input)
}

function isMain() {
	try {
		return realpathSync(process.argv[1] || '') === fileURLToPath(import.meta.url)
	} catch {
		return false
	}
}

if (isMain()) main(process.argv.slice(2)).catch(() => {})
