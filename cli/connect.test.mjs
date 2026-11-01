// node --test cli/connect.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { repoFrom } from './connect.mjs'
import { nudgeText } from './setup.mjs'
import { CLI } from './sandbox.mjs'

// Built by joining, so no scanner here takes this file for one holding a real key.
const FAKE_KEY = ['sk', 'ant', 'api03', 'a'.repeat(40)].join('-')

/** A new person on a new computer: no Brain config, a pretend GitHub on disk, and a ~/.claude with skills. `login: null` is gh signed out. */
function newPerson({ login = 'newperson', visibility = 'private', plugin = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'wp-brain-test-connect-'))
	process.on('exit', () => {
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 2 })
		} catch {}
	})
	const gh = join(root, 'gh')
	const bin = join(root, 'bin')
	const claude = join(root, 'claude')
	mkdirSync(gh)
	mkdirSync(bin)
	mkdirSync(join(claude, 'skills', 'my-skill'), { recursive: true })
	writeFileSync(join(claude, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\nSteps.\n')
	writeFileSync(join(claude, 'CLAUDE.md'), '# My rules\n')
	writeFileSync(join(claude, 'settings.json'), '{"theme":"dark"}\n')
	if (plugin) {
		const install = join(root, 'plugin')
		mkdirSync(join(install, 'hooks'), { recursive: true })
		copyFileSync(join(dirname(CLI), '..', 'hooks', 'hooks.json'), join(install, 'hooks', 'hooks.json')) // the plugin's real hooks
		mkdirSync(join(install, 'cli'))
		writeFileSync(join(install, 'cli', 'memory-hook.mjs'), '')
		mkdirSync(join(claude, 'plugins'), { recursive: true })
		writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'workpulse-brain@workpulse': [{ installPath: install }] } }))
	}
	const log = join(root, 'gh.log')
	writeFileSync(
		join(bin, 'gh'),
		`#!/bin/sh\necho "$@" >> "${log}"\ncase "$1 $2" in\n"api user") ${login ? `echo ${login}` : 'exit 1'} ;;\n"repo view") [ -d "${gh}/$3.git" ] ;;\n"repo create") mkdir -p "$(dirname "${gh}/$3.git")" && git init -q --bare -b brain "${gh}/$3.git" ;;\n*) exit 0 ;;\nesac\n`,
	)
	chmodSync(join(bin, 'gh'), 0o755)
	const paths = { config: join(root, 'config', 'brain.json'), clone: join(root, 'clone') }
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		WP_BRAIN_REPO_VISIBILITY: visibility,
		WP_BRAIN_CONFIG: paths.config,
		WP_BRAIN_CLONE: paths.clone,
		WP_BRAIN_DB: join(root, 'brain.db'),
		WP_BRAIN_SESSIONS: join(root, 'sessions'),
		WP_MEMORY_DB: join(root, 'memory.db'),
		CLAUDE_HOME: claude,
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: `url.file://${gh}/.insteadOf`,
		GIT_CONFIG_VALUE_0: 'https://github.com/',
		GIT_AUTHOR_NAME: 'New',
		GIT_AUTHOR_EMAIL: 'n@example.com',
		GIT_COMMITTER_NAME: 'New',
		GIT_COMMITTER_EMAIL: 'n@example.com',
	}
	const cli = (...args) => {
		const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env })
		return { status: r.status, out: r.stdout, err: r.stderr }
	}
	const onGitHub = (repo) => {
		try {
			return execFileSync('git', ['-C', join(gh, `${repo}.git`), 'ls-tree', '-r', '--name-only', 'brain'], { encoding: 'utf8' }).split('\n').filter(Boolean)
		} catch {
			return null
		}
	}
	return { root, claude, gh, log, env, cli, onGitHub, ...paths, cfg: () => JSON.parse(readFileSync(paths.config, 'utf8')) }
}

test('a repository name: nothing is the default, a bare name goes under the login, owner/name is taken as it is', () => {
	assert.equal(repoFrom(undefined, 'me', 'workpulse-notes'), 'me/workpulse-notes')
	assert.equal(repoFrom('my-brain', 'me', 'workpulse-notes'), 'me/my-brain')
	assert.equal(repoFrom('team/shared', null, 'workpulse-notes'), 'team/shared')
	assert.throws(() => repoFrom('not a name', 'me', 'x'), /not a repository name/)
	assert.throws(() => repoFrom('my-brain', null, 'x'), /gh auth login/)
})

test('the plugin asks on first run: how it is used and which repository, not a one-line offer', () => {
	const p = newPerson()
	const r = p.cli('hook', '--plugin')
	assert.equal(r.status, 0, r.err)
	const said = JSON.parse(r.out).hookSpecificOutput.additionalContext
	assert.equal(said, nudgeText(CLI))
	assert.ok(said.includes(`node "${CLI}" connect`), 'the path, because the skill can not rely on an environment variable')
	assert.match(said, /AskUserQuestion how the user wants to use it and which private repository/)
	assert.match(said, /Not now/)
	assert.equal(p.cli('hook', '--plugin').out, '', 'only once a day')
})

