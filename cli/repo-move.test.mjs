// node --test cli/repo-move.test.mjs
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { repoUrl } from './repo-move.mjs'
import { brainSandbox } from './sandbox.mjs'

/**
 * A pretend GitHub on disk: https://github.com/<owner>/<repo>.git resolves to a bare repository under gh/, and a fake gh sees and makes them.
 * The Brain starts on branch brain of test/brain, as it would in a code repository, with a code branch beside it.
 */
function world({ config = {}, visibility = 'private' } = {}) {
	const s = brainSandbox({ config: { branch: 'brain', library: true, configSkip: ['a.md'], ...config } })
	const gh = join(s.root, 'gh')
	const bare = (repo) => join(gh, `${repo}.git`)
	const makeBare = (repo) => {
		mkdirSync(join(gh, repo.split('/')[0]), { recursive: true })
		s.git('init', '-q', '--bare', '-b', 'brain', bare(repo))
	}
	const bin = join(s.root, 'bin')
	mkdirSync(bin)
	const log = join(s.root, 'gh.log')
	writeFileSync(
		join(bin, 'gh'),
		`#!/bin/sh\necho "$@" >> "${log}"\ncase "$1 $2" in\n"repo view") [ -d "${gh}/$3.git" ] ;;\n"repo create") mkdir -p "$(dirname "${gh}/$3.git")" && git init -q --bare -b brain "${gh}/$3.git" ;;\n*) exit 0 ;;\nesac\n`,
	)
	chmodSync(join(bin, 'gh'), 0o755)
	s.git('clone', '-q', '--bare', s.remote, bare('test/brain'))
	s.git('-C', s.clone, 'checkout', '-q', '-b', 'brain')
	s.git('-C', s.clone, 'remote', 'set-url', 'origin', 'https://github.com/test/brain.git')
	const env = {
		PATH: `${bin}:${process.env.PATH}`,
		WP_BRAIN_REPO_VISIBILITY: visibility,
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: `url.file://${gh}/.insteadOf`,
		GIT_CONFIG_VALUE_0: 'https://github.com/',
	}
	const cli = (...args) => s.runWith(env, ...args)
	const tip = (repo, branch = 'brain') => {
		try {
			return s.git('-C', bare(repo), 'rev-parse', `refs/heads/${branch}`).trim()
		} catch {
			return null
		}
	}
	const head = () => s.git('-C', s.clone, 'rev-parse', 'HEAD').trim()
	const config_ = () => JSON.parse(readFileSync(s.configPath, 'utf8'))
	const oldClone = join(s.root, 'old')
	s.git('clone', '-q', bare('test/brain'), oldClone)
	s.git('-C', oldClone, 'config', 'user.email', 'old@example.com')
	s.git('-C', oldClone, 'config', 'user.name', 'Old')
	const add = cli('add', 'learning', 'First lesson #move')
	assert.equal(add.status, 0, add.err)
	return { ...s, gh, bare, makeBare, cli, tip, head, cfg: config_, env, log, oldClone }
}

const seed = (w, repo, file, branch = 'brain') => {
	const work = join(w.root, `seed-${repo.replace('/', '-')}`)
	w.git('clone', '-q', w.bare(repo), work)
	w.git('-C', work, 'config', 'user.email', 's@example.com')
	w.git('-C', work, 'config', 'user.name', 'S')
	w.git('-C', work, 'checkout', '-q', '-B', branch)
	mkdirSync(join(work, file, '..'), { recursive: true })
	writeFileSync(join(work, file), 'x\n')
	w.git('-C', work, 'add', file)
	w.git('-C', work, 'commit', '-q', '-m', `add ${file}`)
	w.git('-C', work, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
	return w.git('-C', work, 'rev-parse', 'HEAD').trim()
}

test('the address keeps the form the clone already uses', () => {
	assert.equal(repoUrl('git@github.com:a/b.git', 'a/b', 'me/notes'), 'git@github.com:me/notes.git')
	assert.equal(repoUrl('https://github.com/A/B', 'a/b', 'me/notes'), 'https://github.com/me/notes')
	assert.equal(repoUrl('/somewhere/else.git', 'a/b', 'me/notes'), 'https://github.com/me/notes.git')
})

test('without --yes it only says what would happen', () => {
	const w = world()
	const before = w.cfg()
	const r = w.cli('move', 'me/notes')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /will be created private/)
	assert.match(r.out, /Nothing has changed yet/)
	assert.deepEqual(w.cfg(), before)
	assert.equal(existsSync(w.bare('me/notes')), false)
	assert.equal(w.git('-C', w.clone, 'remote', 'get-url', 'origin').trim(), 'https://github.com/test/brain.git')
})

