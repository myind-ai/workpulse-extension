// node --test plugins/jira-ticket-update/scripts/
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eventOf, keysIn } from './jira-nudge.mjs'

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

test('never breaks the session: bad input and unknown commands exit quietly', () => {
	assert.equal(execFileSync('node', [SCRIPT, 'post'], { input: 'not json' }).toString(), '')
	assert.equal(run(['post'], { tool_input: { command: 'ls' } }), '')
})