test('the default: a new private repository, lessons saved and read back, skills and rules stored', () => {
	const p = newPerson()
	const r = p.cli('connect')
	assert.equal(r.status, 0, r.err)
	assert.match(readFileSync(p.log, 'utf8'), /repo create newperson\/workpulse-notes --private/)
	assert.equal(p.cfg().repo, 'newperson/workpulse-notes')
	assert.equal(p.cfg().branch, 'brain')
	assert.equal(p.cfg().library, true)
	const files = p.onGitHub('newperson/workpulse-notes')
	assert.ok(files.some((f) => f.endsWith('skills/my-skill/SKILL.md')), files.join(' '))
	assert.ok(files.some((f) => f.endsWith('CLAUDE.md')))
	assert.match(r.out, /Your Brain is newperson\/workpulse-notes/)
	assert.match(r.out, /Skills and rules: \d+ files stored/)
	assert.match(r.out, /Settings → Backup/)

	assert.equal(p.cli('add', 'learning', 'My first lesson #mine').status, 0)
	assert.ok(p.onGitHub('newperson/workpulse-notes').some((f) => f.startsWith('bridge/entries/')))
	assert.match(p.cli('search', 'first lesson').out, /My first lesson/)
})

test('the name they typed is used, under their login', () => {
	const p = newPerson()
	assert.equal(p.cli('connect', '--repo', 'my-learning').status, 0)
	assert.equal(p.cfg().repo, 'newperson/my-learning')
	assert.ok(p.onGitHub('newperson/my-learning'))
})

test('lessons only stores no skills and leaves the library off', () => {
	const p = newPerson()
	const r = p.cli('connect', '--use', 'brain')
	assert.equal(r.status, 0, r.err)
	assert.equal(p.cfg().library, undefined)
	assert.ok(!p.onGitHub('newperson/workpulse-notes').some((f) => f.includes('my-skill')))
})

test('a skill that looks like it holds a secret is left out and named, its value is never shown, and the rest are stored', () => {
	const p = newPerson()
	mkdirSync(join(p.claude, 'skills', 'leaky'))
	writeFileSync(join(p.claude, 'skills', 'leaky', 'SKILL.md'), `key: ${FAKE_KEY}\n`)
	const r = p.cli('connect')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /skills\/leaky\/SKILL\.md/)
	assert.ok(!(r.out + r.err).includes(FAKE_KEY))
	const files = p.onGitHub('newperson/workpulse-notes')
	assert.ok(!files.some((f) => f.includes('leaky')))
	assert.ok(files.some((f) => f.includes('my-skill')))
	assert.deepEqual(p.cfg().configSkip, ['skills/leaky/SKILL.md'])
})

test('everything, with the plugin: session memory on, settings.json untouched', () => {
	const p = newPerson()
	const before = readFileSync(join(p.claude, 'settings.json'), 'utf8')
	const r = p.cli('connect', '--use', 'sessions')
	assert.equal(r.status, 0, r.err)
	assert.equal(p.cfg().memory, true)
	assert.equal(existsSync(p.env.WP_MEMORY_DB), true)
	assert.equal(readFileSync(join(p.claude, 'settings.json'), 'utf8'), before)
	assert.match(r.out, /Session memory: on/)
})

test('everything, without the plugin: says what it needs rather than editing settings.json', () => {
	const p = newPerson({ plugin: false })
	const before = readFileSync(join(p.claude, 'settings.json'), 'utf8')
	const r = p.cli('connect', '--use', 'sessions')
	assert.equal(r.status, 0, r.err)
	assert.equal(p.cfg().memory, undefined)
	assert.equal(readFileSync(join(p.claude, 'settings.json'), 'utf8'), before)
	assert.match(r.out, /memory on/)
})

test('running it again is safe, and a different repository points at move instead of splitting the Brain', () => {
	const p = newPerson()
	assert.equal(p.cli('connect').status, 0)
	const again = p.cli('connect')
	assert.equal(again.status, 0, again.err)
	assert.equal(p.cfg().repo, 'newperson/workpulse-notes')
	writeFileSync(p.config, JSON.stringify({ ...p.cfg(), movedFrom: { repo: 'newperson/code', at: '2026-11-01' } }))
	assert.equal(p.cli('connect').status, 0)
	assert.equal(p.cfg().movedFrom.repo, 'newperson/code', 'a re-run keeps the way to catch up')
	const other = p.cli('connect', '--repo', 'other')
	assert.notEqual(other.status, 0)
	assert.match(other.err, /wp-brain move newperson\/other/)
	assert.equal(p.cfg().repo, 'newperson/workpulse-notes')
})

test('a leftover clone of another repository is refused, not silently written to', () => {
	const p = newPerson()
	mkdirSync(p.clone, { recursive: true })
	execFileSync('git', ['-C', p.clone, 'init', '-q'])
	execFileSync('git', ['-C', p.clone, 'remote', 'add', 'origin', 'https://github.com/someone/else.git'])
	const r = p.cli('connect')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /someone\/else/)
	assert.equal(existsSync(p.config), false)
})

test('a public repository, a bad use and a signed-out gh each stop with the reason, and nothing is set up', () => {
	const open = newPerson({ visibility: 'public' })
	const pub = open.cli('connect', '--repo', 'open-one')
	assert.notEqual(pub.status, 0)
	assert.match(pub.err, /public/)
	assert.equal(existsSync(open.config), false)

	const bad = newPerson().cli('connect', '--use', 'all')
	assert.notEqual(bad.status, 0)
	assert.match(bad.err, /Usage: wp-brain connect/)

	const out = newPerson({ login: null })
	const signedOut = out.cli('connect')
	assert.notEqual(signedOut.status, 0)
	assert.match(signedOut.err, /gh auth login/)
	assert.equal(existsSync(out.config), false)
})