test('a move creates the repository private, carries the whole history and keeps every setting', () => {
	const w = world()
	const head = w.head()
	const r = w.cli('move', 'me/notes', '--yes')
	assert.equal(r.status, 0, r.err)
	assert.match(readFileSync(w.log, 'utf8'), /repo create me\/notes --private/)
	assert.equal(w.tip('me/notes'), head)
	const cfg = w.cfg()
	assert.equal(cfg.repo, 'me/notes')
	assert.equal(cfg.movedFrom.repo, 'test/brain')
	assert.equal(cfg.library, true)
	assert.deepEqual(cfg.configSkip, ['a.md'])
	assert.equal(w.git('-C', w.clone, 'remote', 'get-url', 'origin').trim(), 'https://github.com/me/notes.git')
	assert.match(r.out, /extension/)
})

test('after a move, writes go to the new repository and the old one stays as it was', () => {
	const w = world()
	const old = w.tip('test/brain')
	const code = w.tip('test/brain', 'main')
	assert.equal(w.cli('move', 'me/notes', '--yes').status, 0)
	const add = w.cli('add', 'learning', 'Second lesson #move')
	assert.equal(add.status, 0, add.err)
	assert.equal(w.tip('me/notes'), w.head())
	assert.equal(w.tip('test/brain'), old)
	assert.equal(w.tip('test/brain', 'main'), code)
	assert.match(w.cli('search', 'Second').out, /Second lesson/)
	assert.match(w.cli('search', 'First').out, /First lesson/)
})

test('a public or unknown target is refused and nothing changes', () => {
	for (const [visibility, said] of [['public', /public repository/], ['unknown', /Could not tell/]]) {
		const w = world({ visibility })
		w.makeBare('me/notes')
		const head = w.head()
		const refused = w.cli('move', 'me/notes', '--yes')
		assert.notEqual(refused.status, 0)
		assert.match(refused.err, said)
		assert.equal(w.tip('me/notes'), null)
		assert.equal(w.head(), head)
		assert.equal(w.cfg().repo, 'test/brain')
		assert.equal(w.git('-C', w.clone, 'remote', 'get-url', 'origin').trim(), 'https://github.com/test/brain.git')
	}
})

test('a repository holding only starter files joins the history, with no force push', () => {
	const w = world()
	w.makeBare('me/notes')
	const scaffold = seed(w, 'me/notes', 'bridge/SCHEMA.md')
	const head = w.head()
	const r = w.cli('move', 'me/notes', '--yes')
	assert.equal(r.status, 0, r.err)
	const tip = w.tip('me/notes')
	assert.equal(w.head(), tip)
	const ancestor = (a) => w.git('-C', w.bare('me/notes'), 'merge-base', '--is-ancestor', a, tip)
	ancestor(head)
	ancestor(scaffold)
	assert.equal(w.git('-C', w.bare('me/notes'), 'rev-parse', `${tip}^{tree}`).trim(), w.git('-C', w.clone, 'rev-parse', `${head}^{tree}`).trim())
})

test('a repository that already holds other data is refused and left alone', () => {
	const w = world()
	w.makeBare('me/notes')
	const theirs = seed(w, 'me/notes', 'bridge/entries/2026-10/someone.jsonl')
	const head = w.head()
	const r = w.cli('move', 'me/notes', '--yes')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /already holds other files/)
	assert.equal(w.tip('me/notes'), theirs)
	assert.equal(w.head(), head)
	assert.equal(w.cfg().repo, 'test/brain')
})

test('moving to the repository it is already in is refused', () => {
	const w = world()
	const r = w.cli('move', 'TEST/brain', '--yes')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /already in test\/brain/)
})

test('running the move again after a partial copy carries on from there', () => {
	const w = world()
	w.makeBare('me/notes')
	const partial = w.git('-C', w.clone, 'rev-parse', 'HEAD~1').trim()
	w.git('-C', w.clone, 'push', '-q', w.bare('me/notes'), `${partial}:refs/heads/brain`)
	const r = w.cli('move', 'me/notes', '--yes')
	assert.equal(r.status, 0, r.err)
	assert.equal(w.tip('me/notes'), w.head())
})

