// node --test plugins/jira-ticket-update/scripts/
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eventOf, guessMoves, keysIn, prefixesFrom } from './jira-nudge.mjs'

const SCRIPT = fileURLToPath(new URL('./jira-nudge.mjs', import.meta.url))
const run = (args, input, env) =>
	execFileSync('node', [SCRIPT, ...args], { input: input ? JSON.stringify(input) : '', env: { ...process.env, ...env } }).toString().trim()

test('keys: real ones count, look-alikes do not', () => {
	assert.deepEqual(keysIn('fix: PAY-2433 and LEAP-19, UTF-8, SHA-256'), ['PAY-2433', 'LEAP-19'])
	assert.deepEqual(keysIn('PAY-1 LEAP-2', ['LEAP']), ['LEAP-2'])
})

test('events: commit, PR opened, PR merged, through rtk too', () => {
	assert.equal(eventOf('rtk git commit -m "x"'), 'commit')
	assert.equal(eventOf('git add a && git commit -m "x"'), 'commit')
	assert.equal(eventOf('git commit --dry-run'), null)
	assert.equal(eventOf('gh pr create --title t'), 'pr_opened')
	assert.equal(eventOf('gh pr merge 42 --squash'), 'pr_merged')
	assert.equal(eventOf('git log --grep commit'), null)
})

test('flow: silent commit, PR speaks, stop asks once, clear empties, team prefixes apply', () => {
	const data = mkdtempSync(join(tmpdir(), 'jtu-data-'))
	const repo = mkdtempSync(join(tmpdir(), 'jtu-repo-'))
	execSync('git init -q -b feature/LEAP-7-retry', { cwd: repo })
	mkdirSync(join(repo, '.claude'))
	writeFileSync(join(repo, '.claude', 'jira-ticket-update.json'), JSON.stringify({ prefixes: ['LEAP'], projects: { LEAP: { moves: { pr_opened: 'Code Review' } } } }))
	const env = { CLAUDE_PLUGIN_DATA: data }

	assert.equal(run(['post'], { session_id: 's', cwd: repo, tool_input: { command: 'git commit -m "wip"' }, tool_response: { stdout: '[x 1] wip' } }, env), '')
	const pr = JSON.parse(run(['post'], { session_id: 's', cwd: repo, tool_input: { command: 'gh pr create --title "retry"' }, tool_response: { stdout: 'https://github.com/a/b/pull/9' } }, env))
	assert.match(pr.hookSpecificOutput.additionalContext, /LEAP-7 \(https:\/\/github\.com\/a\/b\/pull\/9\)/)

	const stop = JSON.parse(run(['stop'], { session_id: 's' }, env))
	assert.equal(stop.decision, 'block')
	assert.match(stop.reason, /LEAP-7: commit, pr_opened/)
	assert.equal(run(['stop'], { session_id: 's' }, env), '')
	assert.equal(run(['stop'], { session_id: 's', stop_hook_active: true }, env), '')

	const cfg = JSON.parse(run(['config', repo], null, env))
	assert.deepEqual(cfg.prefixes, ['LEAP'])
	assert.equal(cfg.projects.LEAP.moves.pr_opened, 'Code Review')

	run(['clear', 'LEAP-7'], null, env)
	assert.equal(run(['list'], null, env), '{}')
})

test('prefixes: from history and branches, only when two tickets share one', () => {
	assert.deepEqual(prefixesFrom('PAY-1 fix\nPAY-2 retry\nPAY-2 again\nLEAP-9 once\nUTF-8 HEAD-1 HEAD-2'), [{ prefix: 'PAY', tickets: 2 }])
})

test('guess: a usual workflow maps every event, backwards moves never count', () => {
	const moves = guessMoves(['Reopen', 'Back to To Do', 'Start Progress', 'Code Review', 'Ready for QA', 'Done', 'Cancel'])
	assert.deepEqual(moves, { started: 'Start Progress', pr_opened: 'Code Review', pr_merged: 'Ready for QA', deployed_stage: 'Ready for QA', done: 'Done' })
	assert.deepEqual(guessMoves(['In Progress', 'In Review', 'Deployed to Staging', 'Closed']), { started: 'In Progress', pr_opened: 'In Review', deployed_stage: 'Deployed to Staging', done: 'Closed' })
	assert.deepEqual(guessMoves(['Block', 'Reject']), {})
})

test('save: team file merges per prefix and keeps what was there', () => {
	const data = mkdtempSync(join(tmpdir(), 'jtu-data-'))
	const repo = mkdtempSync(join(tmpdir(), 'jtu-repo-'))
	execSync('git init -q', { cwd: repo })
	const env = { CLAUDE_PLUGIN_DATA: data }
	const saveIn = (where, v) => execFileSync('node', [SCRIPT, 'save', where, JSON.stringify(v)], { cwd: repo, env: { ...process.env, ...env } }).toString()
	saveIn('team', { site: 'https://x.atlassian.net', prefixes: ['PAY'], projects: { PAY: { moves: { started: 'In Progress' } } } })
	saveIn('team', { prefixes: ['LEAP'], projects: { PAY: { moves: { done: 'Done' } } } })
	const team = JSON.parse(readFileSync(join(repo, '.claude', 'jira-ticket-update.json'), 'utf8'))
	assert.deepEqual(team.prefixes, ['PAY', 'LEAP'])
	assert.deepEqual(team.projects.PAY.moves, { started: 'In Progress', done: 'Done' })
	assert.equal(team.site, 'https://x.atlassian.net')
	saveIn('personal', { cloudId: 'abc' })
	assert.equal(JSON.parse(readFileSync(join(data, 'config.json'), 'utf8')).cloudId, 'abc')
	assert.throws(() => execFileSync('node', [SCRIPT, 'save', 'team', '{}'], { cwd: tmpdir(), env: { ...process.env, ...env }, stdio: 'pipe' }))
})

test('start: offers setup once in a repo with ticket keys and no settings, never again', () => {
	const data = mkdtempSync(join(tmpdir(), 'jtu-data-'))
	const repo = mkdtempSync(join(tmpdir(), 'jtu-repo-'))
	const env = { CLAUDE_PLUGIN_DATA: data }
	const sh = c => execSync(c, { cwd: repo, stdio: 'ignore' })
	sh('git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m "PAY-1 one" && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m "PAY-2 two"')
	sh('git branch feature/PAY-7-retry')
	const first = JSON.parse(run(['start'], { cwd: repo }, env))
	assert.match(first.hookSpecificOutput.additionalContext, /PAY \(3 tickets\)/, 'commits and branch names both count')
	assert.equal(run(['start'], { cwd: repo }, env), '')

	const set = mkdtempSync(join(tmpdir(), 'jtu-repo-'))
	execSync('git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m "PAY-1" && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m "PAY-2"', { cwd: set })
	mkdirSync(join(set, '.claude'))
	writeFileSync(join(set, '.claude', 'jira-ticket-update.json'), '{"prefixes":["PAY"]}')
	assert.equal(run(['start'], { cwd: set }, env), '', 'already set up: silent')
	assert.equal(run(['start'], { cwd: tmpdir() }, env), '', 'not a repo: silent')
})

test('never breaks the session: bad input and unknown commands exit quietly', () => {
	assert.equal(execFileSync('node', [SCRIPT, 'post'], { input: 'not json' }).toString(), '')
	assert.equal(run(['post'], { tool_input: { command: 'ls' } }), '')
})
