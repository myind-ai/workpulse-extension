// Session memory's switch and its doctor row: `wp-brain memory on|off`, the hooks in settings.json, the flag in brain.json.
// setup.mjs re-exports what its callers use. The hook itself is cli/memory-hook.mjs, and capture is cli/memory-capture.mjs.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { claudeDir, MEMORY_HOOK, memoryDbPath, memoryHookScripts, placeHook } from './claude-files.mjs'

const MEMORY_EVENTS = { SessionStart: 'session-start', Stop: 'stop', SessionEnd: 'session-end' }
const validSince = (n) => Number.isFinite(n) && n > 0

/** The session-memory hook on its three events, leaving every other hook alone. Quoted, as a path may hold a space. */
export function placeMemoryHooks(settings, hookPath) {
	for (const [event, arg] of Object.entries(MEMORY_EVENTS)) placeHook(settings, event, `node "${hookPath}" ${arg}`, MEMORY_HOOK)
	return settings
}

/** Whether brain.json says "memory": true; a missing or unreadable file means off, as it does for the hook. */
export function readMemory(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8')).memory === true
	} catch {
		return false
	}
}

/** brain.json as an object. Never guesses: a broken file stays as it is and the caller stops. */
export function brainConfig(path) {
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch {
		throw new Error(`${path} is missing. Link this machine first: wp-brain setup`)
	}
	let cfg
	try {
		cfg = JSON.parse(text)
	} catch (e) {
		throw new Error(`${path} is not valid JSON, so nothing was changed: ${e.message}`)
	}
	if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${path} does not hold a settings object, so nothing was changed.`)
	return cfg
}

/** Sets or clears the flag through a temp file, so a full disk can't leave a half-written brain.json, and a link stays a link. The first capture_since stays; turning on again records when, so the sweep skips what ran while off. */
export function writeMemoryFlag(path, on) {
	const cfg = brainConfig(path)
	if (on) {
		if (cfg.memory !== true && validSince(cfg.capture_since)) cfg.capture_resumed_at = Date.now()
		cfg.memory = true
		if (!validSince(cfg.capture_since)) cfg.capture_since = Date.now()
	} else delete cfg.memory
	const target = realpathSync(path)
	const tmp = `${target}.memory-partial`
	try {
		writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: statSync(target).mode & 0o777 })
		renameSync(tmp, target)
	} catch (e) {
		rmSync(tmp, { force: true })
		throw e
	}
}

/** Creates the database, or reports why it can't. A corrupt file is refused by openMemory and left in place. */
export async function makeMemoryDb() {
	const { openMemory } = await import('./memory-db.mjs')
	try {
		openMemory().close()
	} catch (e) {
		throw new Error(`Session memory can't open its database at ${memoryDbPath()}, which was left as it is, and nothing was changed (${e.message}).`)
	}
}

/** Refuses what `placeHook` can't merge, in words, before anything is written. */
export function checkHookShape(settings, settingsPath) {
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${settingsPath} does not hold a settings object, so nothing was changed.`)
	if (settings.hooks === undefined) return
	if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw new Error(`"hooks" in ${settingsPath} is not an object, so nothing was changed.`)
	for (const event of Object.keys(MEMORY_EVENTS)) {
		if (settings.hooks[event] !== undefined && !Array.isArray(settings.hooks[event])) throw new Error(`"hooks.${event}" in ${settingsPath} is not a list, so nothing was changed.`)
	}
}

/** Where the text goes, said at the moment of consent. */
export const memoryPlace = (cfg) => (cfg.vault?.repo
	? `It stays on this machine and also goes into your encrypted backups in ${cfg.vault.repo}`
	: 'It stays on this machine; if you turn on the vault, it also goes into its encrypted backups')

/**
 * `wp-brain memory on`. The flag goes last, so a failure on the way leaves it as it was. Settings change only in hooks. The
 * bare-command copy goes in whatever the plugin state: an older plugin has no such hook, and the plugin's copy stands aside for this one.
 */
export async function memoryOn({ config, hookPath }) {
	const cfg = brainConfig(config)
	const claude = claudeDir()
	const settingsPath = join(claude, 'settings.json')
	const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '{}'
	let settings
	try {
		settings = JSON.parse(before || '{}')
	} catch (e) {
		throw new Error(`${settingsPath} is not valid JSON, so nothing was changed: ${e.message}`)
	}
	checkHookShape(settings, settingsPath)
	await makeMemoryDb()
	const after = JSON.stringify(placeMemoryHooks(settings, hookPath), null, 2) + '\n'
	if (after !== before) {
		mkdirSync(claude, { recursive: true })
		if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.wp-brain.bak`)
		writeFileSync(settingsPath, after)
	}
	writeMemoryFlag(config, true)
	console.log(`Session memory on: from now on your prompts and answers are kept in ${memoryDbPath()}, secrets masked (a session still open and carried on is kept whole). ${memoryPlace(cfg)}. Hooks: ${settingsPath}. To stop: wp-brain memory off`)
}