test('catch-up brings across what the extension wrote to the old repository, once', () => {
	const w = world()
	assert.equal(w.cli('move', 'me/notes', '--yes').status, 0)
	w.git('-C', w.oldClone, 'pull', '-q', 'origin', 'brain')
	mkdirSync(join(w.oldClone, 'workpulse'), { recursive: true })
	writeFileSync(join(w.oldClone, 'workpulse', 'late.json'), '{}\n')
	w.git('-C', w.oldClone, 'add', 'workpulse/late.json')
	w.git('-C', w.oldClone, 'commit', '-q', '-m', 'extension: late write')
	w.git('-C', w.oldClone, 'push', '-q', 'origin', 'HEAD:brain')
	assert.equal(w.cli('add', 'learning', 'New side lesson #move').status, 0)

	const first = w.cli('move', '--catch-up')
	assert.equal(first.status, 0, first.err)
	assert.match(first.out, /Brought 1 commit/)
	assert.equal(existsSync(join(w.clone, 'workpulse', 'late.json')), true)
	assert.equal(w.tip('me/notes'), w.head())
	assert.match(w.cli('search', 'New side').out, /New side lesson/)

	const again = w.cli('move', '--catch-up')
	assert.equal(again.status, 0, again.err)
	assert.match(again.out, /Nothing new/)
})

test('catch-up that clashes undoes itself and says which file', () => {
	const w = world()
	assert.equal(w.cli('move', 'me/notes', '--yes').status, 0)
	w.git('-C', w.oldClone, 'pull', '-q', 'origin', 'brain')
	writeFileSync(join(w.oldClone, 'clash.md'), 'old side\n')
	w.git('-C', w.oldClone, 'add', 'clash.md')
	w.git('-C', w.oldClone, 'commit', '-q', '-m', 'old side')
	w.git('-C', w.oldClone, 'push', '-q', 'origin', 'HEAD:brain')
	writeFileSync(join(w.clone, 'clash.md'), 'new side\n')
	w.git('-C', w.clone, 'add', 'clash.md')
	w.git('-C', w.clone, 'commit', '-q', '-m', 'new side')
	w.git('-C', w.clone, 'push', '-q', w.bare('me/notes'), 'HEAD:refs/heads/brain')
	const head = w.head()
	const r = w.cli('move', '--catch-up')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /clash\.md/)
	assert.equal(w.head(), head)
	assert.equal(w.git('-C', w.clone, 'status', '--porcelain').trim(), '')
})

test('catch-up on a Brain that never moved says so', () => {
	const w = world()
	const r = w.cli('move', '--catch-up')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /was not moved/)
})

test('init refuses a public repository unless told otherwise', () => {
	const w = world()
	const clone = join(w.root, 'public-clone')
	w.makeBare('me/open')
	const env = { ...w.env, WP_BRAIN_REPO_VISIBILITY: 'public', WP_BRAIN_CLONE: clone }
	const refused = w.runWith(env, 'init', 'me/open', '--branch', 'brain')
	assert.notEqual(refused.status, 0)
	assert.match(refused.err, /public/)
	assert.equal(existsSync(clone), false)
	assert.equal(w.cfg().repo, 'test/brain')
	const allowed = w.runWith(env, 'init', 'me/open', '--branch', 'brain', '--allow-public')
	assert.equal(allowed.status, 0, allowed.err)
})

test('a new person: their own private repository, written on one computer and read on another', () => {
	const w = world()
	const first = { ...w.env, WP_BRAIN_CONFIG: join(w.root, 'a.json'), WP_BRAIN_DB: join(w.root, 'a.db'), WP_BRAIN_CLONE: join(w.root, 'a') }
	const second = { ...w.env, WP_BRAIN_CONFIG: join(w.root, 'b.json'), WP_BRAIN_DB: join(w.root, 'b.db'), WP_BRAIN_CLONE: join(w.root, 'b') }
	const made = w.runWith(first, 'init', 'newperson/workpulse-notes', '--branch', 'brain', '--create', '--device', 'cli-one')
	assert.equal(made.status, 0, made.err)
	assert.match(readFileSync(w.log, 'utf8'), /repo create newperson\/workpulse-notes --private/)
	w.git('-C', first.WP_BRAIN_CLONE, 'config', 'user.email', 'n@example.com')
	w.git('-C', first.WP_BRAIN_CLONE, 'config', 'user.name', 'New')
	assert.equal(w.runWith(first, 'add', 'learning', 'A lesson on the first computer #mine').status, 0)
	const joined = w.runWith(second, 'init', 'newperson/workpulse-notes', '--branch', 'brain', '--device', 'cli-two')
	assert.equal(joined.status, 0, joined.err)
	assert.match(w.runWith(second, 'search', 'first computer').out, /A lesson on the first computer/)
	w.git('-C', second.WP_BRAIN_CLONE, 'config', 'user.email', 'n@example.com')
	w.git('-C', second.WP_BRAIN_CLONE, 'config', 'user.name', 'New')
	assert.equal(w.runWith(second, 'add', 'learning', 'A lesson on the second computer #mine').status, 0)
	assert.match(w.runWith(first, 'search', 'second computer').out, /A lesson on the second computer/)
})
