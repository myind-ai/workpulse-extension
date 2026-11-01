// Where Claude Code keeps its session files, and how to list them. One place, shared by the timesheet
// (`scan-claude`, which reads only timestamps) and the session capture (which reads more, in its own module).
// Nothing here opens a file's contents.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** The folder Claude Code keeps its files in (CLAUDE_HOME, else CLAUDE_CONFIG_DIR, else ~/.claude). */
export const claudeDir = () => process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

/**
 * True when ~/.claude/settings.json already runs this hook itself (from `setup`). The plugin's copy of the hook then
 * stays quiet, so nothing runs twice.
 */
export function settingsRunHook(settingsText, mark) {
	try {
		const hooks = JSON.parse(settingsText || '{}').hooks ?? {}
		return Object.values(hooks).some((groups) => groups?.some?.((g) => g.hooks?.some((h) => String(h.command ?? '').includes(mark))))
	} catch {
		return false
	}
}

export const settingsHasHook = (mark) => {
	const p = join(claudeDir(), 'settings.json')
	return existsSync(p) && settingsRunHook(readFileSync(p, 'utf8'), mark)
}

/** Adds or replaces our hook on one event, leaving every other hook alone. */
export function placeHook(settings, event, command, mark, extra = {}) {
	const hooks = (settings.hooks ??= {})
	const list = (hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? '').includes(mark)) })).filter((g) => g.hooks.length)
	list.push({ hooks: [{ type: 'command', command, timeout: 15, ...extra }] })
	hooks[event] = list
	return settings
}

/** Takes our hook off one event (when you answer no on a re-run). */
export function removeHook(settings, event, mark) {
	if (!settings.hooks?.[event]) return settings
	const list = settings.hooks[event].map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? '').includes(mark)) })).filter((g) => g.hooks.length)
	if (list.length) settings.hooks[event] = list
	else delete settings.hooks[event]
	return settings
}

/** Marks a command as the session-memory hook. */
export const MEMORY_HOOK = 'memory-hook.mjs'

/** The memory hook's script on one event of a settings object (or a plugin's hooks.json): one path per command found. */
export function memoryHookScripts(settings, event) {
	const groups = settings?.hooks?.[event]
	if (!Array.isArray(groups)) return []
	return groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).map((h) => String(h?.command ?? '').match(/"([^"]*memory-hook\.mjs)"|(\S*memory-hook\.mjs)/)).filter(Boolean).map((m) => m[1] ?? m[2])
}

/** Whether settings.json runs the memory hook on this event from a script that exists. A copy pointing at a moved file can't run, so the plugin's must. */
export function settingsRunsMemoryHook(event) {
	try {
		return memoryHookScripts(JSON.parse(readFileSync(join(claudeDir(), 'settings.json'), 'utf8')), event).some((path) => existsSync(path))
	} catch {
		return false
	}
}

/** Where capture starts: the first `capture_since`, or the moment it was turned on again if later, so what ran while it was off stays out. Null without a usable `capture_since`. */
export function captureLowerBound(cfg) {
	const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0
	if (!valid(cfg?.capture_since)) return null
	return valid(cfg.capture_resumed_at) ? Math.max(cfg.capture_since, cfg.capture_resumed_at) : cfg.capture_since
}

/** The folder holding one sub-folder per project, each with its session files. */
export const projectsRoot = () => join(claudeDir(), 'projects')

/** The capture database: WP_MEMORY_DB, else ~/.workpulse/memory/memory.db. */
export const memoryDbPath = () => process.env.WP_MEMORY_DB || join(homedir(), '.workpulse', 'memory', 'memory.db')

/** A folder's real place, for one that may not exist yet. */
export function realPlace(dir) {
	let d = resolve(dir)
	const rest = []
	while (!existsSync(d) && dirname(d) !== d) {
		rest.unshift(basename(d))
		d = dirname(d)
	}
	try {
		return join(realpathSync(d), ...rest)
	} catch {
		return resolve(dir)
	}
}

/** The readable session files: WP_SESSIONS_MD, else ~/Documents/claude-sessions. Export refuses a folder under the Brain clone. */
export const sessionsMdDir = () => process.env.WP_SESSIONS_MD || join(homedir(), 'Documents', 'claude-sessions')

/** The readable session files as one SQLite file the vault can carry: WP_SESSIONS_PACK, else beside the database. */
export const sessionsPackPath = () => process.env.WP_SESSIONS_PACK || join(dirname(memoryDbPath()), 'session-files.db')