/** `wp-brain memory off`. The installed hooks stay and do nothing; no data is touched. */
export function memoryOff({ config }) {
	writeMemoryFlag(config, false)
	console.log(`Session memory off: nothing new is captured, sessions run while it is off stay out, and everything already kept stays in ${memoryDbPath()}.`)
}

/** Whether the installed plugin's own hooks.json carries the memory hook on every event; an older version doesn't. */
export function pluginRunsMemory(claude, id) {
	try {
		const entry = [JSON.parse(readFileSync(join(claude, 'plugins', 'installed_plugins.json'), 'utf8')).plugins[id]].flat()[0]
		const hooks = JSON.parse(readFileSync(join(entry.installPath, 'hooks', 'hooks.json'), 'utf8'))
		return existsSync(join(entry.installPath, 'cli', MEMORY_HOOK)) && Object.keys(MEMORY_EVENTS).every((event) => memoryHookScripts(hooks, event).length > 0)
	} catch {
		return false
	}
}

/** The doctor's row. Off is neutral. On with hooks that can't run is a failure, because capture would stop with nobody told. */
export function memoryRow(cfg, settings, plugin, claude) {
	const dbPath = memoryDbPath()
	const bytes = [dbPath, `${dbPath}-wal`].reduce((sum, p) => sum + (statSync(p, { throwIfNoEntry: false })?.size ?? 0), 0)
	const held = existsSync(dbPath) ? `${(bytes / 1048576).toFixed(1)} MB` : null
	const scripts = Object.keys(MEMORY_EVENTS).map((event) => memoryHookScripts(settings, event))
	if (cfg?.memory !== true) {
		const notes = [held && `${held} kept`, scripts.flat().length > 0 && 'hooks installed, doing nothing'].filter(Boolean)
		return { ok: true, what: 'Session memory', detail: `off — prompts and answers are not kept${notes.length ? ` (${notes.join(', ')})` : ''}; turn on: wp-brain memory on`, critical: false }
	}
	let lastWrite = null
	try {
		lastWrite = JSON.parse(readFileSync(join(dirname(dbPath), 'status.json'), 'utf8')).lastWriteAt
	} catch { /* no run yet */ }
	const since = validSince(cfg.capture_since) ? ` since ${new Date(cfg.capture_since).toISOString().slice(0, 10)}` : ''
	const facts = `on${since} — ${validSince(lastWrite) ? `last write ${new Date(lastWrite).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'no write yet'}, ${held ?? 'no database'}`
	if (!held) return { ok: false, what: 'Session memory', detail: `${facts}: wp-brain memory on`, critical: true }
	const moved = scripts.flat().find((path) => !existsSync(path))
	if (moved) return { ok: false, what: 'Session memory', detail: `${facts}, but its hook points at ${moved}, which does not exist: run wp-brain memory on again`, critical: true }
	if (scripts.every((list) => list.length)) return { ok: true, what: 'Session memory', detail: `${facts}, hooks installed`, critical: false }
	if (plugin && pluginRunsMemory(claude, plugin)) return { ok: true, what: 'Session memory', detail: `${facts}, hooks from the plugin`, critical: false }
	return { ok: false, what: 'Session memory', detail: `${facts}, but no working hook runs it on every event, so nothing may be captured: run wp-brain memory on again`, critical: true }
}
