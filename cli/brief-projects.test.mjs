// node --test cli/brief-projects.test.mjs
// One repository's notes under several names, and browser learnings with no ticket, both reach the brief.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { filter, sameProject } from '../extension/src/core/bridge.ts'
import { brainSandbox } from './sandbox.mjs'

const add = (sb, entries) => {
	const r = sb.runWith({ input: JSON.stringify(entries) }, 'add', '--json', '-', '--no-push')
	assert.equal(r.status, 0, r.err)
}
const hookText = (sb, repo) => {
	const r = sb.runWith({ input: JSON.stringify({ session_id: 'sb', cwd: repo }) }, 'hook')
	assert.equal(r.status, 0, r.err)
	return r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : ''
}
const repoAt = (remote, branch = 'main') => {
	const repo = mkdtempSync(join(tmpdir(), 'wp-brief-repo-'))
	const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
	git('init', '-q', '-b', branch)
	git('remote', 'add', 'origin', remote)
	return repo
}
const NAMED = [
	{ kind: 'learning', title: 'Saved under the bare name', project: 'payments' },
	{ kind: 'learning', title: 'Saved under the full name', project: 'acme/payments' },
	{ kind: 'learning', title: 'Saved under another case', project: 'Acme/Payments' },
	{ kind: 'learning', title: 'Saved under a stranger with the same repo name', project: 'someone/payments' },
	{ kind: 'learning', title: 'Saved under the public copy', project: 'acme-oss/payments-public' },
	{ kind: 'learning', title: 'Saved under a longer name', project: 'acme/payments-web' },
]

test('sameProject: owner/repo and the bare repo are one, other owners and longer names are not', () => {
	assert.ok(sameProject('widget', 'acme/widget'))
	assert.ok(sameProject('acme/widget', 'widget'))
	assert.ok(sameProject('Acme/Widget', 'acme/widget'))
	assert.ok(!sameProject('other/widget', 'acme/widget'))
	assert.ok(!sameProject('widget-web', 'widget'))
	assert.ok(!sameProject(undefined, 'widget'))
	assert.ok(!sameProject('', ''))
})

test('filter by project finds every name of it, so a list and the Brain page agree with the brief', () => {
	const got = filter(NAMED.map((e, i) => ({ ...e, id: String(i) })), { project: 'acme/payments' }).map((e) => e.title)
	assert.deepEqual(got, ['Saved under the bare name', 'Saved under the full name', 'Saved under another case'])
})

test('the session brief shows notes under each name of the repository, and not a stranger of the same name', () => {
	const sb = brainSandbox()
	add(sb, NAMED)
	const text = hookText(sb, repoAt('https://github.com/acme/payments.git'))
	for (const t of ['the bare name', 'the full name', 'another case']) assert.match(text, new RegExp(`Saved under ${t}`))
	assert.doesNotMatch(text, /a stranger/)
	assert.doesNotMatch(text, /longer name/)
	assert.doesNotMatch(text, /public copy/)
})

test('brief --project with the bare name finds the full name too', () => {
	const sb = brainSandbox()
	add(sb, NAMED)
	const r = sb.run('brief', '--project', 'payments')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /Saved under the full name/)
	assert.match(r.out, /Saved under the bare name/)
})

test('sameProjects in the config joins a public copy to its private repository, in both directions', () => {
	const sb = brainSandbox({ config: { sameProjects: [['acme/payments', 'acme-oss/payments-public']] } })
	add(sb, NAMED)
	assert.match(hookText(sb, repoAt('https://github.com/acme/payments.git')), /Saved under the public copy/)
	assert.match(hookText(sb, repoAt('https://github.com/acme-oss/payments-public.git')), /Saved under the full name/)
})

test('a learning written in the browser with no ticket reaches the brief, once the backup holds it', () => {
	const sb = brainSandbox()
	add(sb, [{ kind: 'learning', title: 'A note so this repository has something to say', project: 'acme/payments' }])
	const dir = join(sb.clone, 'workpulse', 'data', 'learnings')
	mkdirSync(dir, { recursive: true })
	const at = Date.now()
	writeFileSync(
		join(dir, 'this-month.json'),
		JSON.stringify([
			{ id: 'b1', at, text: 'Written in the browser with no ticket' },
			{ id: 'b2', at: at - 40 * 86_400_000, text: 'Written in the browser long ago' },
		]),
	)
	const text = hookText(sb, repoAt('https://github.com/acme/payments.git'))
	assert.match(text, /## Written in the browser \(14 days\)/)
	assert.match(text, /Written in the browser with no ticket/)
	assert.doesNotMatch(text, /long ago/)
})

test('a browser learning alone does not make a repository with nothing recorded start talking', () => {
	const sb = brainSandbox()
	const dir = join(sb.clone, 'workpulse', 'data', 'learnings')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'this-month.json'), JSON.stringify([{ id: 'b1', at: Date.now(), text: 'Written in the browser with no ticket' }]))
	assert.equal(hookText(sb, repoAt('https://github.com/acme/empty.git')), '')
})

test('the capped brief leads with this repository, even when other projects have follow-ups and repeated mistakes', () => {
	const sb = brainSandbox()
	const others = []
	for (let i = 0; i < 6; i++) others.push({ kind: 'ticket', title: `Other project work ${i}`, project: 'acme/other', status: 'wip', next: [`Other project follow-up ${i} that is long enough to take up real room in the brief, and more`] })
	for (let t = 0; t < 6; t++) for (const k of ['a', 'b']) others.push({ kind: 'mistake', title: `Repeated mistake ${t}${k} with a long enough title to take up real room in the brief`, tags: [`rep${t}`], rootCause: 'a root cause long enough to take up real room as well, and then some' })
	add(sb, [...others, { kind: 'ticket', title: 'Our own follow-up entry', project: 'payments', status: 'wip', next: ['Our own next step'] }, { kind: 'learning', title: 'Our own lesson', project: 'acme/payments' }])
	const text = hookText(sb, repoAt('https://github.com/acme/payments.git'))
	assert.match(text, /Our own next step/)
	assert.match(text, /Our own lesson/)
	assert.doesNotMatch(text, /Other project follow-up/)
})
