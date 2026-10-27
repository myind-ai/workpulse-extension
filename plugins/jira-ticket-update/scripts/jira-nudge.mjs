#!/usr/bin/env node
// Trigger side of the jira-ticket-update plugin. It never talks to Jira: it only notices
// work that should move a ticket (commit, PR opened, PR merged) and reminds Claude to ASK.
//
//   node jira-nudge.mjs post         PostToolUse(Bash) hook: record commit / PR events per ticket key
//   node jira-nudge.mjs stop         Stop hook: once per session, ask to update tickets with unreported work
//   node jira-nudge.mjs clear KEY    after the ticket was updated (or the user said not now)
//   node jira-nudge.mjs list         what is pending
//   node jira-nudge.mjs config [DIR] the settings that apply in DIR (team file over personal file), as JSON
//
// Settings, most specific first, merged:
//   <repo>/.claude/jira-ticket-update.json   team: committed once, every teammate gets it with git pull
//   <personal>/config.json                    you: site, cloudId, your own prefixes
// <personal> is $CLAUDE_PLUGIN_DATA when the plugin runs it, else ~/.claude/jira-ticket-update.

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PERSONAL = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'jira-ticket-update')
const STATE = join(PERSONAL, 'pending.json')
const TEAM_FILE = join('.claude', 'jira-ticket-update.json')
const NOT_KEYS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL', 'CVE', 'ES', 'MP', 'H', 'X', 'GPT', 'ECMA', 'WCAG', 'COVID'])

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback } }
const saveState = s => { mkdirSync(PERSONAL, { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)) }
const stdin = () => { try { return JSON.parse(readFileSync(0, 'utf8') || '{}') } catch { return {} } }

function git(cwd, args) {
	try { return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
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
		sources: { team: team ? join(root, TEAM_FILE) : null, personal: join(PERSONAL, 'config.json') },
	}
}

export function keysIn(text, prefixes = []) {
	const found = [...(text || '').matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g)]
		.filter(m => (prefixes.length ? prefixes.includes(m[1]) : !NOT_KEYS.has(m[1])))
		.map(m => `${m[1]}-${m[2]}`)
	return [...new Set(found)]
}

// The rtk hook rewrites `git commit` to `rtk git commit`, so allow an optional prefix.
export function eventOf(cmd) {
	if (/(^|[;&|]\s*)(rtk\s+)?gh\s+pr\s+merge\b/.test(cmd)) return 'pr_merged'
	if (/(^|[;&|]\s*)(rtk\s+)?gh\s+pr\s+create\b/.test(cmd)) return 'pr_opened'
	if (/(^|[;&|]\s*)(rtk\s+)?git\s+commit\b/.test(cmd) && !/--dry-run/.test(cmd)) return 'commit'
	return null
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

const [mode, arg] = process.argv.slice(2)
try {
	if (mode === 'post') post()
	else if (mode === 'stop') stop()
	else if (mode === 'clear' && arg) clear(arg)
	else if (mode === 'list') console.log(existsSync(STATE) ? readFileSync(STATE, 'utf8') : '{}')
	else if (mode === 'config') console.log(JSON.stringify(configFor(arg || process.cwd()), null, 2))
	else if (mode) console.error('usage: jira-nudge.mjs post | stop | clear KEY | list | config [DIR]')
} catch {
	// A reminder must never break the session it is reminding.
}
