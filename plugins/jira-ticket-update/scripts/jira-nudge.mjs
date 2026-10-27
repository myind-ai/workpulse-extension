#!/usr/bin/env node
// Trigger and settings side of the jira-ticket-update plugin. It never talks to Jira: it notices work that
// should move a ticket (commit, PR opened, PR merged), reminds Claude to ASK, and reads/writes the settings.
//
//   node jira-nudge.mjs start            SessionStart hook: offer setup once in a repo that uses ticket keys but has no settings
//   node jira-nudge.mjs post             PostToolUse(Bash) hook: record commit / PR events per ticket key
//   node jira-nudge.mjs stop             Stop hook: once per session, ask to update tickets with unreported work
//   node jira-nudge.mjs clear KEY        after the ticket was updated (or the user said not now)
//   node jira-nudge.mjs list             what is pending
//   node jira-nudge.mjs config [DIR]     the settings that apply in DIR (team file over personal file), as JSON
//   node jira-nudge.mjs prefixes [DIR]   ticket prefixes this repo's history and branches use, most used first
//   node jira-nudge.mjs guess 'A,B,C'    a status mapping guessed from a workflow's transition names
//   node jira-nudge.mjs save team|personal '<json>'   merge settings into the team file or your personal file
//
// Settings, most specific first, merged:
//   <repo>/.claude/jira-ticket-update.json   team: committed once, every teammate gets it with git pull
//   <personal>/config.json                    you: site, cloudId, your own prefixes
// <personal> is $CLAUDE_PLUGIN_DATA when the plugin runs it, else ~/.claude/jira-ticket-update.

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PERSONAL = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'jira-ticket-update')
const STATE = join(PERSONAL, 'pending.json')
const OFFERED = join(PERSONAL, 'offered.json')
const TEAM_FILE = join('.claude', 'jira-ticket-update.json')
const NOT_KEYS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL', 'CVE', 'ES', 'MP', 'H', 'X', 'GPT', 'ECMA', 'WCAG', 'COVID', 'HEAD', 'V', 'PR', 'WIP'])
export const EVENTS = ['started', 'pr_opened', 'pr_merged', 'deployed_stage', 'done']

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`) }
const saveState = s => writeJson(STATE, s)
const stdin = () => { try { return JSON.parse(readFileSync(0, 'utf8') || '{}') } catch { return {} } }

function git(cwd, args) {
	try { return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 << 20 }).toString().trim() }
	catch { return '' }
}

export function configFor(cwd) {
	const root = git(cwd, 'rev-parse --show-toplevel')
	const team = root ? readJson(join(root, TEAM_FILE), null) : null
	const mine = readJson(join(PERSONAL, 'config.json'), {})
	return {
		site: team?.site || mine.site || '',
		cloudId: team?.cloudId || mine.cloudId || '',
		prefixes: [...new Set([...(team?.prefixes || []), ...(mine.prefixes || [])])],
		projects: { ...(mine.projects || {}), ...(team?.projects || {}) },
		sources: { team: root ? join(root, TEAM_FILE) : null, teamExists: !!team, personal: join(PERSONAL, 'config.json') },
	}
}

export function keysIn(text, prefixes = []) {
	const found = [...(text || '').matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g)]
		.filter(m => (prefixes.length ? prefixes.includes(m[1]) : !NOT_KEYS.has(m[1])))
		.map(m => `${m[1]}-${m[2]}`)
	return [...new Set(found)]
}

// Prefixes from what the repo already says: commit messages and branch names. A prefix must name at least
// two different tickets, so one stray "ABC-1" in a message isn't mistaken for a project.
export function prefixesFrom(text) {
	const tickets = new Map()
	for (const key of keysIn(text)) {
		const p = key.split('-')[0]
		tickets.set(p, (tickets.get(p) || new Set()).add(key))
	}
	return [...tickets].filter(([, s]) => s.size >= 2).sort((a, b) => b[1].size - a[1].size).map(([p, s]) => ({ prefix: p, tickets: s.size }))
}

export function repoPrefixes(cwd) {
	// Quoted: unquoted, the shell reads %(refname:short)'s parentheses as syntax, git never runs, and branches go uncounted.
	const text = `${git(cwd, 'log -400 --format=%s%n%b')}\n${git(cwd, "branch -a '--format=%(refname:short)'")}`
	return prefixesFrom(text)
}

// A first guess at which transition means what, from the names alone. Setup shows it for one "use these?";
// nothing is written to Jira from a guess.
const BACKWARDS = /reopen|back to|block|cancel|won'?t|reject|declin|on hold|stop/i
const WANTS = {
	started: [/^in progress$/i, /start|progress|doing|develop|working/i],
	pr_opened: [/code review/i, /review|pull request|\bpr\b/i],
	pr_merged: [/ready for (qa|test)/i, /merged|qa|test|verif/i],
	deployed_stage: [/stag|uat/i, /ready for (qa|test)|qa|test/i],
	done: [/^done$/i, /done|close|resolve|complete|release|ship/i],
}
export function guessMoves(names) {
	const usable = names.map(n => n.trim()).filter(n => n && !BACKWARDS.test(n))
	const moves = {}
	for (const event of EVENTS) {
		for (const re of WANTS[event]) {
			const hit = usable.find(n => re.test(n))
			if (hit) { moves[event] = hit; break }
		}
	}
	return moves
}

function merge(base, add) {
	const out = { ...base, ...add }
	if (base.prefixes || add.prefixes) out.prefixes = [...new Set([...(base.prefixes || []), ...(add.prefixes || [])])]
	if (base.projects || add.projects) {
		out.projects = { ...(base.projects || {}) }
		for (const [p, v] of Object.entries(add.projects || {})) {
			const old = out.projects[p] || {}
			out.projects[p] = { ...old, ...v, moves: { ...(old.moves || {}), ...(v.moves || {}) } }
		}
	}
	return out
}

export function save(where, json, cwd) {
	const add = typeof json === 'string' ? JSON.parse(json) : json
	let file
	if (where === 'team') {
		const root = git(cwd, 'rev-parse --show-toplevel')
		if (!root) throw new Error('not in a git repository: save personal instead')
		file = join(root, TEAM_FILE)
	} else if (where === 'personal') file = join(PERSONAL, 'config.json')
	else throw new Error('save team|personal')
	const next = merge(readJson(file, {}), add)
	writeJson(file, next)
	return file
}

// The rtk hook rewrites `git commit` to `rtk git commit`, so allow an optional prefix.
export function eventOf(cmd) {
	if (/(^|[;&|]\s*)(rtk\s+)?gh\s+pr\s+merge\b/.test(cmd)) return 'pr_merged'
	if (/(^|[;&|]\s*)(rtk\s+)?gh\s+pr\s+create\b/.test(cmd)) return 'pr_opened'
	if (/(^|[;&|]\s*)(rtk\s+)?git\s+commit\b/.test(cmd) && !/--dry-run/.test(cmd)) return 'commit'
	return null
}

function start() {
	const input = stdin()
	const cwd = input.cwd || process.cwd()
	const root = git(cwd, 'rev-parse --show-toplevel')
	if (!root) return
	const cfg = configFor(cwd)
	if (cfg.prefixes.length || Object.keys(cfg.projects).length) return
	const offered = readJson(OFFERED, {})
	if (offered[root]) return
	const found = repoPrefixes(cwd)
	if (!found.length) return
	offered[root] = new Date().toISOString()
	writeJson(OFFERED, offered)
	const seen = found.slice(0, 4).map(f => `${f.prefix} (${f.tickets} tickets)`).join(', ')
	console.log(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'SessionStart',
			additionalContext: `This repo's history uses Jira ticket keys — ${seen} — but jira-ticket-update isn't set up here. When the user's first request is done (not before), offer once, in one line, the one-question setup (skill jira-ticket-update:setup). If they say no, drop it: it won't be offered again in this repo.`,
		},
	}))
}

function post() {
	const input = stdin()
	const cmd = input.tool_input?.command || ''
	const type = eventOf(cmd)
	if (!type) return
	const out = String(input.tool_response?.stdout ?? input.tool_response?.output ?? '')
	if (type === 'commit' && /nothing to commit|no changes added/i.test(out)) return
	const cwd = input.cwd || process.cwd()
	const { prefixes } = configFor(cwd)
	// symbolic-ref also works on a branch with no commits yet, where rev-parse fails.
	const branch = git(cwd, 'symbolic-ref --short -q HEAD')
	const keys = keysIn(cmd, prefixes).length ? keysIn(cmd, prefixes) : keysIn(branch, prefixes)
	if (!keys.length) return

	const state = readJson(STATE, {})
	const session = (state[input.session_id || 'unknown'] ||= { nudged: false, keys: {} })
	const prUrl = (out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [])[0]
	const subject = (cmd.match(/-m\s+(?:"([^"]+)"|'([^']+)')/) || []).slice(1).find(Boolean)
	for (const key of keys) {
		const k = (session.keys[key] ||= { repo: cwd, branch, events: [] })
		k.events.push({ type, at: new Date().toISOString(), ...(subject ? { subject: subject.split('\n')[0] } : {}), ...(prUrl ? { pr: prUrl } : {}) })
	}
	saveState(state)

	// A PR is the moment status matters most: say so now, not at the end of the session.
	if (type === 'pr_opened' || type === 'pr_merged') {
		const what = type === 'pr_opened' ? 'A pull request was opened' : 'A pull request was merged'
		console.log(JSON.stringify({
			hookSpecificOutput: {
				hookEventName: 'PostToolUse',
				additionalContext: `${what} for ${keys.join(', ')}${prUrl ? ` (${prUrl})` : ''}. Follow the jira-ticket-update:update skill: draft the status move and comment, ASK the user before changing anything in Jira.`,
			},
		}))
	}
}

function stop() {
	const input = stdin()
	if (input.stop_hook_active) return
	const state = readJson(STATE, {})
	const session = state[input.session_id || 'unknown']
	if (!session || session.nudged || !Object.keys(session.keys).length) return
	session.nudged = true
	saveState(state)
	const lines = Object.entries(session.keys).map(([key, v]) => `${key}: ${v.events.map(e => e.type).join(', ')}`)
	console.log(JSON.stringify({
		decision: 'block',
		reason: `Work this session touched Jira tickets with no update yet — ${lines.join('; ')}. Use the jira-ticket-update:update skill: draft one comment + suggested status per ticket and ASK the user (one question); if they decline, run its clear command for that key and stop.`,
	}))
}

function clear(key) {
	const state = readJson(STATE, {})
	for (const s of Object.values(state)) delete s.keys?.[key]
	for (const [id, s] of Object.entries(state)) if (!Object.keys(s.keys || {}).length) delete state[id]
	saveState(state)
	console.log(`cleared ${key}`)
}

const [mode, arg, arg2] = process.argv.slice(2)
const HOOKS = new Set(['start', 'post', 'stop'])
try {
	if (mode === 'start') start()
	else if (mode === 'post') post()
	else if (mode === 'stop') stop()
	else if (mode === 'clear' && arg) clear(arg)
	else if (mode === 'list') console.log(existsSync(STATE) ? readFileSync(STATE, 'utf8') : '{}')
	else if (mode === 'config') console.log(JSON.stringify(configFor(arg || process.cwd()), null, 2))
	else if (mode === 'prefixes') console.log(JSON.stringify(repoPrefixes(arg || process.cwd())))
	else if (mode === 'guess') console.log(JSON.stringify(guessMoves((arg || '').split(',')), null, 2))
	else if (mode === 'save') console.log(`saved ${save(arg, arg2, process.cwd())}`)
	else if (mode) console.error('usage: jira-nudge.mjs start | post | stop | clear KEY | list | config [DIR] | prefixes [DIR] | guess "A,B,C" | save team|personal JSON')
} catch (e) {
	// A hook must never break the session it is reminding; a command the skill runs should say what failed.
	if (!HOOKS.has(mode)) { console.error(String(e?.message || e)); process.exitCode = 1 }
}