/** Another folder's pack, beside the session pack. */
export const extraPackPath = (name) => join(dirname(sessionsPackPath()), `${name}.db`)

/** `~/Documents/claude-docs`: packed only when `backup.claudeDocs` is true. */
export const claudeDocsDir = () => process.env.WP_CLAUDE_DOCS || join(homedir(), 'Documents', 'claude-docs')

/** Each backup part's last result: WP_BACKUP_STATUS, else beside the database. Names, times and counts, no session text. */
export const backupStatusPath = () => process.env.WP_BACKUP_STATUS || join(dirname(memoryDbPath()), 'backup-status.json')

/** Where the per-session files live: `<id>.memory.json` (the worker's counts) and `<id>.memory-ask.json` (the Stop hook's asks). */
export const memorySessionsDir = () => process.env.WP_BRAIN_SESSIONS || join(homedir(), '.workpulse', 'sessions')

/** A git command's output in a folder, or null. Never inherits a repo from the environment. */
export function gitIn(dir, args, input) {
	const env = { ...process.env }
	for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
	const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', input, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'], env })
	return r.status === 0 ? r.stdout : null
}

export const stripWorktree = (cwd) => cwd.replace(/\/\.claude\/worktrees\/[^/]+(?=\/|$)/, '')

const repoCache = new Map()
/** The main checkout of a folder: a worktree is the same repo. If git cannot say (the folder is gone): cwd without its worktree part. */
export function repoKey(cwd) {
	if (typeof cwd !== 'string' || !cwd) return null
	if (repoCache.has(cwd)) return repoCache.get(cwd)
	let key = stripWorktree(cwd)
	if (existsSync(cwd)) {
		const common = gitIn(cwd, ['rev-parse', '--git-common-dir'])?.trim()
		if (common) {
			try { key = dirname(realpathSync(resolve(cwd, common))) } catch { /* keep the fallback */ }
		}
	}
	repoCache.set(cwd, key)
	return key
}

/** Every .jsonl under `dir`, subagent files included (the timesheet counts their activity too). */
export function claudeTranscriptFiles(dir, out = []) {
	if (!existsSync(dir)) return out
	for (const item of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, item.name)
		if (item.isDirectory()) claudeTranscriptFiles(path, out)
		else if (item.isFile() && item.name.endsWith('.jsonl')) out.push(path)
	}
	return out
}

/** Project folders that hold another tool's own worker sessions, not the owner's (`…--claude-mem-observer-sessions`).
 * A repo merely called claude-mem has a single dash before the name and stays in. */
export const isExcludedProject = (name) => /--claude-mem-/.test(name)

/** The session files of each project folder: top-level `.jsonl` only (no `subagents/`), excluded folders skipped. */
export function mainTranscripts(root) {
	const out = []
	let projects
	try { projects = readdirSync(root, { withFileTypes: true }) } catch { return out }
	for (const project of projects) {
		if (!project.isDirectory() || isExcludedProject(project.name)) continue
		let files
		try { files = readdirSync(join(root, project.name), { withFileTypes: true }) } catch { continue }
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
			const path = join(root, project.name, file.name)
			try {
				const st = statSync(path)
				out.push({ path, sessionId: basename(file.name, '.jsonl'), size: st.size, mtimeMs: st.mtimeMs, inode: st.ino })
			} catch { /* gone between listing and stat */ }
		}
	}
	return out
}

/** A session's file found by its name, for a hook given no path: the project folders are only checked, nothing is opened. Null when there is none. */
export function findTranscript(root, sessionId) {
	let projects
	try { projects = readdirSync(root, { withFileTypes: true }) } catch { return null }
	for (const project of projects) {
		if (!project.isDirectory() || isExcludedProject(project.name)) continue
		const path = join(root, project.name, `${sessionId}.jsonl`)
		if (existsSync(path)) return path
	}
	return null
}

/** The subagent files of a session file `<dir>/<id>.jsonl`: `<dir>/<id>/subagents/*.jsonl`. */
export function subagentFiles(mainPath) {
	const dir = join(mainPath.replace(/\.jsonl$/, ''), 'subagents')
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith('.jsonl')).map((f) => join(dir, f.name))
	} catch {
		return []
	}
}

/** The ticket key in a git branch: `fix/pay-2433-x` gives PAY-2433. */
export const ticketOf = (branch) => (branch || '').match(/\b([a-z]{2,10})-(\d{1,6})\b/i)?.slice(1, 3).join('-').toUpperCase() || undefined
