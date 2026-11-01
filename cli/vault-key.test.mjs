// wp-brain vault init, vault key and the doctor's vault rows.
// Every CLI run here has a temp HOME, CLAUDE_HOME and WP_BRAIN_CONFIG, and stub gh, security and git first on PATH.
// WP_BRAIN_REPO_VISIBILITY is set to a value repoVisibility doesn't take, so it asks gh, which is the stub: the log proves when.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { sqlite } from './brain-db.mjs'
import { brainSandbox } from './sandbox.mjs'
import { fakeKeystore, fingerprint, newKey } from './vault-crypto.mjs'
import { readLine } from './vault-key.mjs'
import { runVaultCli } from './vault.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'wp-vault-key-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const dir = () => {
	const d = join(root, `t${n++}`)
	mkdirSync(d)
	return d
}
const KEY = await newKey()
const OTHER = await newKey()
const REPO = 'me/workpulse-vault'
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()

/** A Mac in a box: stub gh answering from state.json, stub security keeping its key in a file, git that reports a GitHub origin. */
function mac({ state = {}, key = null, config = {}, origin = `https://github.com/${REPO}.git`, sharing = null } = {}) {
	const bin = dir()
	const home = dir()
	const claudeHome = dir()
	const box = dir()
	const paths = { calls: join(box, 'calls.log'), state: join(box, 'state.json'), key: join(box, 'key'), remote: sharing?.paths.remote ?? join(box, 'remote.git'), store: sharing?.paths.store ?? join(box, 'store'), secBroken: join(box, 'sec-broken'), secFailAdd: join(box, 'sec-fail-add') }
	const setState = (more) => writeFileSync(paths.state, JSON.stringify({ auth: true, login: 'me', repo: 'missing', name: REPO, isPrivate: true, ...(existsSync(paths.state) ? JSON.parse(readFileSync(paths.state, 'utf8')) : {}), ...more }))
	setState(state)
	if (key) writeFileSync(paths.key, `${key}\n`)
	symlinkSync(process.execPath, join(bin, 'node'))
	writeFileSync(join(bin, 'gh.mjs'), `import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { fakeStorage } = await import(${JSON.stringify(join(here, 'vault-fake.mjs'))})
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(paths.calls)}, 'gh ' + args.join(' ') + '\\n')
const state = JSON.parse(readFileSync(${JSON.stringify(paths.state)}, 'utf8'))
const git = (...a) => execFileSync(${JSON.stringify(realGit)}, a, { stdio: 'ignore' })
const fail = (text) => { console.error(text); process.exit(1) }
const [what, sub] = args
const after = (flag) => args[args.indexOf(flag) + 1]
if (what === 'auth') {
	console.error('Token: gho_stubtoken')
	process.exit(state.auth && !state.authStale ? 0 : 1)
} else if (what === 'api') {
	if (!state.auth) fail('HTTP 401: Bad credentials')
	console.log(state.login)
} else if (what === 'repo' && sub === 'view') {
	const asked = after('--json')
	if (state.repo === 'missing') fail("GraphQL: Could not resolve to a Repository with the name '" + args[2] + "'. (repository)")
	if (state.repo === 'broken' || (asked === 'isPrivate' && state.visibilityBroken)) fail('HTTP 502: Bad Gateway')
	console.log(asked === 'isPrivate' ? String(state.isPrivate) : state.name)
} else if (what === 'repo' && sub === 'create') {
	if (state.failCreate) fail('HTTP 422: could not create')
	if (state.emptyRepo) git('init', '-q', '--bare', '-b', 'main', ${JSON.stringify(paths.remote)})
	else {
		const work = mkdtempSync(join(${JSON.stringify(box)}, 'wp-stub-'))
		git('init', '-q', '-b', 'main', work)
		writeFileSync(join(work, 'README.md'), 'vault\\n')
		git('-C', work, 'add', 'README.md')
		git('-C', work, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'Initial commit')
		git('clone', '-q', '--bare', work, ${JSON.stringify(paths.remote)})
	}
	state.repo = 'exists'
	writeFileSync(${JSON.stringify(paths.state)}, JSON.stringify(state))
	console.log('https://github.com/' + args[2])
} else if (what === 'repo' && sub === 'clone') {
	git('clone', '-q', ${JSON.stringify(paths.remote)}, args[3])
} else if (what === 'release') {
	const s = fakeStorage(${JSON.stringify(paths.store)})
	const tag = args[2]
	try {
		if (sub === 'list') console.log(JSON.stringify((await s.listReleases()).map((r) => ({ tagName: r.tag, isDraft: r.draft, createdAt: r.createdAt }))))
		else if (sub === 'create') await s.createRelease(tag, { draft: args.includes('--draft') })
		else if (sub === 'edit') await s.publishRelease(tag)
		else if (sub === 'delete') await s.deleteRelease(tag)
		else if (sub === 'view') console.log(JSON.stringify({ isDraft: false, assets: await s.listAssets(tag) }))
		else if (sub === 'upload') await s.putAsset(tag, args[3], args[3].split('/').pop())
		else if (sub === 'download') await s.getAsset(tag, after('-p'), after('-D'))
		else fail('stub gh: unexpected release ' + sub)
	} catch (e) {
		fail(e.message)
	}
} else fail('stub gh: unexpected ' + args.join(' '))
`)
	writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(bin, 'gh.mjs'))} "$@"\n`)
	writeFileSync(join(bin, 'security'), `#!/bin/sh
echo "security $1" >> ${JSON.stringify(paths.calls)}
case "$1" in
  find-generic-password)
    [ -f ${JSON.stringify(paths.secBroken)} ] && exit 36
    if [ -f ${JSON.stringify(paths.key)} ]; then cat ${JSON.stringify(paths.key)}; else exit 44; fi ;;
  add-generic-password)
    [ -f ${JSON.stringify(paths.secFailAdd)} ] && exit 1
    while [ $# -gt 0 ]; do
      if [ "$1" = "-w" ]; then printf '%s\\n' "$2" > ${JSON.stringify(paths.key)}; fi
      shift
    done ;;
  *) exit 1 ;;
esac
`)
	writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$*" in\n  *"remote get-url"*) echo ${JSON.stringify(origin)}; exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`)
	for (const f of ['gh', 'security', 'git']) chmodSync(join(bin, f), 0o755)

	const sb = brainSandbox({ config: { repo: 'me/brain', library: true, configSkip: ['keep/this'], ...config } })
	const env = {
		HOME: home,
		CLAUDE_HOME: claudeHome,
		PATH: `${bin}:${process.env.PATH}`,
		WP_BRAIN_REPO_VISIBILITY: 'ask-the-stub',
		WP_VAULT_PART_BYTES: '100000',
		GIT_AUTHOR_NAME: 'T',
		GIT_AUTHOR_EMAIL: 't@example.com',
		GIT_COMMITTER_NAME: 'T',
		GIT_COMMITTER_EMAIL: 't@example.com',
	}
	const run = (more, ...args) => sb.runWith({ ...env, ...more }, ...args)
	const calls = () => (existsSync(paths.calls) ? readFileSync(paths.calls, 'utf8').trim().split('\n').filter(Boolean) : [])
	const count = (start) => calls().filter((l) => l.startsWith(start)).length
	const storedKey = () => (existsSync(paths.key) ? readFileSync(paths.key, 'utf8').trim() : null)
	const config_ = () => JSON.parse(readFileSync(sb.configPath, 'utf8'))
	const rawConfig = () => readFileSync(sb.configPath, 'utf8')
	const clone = join(home, '.workpulse', 'vault')
	return { run, sb, home, bin, clone, paths, env, setState, calls, count, storedKey, config: config_, rawConfig }
}

/** The repository already on GitHub, with a first commit and any files given. */
function seedRemote(m, files = {}) {
	const w = join(m.paths.remote, '..', 'seed')
	const g = (...a) => execFileSync(realGit, ['-C', w, ...a], { stdio: 'ignore' })
	execFileSync(realGit, ['init', '-q', '-b', 'main', w])
	for (const [rel, text] of Object.entries({ 'README.md': 'x\n', ...files })) {
		mkdirSync(join(w, rel, '..'), { recursive: true })
		writeFileSync(join(w, rel), text)
	}
	g('add', '-A')
	g('-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'first')
	execFileSync(realGit, ['clone', '-q', '--bare', w, m.paths.remote], { stdio: 'ignore' })
}

/** A manifest of another device, listing one database encrypted with `key`. */
const manifestOf = (key) => JSON.stringify({ version: 1, device: 'other', items: [{ id: 'i-0000000000000009', kind: 'database', name: 'a.db', size: 1, sha256: 'a'.repeat(64), date: '2026-10-30T00:00:00.000Z', release: 'snap-x', encrypted: true, keyFp: fingerprint(key), parts: [{ asset: 'x.part001', size: 1, sha256: 'a'.repeat(64) }], verifiedAt: '2026-10-30T00:00:00.000Z' }] })

const CREATE = `gh repo create ${REPO} --private --add-readme`
const noKeyText = (r) => assert.ok(!`${r.out}${r.err}`.includes('AGE-SECRET-KEY-1'), 'a key was printed')

describe('the journey, joined up through the stubs', () => {
	const box = (m) => ({ get: () => m.storedKey(), set: (_a, k) => writeFileSync(m.paths.key, `${k}\n`) })
	const rows = (file) => {
		const DB = sqlite()
		const db = new DB(file, { readOnly: true })
		try {
			return db.prepare('SELECT v FROM t ORDER BY v').all().map((r) => r.v)
		} finally {
			db.close()
		}
	}

	test('init, confirm, backup, restore, prune; then a second Mac: init, import, restore', async () => {
		const m = mac({ config: { device: 'first' } })
		const init = m.run({}, 'vault', 'init', '--yes')
		assert.equal(init.status, 0, init.err)
		const key = m.storedKey()
		assert.match(key, /^AGE-SECRET-KEY-1/)

		const source = join(dir(), 'sessions.db')
		const DB = sqlite()
		const h = new DB(source)
		h.exec('CREATE TABLE t (v TEXT)')
		h.exec("INSERT INTO t VALUES ('one')")
		h.close()
		writeFileSync(m.sb.configPath, JSON.stringify({ ...m.config(), vault: { ...m.config().vault, databases: [source] } }))

		const refused = m.run({}, 'vault', 'backup', '--yes')
		assert.notEqual(refused.status, 0, 'no offline copy yet')
		assert.match(refused.err, /vault key confirm/)
		await runVaultCli({ pos: ['key', 'confirm'], opt: {} }, { cfg: m.config(), configPath: m.sb.configPath, keystore: box(m), clone: m.clone, prompt: async () => key.slice(-4), log: () => {} })
		assert.ok(m.config().vault.keyBackedUpAt)

		const first = m.run({}, 'vault', 'backup', '--yes')
		assert.equal(first.status, 0, first.err)
		await new Promise((r) => setTimeout(r, 1100)) // tags are to the second
		const w = new DB(source)
		w.exec("INSERT INTO t VALUES ('two')")
		w.close()
		const second = m.run({}, 'vault', 'backup', '--yes')
		assert.equal(second.status, 0, second.err)

		const to = join(dir(), 'back')
		const back = m.run({}, 'vault', 'restore', 'sessions.db', '--to', to)
		assert.equal(back.status, 0, back.err)
		assert.match(back.out, /from device first/)
		assert.deepEqual(rows(join(to, 'sessions.db')), ['one', 'two'])

		const preview = m.run({}, 'vault', 'prune', '--keep', '1')
		assert.equal(preview.status, 0, preview.err)
		assert.match(preview.out, /Would free/)
		assert.equal(m.count('gh release delete'), 0)
		const pruned = m.run({}, 'vault', 'prune', '--keep', '1', '--yes')
		assert.equal(pruned.status, 0, pruned.err)
		assert.equal(m.count('gh release delete'), 1)
		const left = readdirSync(m.paths.store).filter((f) => f.startsWith('snap-'))
		assert.equal(left.length, 1)
		const listed = JSON.parse(execFileSync(realGit, ['--git-dir', m.paths.remote, 'show', 'main:manifest/first.json'], { encoding: 'utf8' }))
		assert.deepEqual(listed.items.map((i) => i.release), left, 'GitHub and the pushed manifest agree')

		// A second Mac: another HOME and Keychain, the same repository and releases.
		const n = mac({ config: { device: 'second' }, state: { repo: 'exists' }, sharing: m })
		const before = n.run({}, 'vault', 'list')
		assert.match(before.err, /The vault is off/, 'nothing is set up here yet')
		const init2 = n.run({}, 'vault', 'init', '--yes')
		assert.equal(init2.status, 0, init2.err)
		assert.match(init2.out, /vault key import/)
		assert.equal(n.count('gh repo create'), 0)
		assert.equal(n.storedKey(), null, 'no new key over a repository that lists encrypted items')
		const to2 = join(dir(), 'back2')
		const noKey = n.run({}, 'vault', 'restore', 'sessions.db', '--to', to2)
		assert.notEqual(noKey.status, 0)
		assert.match(noKey.err, /vault key import/)
		const said = []
		await runVaultCli({ pos: ['key', 'import'], opt: {} }, { cfg: n.config(), configPath: n.sb.configPath, keystore: box(n), clone: n.clone, cloneRepo: () => REPO, promptHidden: async () => key, log: (l) => said.push(l) })
		assert.equal(n.storedKey(), key)
		assert.match(said.join('\n'), /fingerprint matches the manifests/)
		assert.match(said.join('\n'), /vault key confirm/)
		assert.doesNotMatch(said.join('\n'), /key export/, 'the copy already exists: only confirm')
		const restored = n.run({}, 'vault', 'restore', 'sessions.db', '--to', to2)
		assert.equal(restored.status, 0, restored.err)
		assert.match(restored.out, /from device first/)
		noKeyText(restored)
		assert.deepEqual(rows(join(to2, 'sessions.db')), ['one', 'two'])
	})
})

describe('which GitHub account init is about to use', () => {
	test('logged in as someone other than the Brain repository\'s owner: the plan says so, and --yes refuses', () => {
		const m = mac({ state: { login: 'work-me' } })
		const plan = m.run({}, 'vault', 'init')
		assert.equal(plan.status, 0, plan.err)
		assert.match(plan.out, /logged in as work-me/)
		assert.match(plan.out, /belongs to me/)
		assert.match(plan.out, /gh auth switch/)
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /logged in as work-me/)
		assert.match(r.err, /gh auth switch/)
		assert.equal(m.count('gh repo create'), 0)
		assert.equal(m.count('gh repo clone'), 0)
		assert.equal(m.count('security add'), 0)
		assert.equal(m.storedKey(), null)
		assert.equal(m.config().vault, undefined)
	})

	test('logged in as someone other than vault.repo\'s owner refuses with --yes', () => {
		const m = mac({ state: { login: 'work-me', repo: 'exists' }, config: { vault: { repo: REPO } } })
		seedRemote(m)
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /logged in as work-me/)
		assert.match(r.err, new RegExp(REPO))
		assert.equal(m.count('gh repo clone'), 0)
		assert.equal(m.storedKey(), null)
	})

	test('a vault.repo set on purpose under the logged-in account settles it, and the plan still names the difference', () => {
		const m = mac({ config: { repo: 'someone/brain', vault: { repo: REPO } } })
		const plan = m.run({}, 'vault', 'init')
		assert.match(plan.out, /Brain repository belongs to someone/)
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
		assert.equal(m.count('gh repo create'), 1)
	})

	test('GitHub names ignore case', () => {
		const m = mac({ state: { login: 'ME' }, config: { repo: 'me/brain', vault: { repo: REPO } } })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
	})

	test('gh auth status failing over a stale second account does not read as "not logged in": who is logged in comes from the API', () => {
		const m = mac({ state: { authStale: true } })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
		assert.equal(m.count('gh repo create'), 1)
	})
})

describe('vault init', () => {
	test('without --yes it only says what it would do: no repo, no key, no config', () => {
		const m = mac()
		const before = m.rawConfig()
		const r = m.run({}, 'vault', 'init')
		assert.equal(r.status, 0, r.err)
		assert.match(r.out, new RegExp(`private .*${REPO}`))
		assert.match(r.out, /new vault key .*Keychain/)
		assert.match(r.out, new RegExp(m.sb.configPath.replace(/[/.]/g, '\\$&')))
		assert.match(r.out, /--yes/)
		assert.equal(m.count('gh repo create'), 0)
		assert.equal(m.count('gh repo clone'), 0)
		assert.equal(m.count('security add-generic-password'), 0)
		assert.equal(m.rawConfig(), before)
		assert.equal(existsSync(join(m.home, '.workpulse')), false)
		assert.equal(m.storedKey(), null)
	})

	test('--yes: a new repo reported public refuses and says so, with no clone, key or config', () => {
		const m = mac({ state: { isPrivate: false } })
		const before = m.rawConfig()
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /public/)
		assert.equal(m.count('gh repo create'), 1)
		assert.equal(m.count('gh repo clone'), 0)
		assert.equal(m.storedKey(), null)
		assert.equal(m.rawConfig(), before)
		assert.equal(existsSync(m.clone), false)
	})

	test('--yes with the real check forced public refuses the same way', () => {
		const m = mac()
		const r = m.run({ WP_BRAIN_REPO_VISIBILITY: 'public' }, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /public/)
		assert.equal(m.storedKey(), null)
		assert.equal(m.config().vault, undefined)
	})

	test('a visibility nobody can tell after creating refuses, and the next run finishes the job, with one repo and a key', () => {
		const m = mac({ state: { visibilityBroken: true } })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /could not be told|not private/i)
		assert.equal(m.storedKey(), null)
		m.setState({ visibilityBroken: false })
		const again = m.run({}, 'vault', 'init', '--yes')
		assert.equal(again.status, 0, again.err)
		assert.equal(m.count('gh repo create'), 1)
		assert.match(m.storedKey(), /^AGE-SECRET-KEY-1/, 'the interrupted run was the one that made this repo, so it is still new')
		assert.equal(m.config().vault.repo, REPO)
		assert.deepEqual(readdirSync(join(m.home, '.workpulse')).filter((f) => f !== 'vault'), [], 'the marker of the interrupted run is gone')
	})

	test('--yes with a private result: order proved, config written with the rest kept, key made once and never printed', () => {
		const m = mac()
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
		noKeyText(r)
		const order = ['gh auth status', `gh repo view ${REPO} --json nameWithOwner`, CREATE, `gh repo view ${REPO} --json isPrivate`, `gh repo clone ${REPO}`, 'security add-generic-password'].map((want) => m.calls().findIndex((l) => l.startsWith(want)))
		assert.ok(order.every((at) => at >= 0), `missing from ${m.calls().join(' | ')}`)
		assert.deepEqual(order, [...order].sort((a, b) => a - b), `out of order: ${m.calls().join(' | ')}`)
		assert.ok(m.calls().findIndex((l) => l.startsWith('security find')) < m.calls().indexOf(CREATE), 'an unreadable Keychain must stop the run before a repo exists')
		assert.equal(m.count('gh repo create'), 1)
		assert.equal(m.count('security add-generic-password'), 1)
		const cfg = m.config()
		assert.equal(cfg.vault.repo, REPO)
		assert.equal(cfg.library, true)
		assert.deepEqual(cfg.configSkip, ['keep/this'])
		assert.equal(cfg.device, 'cli-test')
		assert.match(r.out, /vault key export/)
		assert.match(r.out, /vault key confirm/)
		assert.deepEqual(readdirSync(join(m.sb.root)).filter((f) => f.includes('.partial')), [], 'no temp config left')
		assert.deepEqual(readdirSync(join(m.home, '.workpulse')), ['vault'], 'nothing but the clone left')

		const key = m.storedKey()
		assert.match(key, /^AGE-SECRET-KEY-1/)
		const stamped = { ...m.config(), vault: { ...m.config().vault, keyBackedUpAt: '2026-10-30T00:00:00.000Z' } }
		writeFileSync(m.sb.configPath, JSON.stringify(stamped))
		const second = m.run({}, 'vault', 'init', '--yes')
		assert.equal(second.status, 0, second.err)
		noKeyText(second)
		assert.equal(m.count('gh repo create'), 1, 'not re-created')
		assert.equal(m.count('gh repo clone'), 1, 'not re-cloned')
		assert.equal(m.count('security add-generic-password'), 1, 'key not touched')
		assert.equal(m.storedKey(), key)
		assert.equal(m.config().vault.keyBackedUpAt, '2026-10-30T00:00:00.000Z')
		assert.ok(!/key export/.test(second.out), 'the copy is recorded, so nothing more is asked')
	})

	test('after init the repo has a first commit on a branch, and a real backup through the stubs pushes its manifest there', () => {
		const m = mac()
		assert.equal(m.run({}, 'vault', 'init', '--yes').status, 0)
		assert.equal(execFileSync(realGit, ['-C', m.clone, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), 'main')
		execFileSync(realGit, ['--git-dir', m.paths.remote, 'rev-parse', '--verify', 'main'], { stdio: 'ignore' })
		const db = join(dir(), 'a.db')
		const DB = sqlite()
		const h = new DB(db)
		h.exec('CREATE TABLE t (v BLOB)')
		h.prepare('INSERT INTO t VALUES (?)').run(randomBytes(2000))
		h.close()
		const cfg = m.config()
		writeFileSync(m.sb.configPath, JSON.stringify({ ...cfg, vault: { ...cfg.vault, databases: [db], keyBackedUpAt: '2026-10-30T00:00:00.000Z' } }))
		const r = m.run({}, 'vault', 'backup', '--yes')
		assert.equal(r.status, 0, r.err)
		noKeyText(r)
		const pushed = JSON.parse(execFileSync(realGit, ['--git-dir', m.paths.remote, 'show', 'main:manifest/cli-test.json'], { encoding: 'utf8' }))
		assert.equal(pushed.items[0].keyFp, fingerprint(m.storedKey()))
	})

	test('a new Mac: the private repo exists, so it clones and writes the config, with no new repo and no new key, and points at key import', () => {
		const m = mac({ state: { repo: 'exists' } })
		seedRemote(m)
		const plan = m.run({}, 'vault', 'init')
		assert.equal(plan.status, 0, plan.err)
		assert.match(plan.out, /already exists/)
		assert.match(plan.out, /no new key|No new key/i)
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
		assert.equal(m.count('gh repo create'), 0)
		assert.equal(m.count('gh repo clone'), 1)
		assert.equal(m.count('security add-generic-password'), 0)
		assert.equal(m.storedKey(), null)
		assert.equal(m.config().vault.repo, REPO)
		assert.match(r.out, /vault key import/)
		assert.ok(existsSync(join(m.clone, '.git')))
	})

	test('an existing public repo refuses before any clone, and a repo that now answers to another name too', () => {
		const pub = mac({ state: { repo: 'exists', isPrivate: false } })
		const r = pub.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /public/)
		assert.equal(pub.count('gh repo clone'), 0)
		assert.equal(pub.config().vault, undefined)

		const moved = mac({ state: { repo: 'exists', name: 'someone/renamed' } })
		const s = moved.run({}, 'vault', 'init', '--yes')
		assert.notEqual(s.status, 0)
		assert.match(s.err, /someone\/renamed/)
		assert.equal(moved.count('gh repo clone'), 0)
		assert.equal(moved.config().vault, undefined)
	})

	test('gh unable to say whether the repo exists refuses: nothing created, no key', () => {
		const m = mac({ state: { repo: 'broken' } })
		for (const args of [['vault', 'init'], ['vault', 'init', '--yes']]) {
			const r = m.run({}, ...args)
			assert.notEqual(r.status, 0)
			assert.match(r.err, /could not say/i)
		}
		assert.equal(m.count('gh repo create'), 0)
		assert.equal(m.storedKey(), null)
		assert.equal(m.config().vault, undefined)
	})

	test('a Keychain that cannot be read stops the run before a repo or a key exists, and keeps its own message', () => {
		const m = mac()
		writeFileSync(m.paths.secBroken, '')
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /could not read the Keychain/)
		assert.ok(!/key import/.test(r.err))
		assert.equal(m.count('gh repo create'), 0)
		assert.equal(m.count('security add-generic-password'), 0)
		assert.equal(m.config().vault, undefined)
	})

	test('a key that cannot be saved leaves no config, and the next run finishes without a second repo', () => {
		const m = mac()
		writeFileSync(m.paths.secFailAdd, '')
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /could not save the key/)
		noKeyText(r)
		assert.equal(m.config().vault, undefined)
		rmSync(m.paths.secFailAdd)
		const again = m.run({}, 'vault', 'init', '--yes')
		assert.equal(again.status, 0, again.err)
		assert.equal(m.count('gh repo create'), 1)
		assert.equal(m.count('gh repo clone'), 1, 'the clone made by the first run is reused')
		assert.match(m.storedKey(), /^AGE-SECRET-KEY-1/)
	})

	test('an existing key is kept when the repo is new', () => {
		const m = mac({ key: KEY })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
		assert.equal(m.storedKey(), KEY)
		assert.equal(m.count('security add-generic-password'), 0)
		assert.equal(m.count('gh repo create'), 1)
	})

	test('gh not logged in, or a repo create that fails, refuses and prints no token', () => {
		const m = mac({ state: { auth: false } })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /gh auth login/)
		assert.ok(!r.err.includes('gho_stubtoken'))
		assert.equal(m.count('gh repo'), 0)

		const c = mac({ state: { failCreate: true } })
		const s = c.run({}, 'vault', 'init', '--yes')
		assert.notEqual(s.status, 0)
		assert.match(s.err, /could not create|Could not create/)
		assert.equal(c.storedKey(), null)
		assert.equal(c.config().vault, undefined)
		assert.ok(!existsSync(join(c.home, '.workpulse', 'vault.init-pending')))
	})

	test('no age on PATH refuses before gh is asked anything', () => {
		const m = mac()
		const r = m.run({ PATH: `${m.bin}:/usr/bin:/bin` }, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /brew install age/)
		assert.deepEqual(m.calls(), [])
	})

	test('--yes with a following word, an unknown option or an extra word changes nothing', () => {
		const m = mac()
		for (const args of [['--yes', 'please'], ['--force'], ['extra', '--yes']]) {
			const r = m.run({}, 'vault', 'init', ...args)
			assert.notEqual(r.status, 0, args.join(' '))
		}
		assert.deepEqual(m.calls(), [])
	})

	test('a clone whose origin is another repo refuses, and the config is not written', () => {
		const m = mac({ origin: 'https://github.com/someone/else.git', state: { repo: 'exists' } })
		mkdirSync(join(m.clone, '.git'), { recursive: true })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /does not push to/)
		assert.equal(m.config().vault, undefined)
	})

	test('a clone left over when the repo is gone refuses instead of creating a second history', () => {
		const m = mac()
		mkdirSync(join(m.clone, '.git'), { recursive: true })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /Move that clone aside/)
		assert.equal(m.count('gh repo create'), 0)
		assert.equal(m.config().vault, undefined)
	})

	test('a repository with no commit refuses, because every real run pulls', () => {
		const m = mac({ state: { emptyRepo: true } })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /no first commit/)
		assert.equal(m.config().vault, undefined)
	})

	test('a repository with no commit: following the advice works, on the second run, in the same clone, with one repo and a key', () => {
		const m = mac({ state: { emptyRepo: true } })
		const first = m.run({}, 'vault', 'init', '--yes')
		assert.match(first.err, /Add a README .* on GitHub, then run/)
		assert.ok(existsSync(join(m.clone, '.git')), 'the first run left the empty clone')
		const w = join(m.paths.remote, '..', 'readme')
		execFileSync(realGit, ['clone', '-q', m.paths.remote, w], { stdio: 'ignore' })
		writeFileSync(join(w, 'README.md'), 'x\n')
		execFileSync(realGit, ['-C', w, 'add', 'README.md'])
		execFileSync(realGit, ['-C', w, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'first'])
		execFileSync(realGit, ['-C', w, 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { stdio: 'ignore' })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
		assert.equal(m.count('gh repo create'), 1)
		assert.equal(m.count('gh repo clone'), 1)
		assert.equal(execFileSync(realGit, ['-C', m.clone, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), 'main')
		assert.equal(execFileSync(realGit, ['-C', m.clone, 'rev-parse', '--abbrev-ref', '@{u}'], { encoding: 'utf8' }).trim(), 'origin/main')
		assert.ok(existsSync(join(m.clone, 'README.md')))
		assert.match(m.storedKey(), /^AGE-SECRET-KEY-1/)
		assert.equal(m.config().vault.repo, REPO)
	})

	test('an empty clone whose remote cannot be reached says to move it aside', () => {
		const m = mac({ state: { repo: 'exists' } })
		seedRemote(m)
		execFileSync(realGit, ['init', '-q', '-b', 'main', m.clone], { stdio: 'ignore' })
		execFileSync(realGit, ['-C', m.clone, 'remote', 'add', 'origin', join(m.paths.remote, '..', 'gone.git')])
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /move .* aside/i)
		assert.equal(m.config().vault, undefined)
	})

	test('a stale marker makes no key for a repo whose manifests list encrypted items: it says key import and the marker goes', () => {
		const m = mac({ state: { repo: 'exists' } })
		seedRemote(m, { 'manifest/other.json': manifestOf(KEY) })
		mkdirSync(join(m.home, '.workpulse'))
		writeFileSync(`${m.clone}.init-pending`, REPO)
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
		assert.equal(m.storedKey(), null)
		assert.equal(m.count('security add-generic-password'), 0)
		assert.match(r.out, /vault key import/)
		assert.ok(!/delete the empty repo/.test(r.out), 'this repo holds backups')
		assert.equal(existsSync(`${m.clone}.init-pending`), false)
		assert.equal(m.config().vault.repo, REPO)
	})

	test('a stale marker with a clone that is behind pulls before it judges', () => {
		const m = mac({ state: { repo: 'exists' } })
		seedRemote(m)
		mkdirSync(join(m.home, '.workpulse'))
		execFileSync(realGit, ['clone', '-q', m.paths.remote, m.clone], { stdio: 'ignore' })
		const w = join(m.paths.remote, '..', 'seed')
		mkdirSync(join(w, 'manifest'))
		writeFileSync(join(w, 'manifest', 'other.json'), manifestOf(KEY))
		execFileSync(realGit, ['-C', w, 'add', 'manifest/other.json'])
		execFileSync(realGit, ['-C', w, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'later'])
		execFileSync(realGit, ['-C', w, 'push', '-q', m.paths.remote, 'HEAD:refs/heads/main'], { stdio: 'ignore' })
		writeFileSync(`${m.clone}.init-pending`, REPO)
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
		assert.equal(m.storedKey(), null)
		assert.ok(existsSync(join(m.clone, 'manifest', 'other.json')))
	})

	test('a stale marker with a clone that cannot be brought up to date makes no key and says why', () => {
		const m = mac({ state: { repo: 'exists' } })
		seedRemote(m)
		mkdirSync(join(m.home, '.workpulse'))
		execFileSync(realGit, ['clone', '-q', m.paths.remote, m.clone], { stdio: 'ignore' })
		execFileSync(realGit, ['-C', m.clone, 'remote', 'set-url', 'origin', join(m.paths.remote, '..', 'gone.git')])
		writeFileSync(`${m.clone}.init-pending`, REPO)
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /no key was made/i)
		assert.equal(m.storedKey(), null)
		assert.equal(m.config().vault, undefined)
	})

	test('an existing repo with no encrypted items and no key on this Mac also says how to get out if no copy exists', () => {
		const m = mac({ state: { repo: 'exists' } })
		seedRemote(m)
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
		assert.match(r.out, /If no copy of a key exists and the repository holds no encrypted items, delete the empty repository and run this again/)
	})

	test('a create that fails says what to do if GitHub made the repo anyway', () => {
		const m = mac({ state: { failCreate: true } })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /delete the empty repository and run this again/)
	})

	test('a new key clears the offline-copy record of an old one, in the same write, and asks for a copy; backup then refuses', () => {
		const m = mac({ config: { vault: { repo: REPO, keyBackedUpAt: '2026-01-01T00:00:00.000Z', keyBackedUpFp: 'deadbeef' } } })
		const r = m.run({}, 'vault', 'init', '--yes')
		assert.equal(r.status, 0, r.err)
		assert.match(m.storedKey(), /^AGE-SECRET-KEY-1/)
		assert.equal(m.config().vault.keyBackedUpAt, null)
		assert.equal(m.config().vault.keyBackedUpFp, null)
		assert.match(r.out, /vault key export/)
		assert.match(r.out, /vault key confirm/)
		const cfg = m.config()
		const db = join(dir(), 'a.db')
		const DB = sqlite()
		const h = new DB(db)
		h.exec('CREATE TABLE t (v BLOB)')
		h.close()
		writeFileSync(m.sb.configPath, JSON.stringify({ ...cfg, vault: { ...cfg.vault, databases: [db] } }))
		const b = m.run({}, 'vault', 'backup', '--yes')
		assert.notEqual(b.status, 0)
		assert.match(b.err, /offline copy/)
	})

	test('backup goes by whose copy it is: a stamp for another key refuses, and doctor, status and init say so; the right one passes', () => {
		const m = mac()
		assert.equal(m.run({}, 'vault', 'init', '--yes').status, 0)
		const db = join(dir(), 'a.db')
		const DB = sqlite()
		const h = new DB(db)
		h.exec('CREATE TABLE t (v BLOB)')
		h.close()
		const stamp = (keyBackedUpFp) => {
			const cfg = m.config()
			writeFileSync(m.sb.configPath, JSON.stringify({ ...cfg, vault: { ...cfg.vault, databases: [db], keyBackedUpAt: '2026-10-30T00:00:00.000Z', keyBackedUpFp } }))
		}
		stamp('deadbeef')
		const refused = m.run({}, 'vault', 'backup', '--yes')
		assert.notEqual(refused.status, 0)
		assert.match(refused.err, /offline copy/)
		assert.match(m.run({}, 'vault', 'status').out, /Offline copy:\s+not recorded/)
		assert.match(m.run({}, 'vault', 'init', '--yes').out, /vault key export/)
		assert.match(m.run({}, 'doctor').out.split('\n').find((l) => l.includes('Vault key copy')), /^!.*vault key export/)
		stamp(fingerprint(m.storedKey()))
		const ok = m.run({}, 'vault', 'backup', '--yes')
		assert.equal(ok.status, 0, ok.err)
		assert.match(m.run({}, 'vault', 'status').out, /Offline copy:\s+recorded/)
	})

	test('a brain.json reached through a link stays a link, and keeps its mode', () => {
		const m = mac()
		const real = join(dir(), 'real.json')
		writeFileSync(real, m.rawConfig(), { mode: 0o640 })
		rmSync(m.sb.configPath)
		symlinkSync(real, m.sb.configPath)
		assert.equal(m.run({}, 'vault', 'init', '--yes').status, 0)
		assert.equal(JSON.parse(readFileSync(real, 'utf8')).vault.repo, REPO)
		assert.equal(statSync(real).mode & 0o777, 0o640)
	})

	test('setting up the Brain again keeps the vault section', () => {
		const vault = { repo: REPO, keyBackedUpAt: '2026-10-30T00:00:00.000Z' }
		const m = mac({ config: { vault } })
		const r = m.run({}, 'init', 'test/brain', '--clone', m.sb.clone, '--device', 'cli-test', '--no-push')
		assert.equal(r.status, 0, r.err)
		assert.deepEqual(m.config().vault, vault)
	})
})

describe('vault key, in a real subprocess: stdout and stdin are not a terminal', () => {
	const on = (more = {}) => mac({ key: KEY, config: { vault: { repo: REPO } }, ...more })

	test('export refuses without touching the Keychain and without the key', () => {
		const m = on()
		const r = m.run({}, 'vault', 'key', 'export')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /terminal/)
		noKeyText(r)
		assert.deepEqual(m.calls(), [])
	})

	test('confirm and import refuse where nobody can type', () => {
		const m = on()
		mkdirSync(join(m.clone, '.git'), { recursive: true })
		for (const sub of ['confirm', 'import']) {
			const r = m.run({ input: `${KEY.slice(-4)}\n` }, 'vault', 'key', sub)
			assert.notEqual(r.status, 0, sub)
			assert.match(r.err, /terminal/, sub)
			noKeyText(r)
		}
		assert.equal(m.config().vault.keyBackedUpAt, undefined)
		assert.equal(m.count('security add-generic-password'), 0)
	})

	test('a key command with the vault off, or an unknown one, says what to do', () => {
		const off = mac()
		const r = off.run({}, 'vault', 'key', 'export')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /vault init/)
		const m = on()
		assert.notEqual(m.run({}, 'vault', 'key').status, 0)
		assert.notEqual(m.run({}, 'vault', 'key', 'rotate').status, 0)
		assert.notEqual(m.run({}, 'vault', 'key', 'export', '--yes').status, 0)
	})

	test('list and status print no key', () => {
		const m = on()
		for (const sub of ['list', 'status']) noKeyText(m.run({}, 'vault', sub))
	})
})

describe('vault key, with the terminal injected', () => {
	function ctx({ key = KEY, typed = '', pasted = '', isTTY = true, vault = { repo: REPO }, withClone = true, items = null } = {}) {
		const config = join(dir(), 'brain.json')
		const cfg = { repo: 'test/brain', library: true, device: 'mac', vault }
		writeFileSync(config, JSON.stringify(cfg))
		const clone = join(dir(), 'vault')
		if (withClone) {
			mkdirSync(join(clone, '.git'), { recursive: true })
			if (items) {
				mkdirSync(join(clone, 'manifest'))
				writeFileSync(join(clone, 'manifest', 'mac.json'), JSON.stringify({ version: 1, device: 'mac', items }))
			}
		}
		const store = fakeKeystore()
		if (key) store.set('me', key)
		const sets = []
		const logged = []
		const prompts = []
		const deps = {
			cfg,
			configPath: config,
			clone,
			cloneRepo: () => REPO,
			keystore: { ...store, set: (a, k) => (sets.push(a), store.set(a, k)) },
			isTTY,
			prompt: async (q) => (prompts.push(q), typed),
			promptHidden: async (q) => (prompts.push(q), pasted),
			log: (l) => logged.push(l),
			now: () => Date.parse('2026-10-31T10:00:00.000Z'),
		}
		const go = (sub) => runVaultCli({ pos: ['key', sub], opt: {} }, deps)
		return { go, config, store, sets, logged, prompts, text: () => logged.join('\n'), vault: () => JSON.parse(readFileSync(config, 'utf8')).vault, file: () => JSON.parse(readFileSync(config, 'utf8')) }
	}
	const item = (keyFp) => ({ id: 'i-0000000000000000', kind: 'database', name: 'a.db', size: 1, sha256: 'a'.repeat(64), date: '2026-10-30T00:00:00.000Z', release: 'snap-x', encrypted: true, keyFp, parts: [{ asset: 'x.part001', size: 1, sha256: 'a'.repeat(64) }] })

	test('export prints the key once, with the offline-copy words', async () => {
		const t = ctx()
		await t.go('export')
		assert.equal(t.text().split(KEY).length - 1, 1)
		assert.match(t.text(), /write it down or print it/i)
		assert.match(t.text(), /not this Mac/)
		assert.match(t.text(), /password manager/)
		assert.match(t.text(), /paper copy/)
		assert.match(t.text(), /never paste it into a chat/i)
		assert.match(t.text(), /vault key confirm/)
	})

	test('export refuses when stdout is no terminal, or names import when there is no key', async () => {
		const t = ctx({ isTTY: false })
		await assert.rejects(t.go('export'), (e) => /terminal/.test(e.message) && !e.message.includes(KEY))
		assert.equal(t.logged.length, 0)
		await assert.rejects(ctx({ key: null }).go('export'), /vault key import/)
	})

	test('confirm with the wrong last 4 characters fails, says nothing of them, and records nothing', async () => {
		const wrong = KEY.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'
		for (const typed of [wrong, '', KEY.slice(-3), KEY.slice(-5)]) {
			const t = ctx({ typed })
			await assert.rejects(t.go('confirm'), (e) => /last 4/.test(e.message) && !e.message.includes(KEY.slice(-4)))
			assert.equal(t.vault().keyBackedUpAt, undefined)
		}
	})

	test('confirm with the right ones sets keyBackedUpAt and keeps the rest of brain.json, with the fingerprint of the key it is for', async () => {
		const t = ctx({ typed: ` ${KEY.slice(-4)} `, vault: { repo: REPO, keep: { recent: 2 } } })
		await t.go('confirm')
		assert.equal(t.vault().keyBackedUpAt, '2026-10-31T10:00:00.000Z')
		assert.equal(t.vault().keyBackedUpFp, fingerprint(KEY))
		assert.deepEqual(t.vault().keep, { recent: 2 })
		assert.equal(t.file().library, true)
		assert.ok(t.prompts[0].includes('last 4'))
		assert.ok(!t.prompts[0].includes(KEY.slice(-4)))
		assert.ok(!t.text().includes(KEY))
	})

	test('confirm with no key on this Mac names import; a Keychain that cannot be read keeps its message', async () => {
		await assert.rejects(ctx({ key: null, typed: 'abcd' }).go('confirm'), /vault key import/)
		const t = ctx()
		const broken = runVaultCli({ pos: ['key', 'confirm'], opt: {} }, { cfg: { device: 'mac', vault: { repo: REPO } }, keystore: { get() { throw new Error('could not read the Keychain') }, set() { throw new Error('must not be called') } }, configPath: t.config, prompt: async () => 'x', log: () => {} })
		await assert.rejects(broken, /could not read the Keychain/)
	})

	test('import of a key with the wrong fingerprint is refused and the Keychain is unchanged', async () => {
		const t = ctx({ key: null, pasted: OTHER, items: [item(fingerprint(KEY))] })
		await assert.rejects(t.go('import'), (e) => /fingerprint/.test(e.message) && !e.message.includes(OTHER))
		assert.deepEqual(t.sets, [])
		assert.equal(t.store.get('me'), null)
	})

	test('import with the right fingerprint saves under the repo owner, and says the copy still needs confirm', async () => {
		const t = ctx({ key: null, pasted: `  ${KEY}\n`, items: [item(fingerprint(KEY))] })
		await t.go('import')
		assert.equal(t.store.get('me'), KEY)
		assert.deepEqual(t.sets, ['me'])
		assert.ok(!t.text().includes(KEY))
		assert.match(t.text(), new RegExp(fingerprint(KEY)))
		assert.match(t.text(), /matches/)
		assert.match(t.text(), /vault key confirm/)
		assert.match(t.prompts[0], /not shown/)
	})

	test('import with no manifest items saves and says the fingerprint could not be checked', async () => {
		for (const items of [null, []]) {
			const t = ctx({ key: null, pasted: KEY, items })
			await t.go('import')
			assert.equal(t.store.get('me'), KEY)
			assert.match(t.text(), /could not be checked/)
		}
	})

	test('import into an empty Keychain with nothing to check clears an old copy record, and asks for confirm', async () => {
		const t = ctx({ key: null, pasted: KEY, vault: { repo: REPO, keyBackedUpAt: '2026-01-01T00:00:00.000Z' }, items: [] })
		await t.go('import')
		assert.equal(t.vault().keyBackedUpAt, null)
		assert.match(t.text(), /vault key confirm/)
	})

	test('import does not stamp the copy, and keeps a record it checked against the manifests', async () => {
		const fresh = ctx({ key: null, pasted: KEY, items: [item(fingerprint(KEY))] })
		await fresh.go('import')
		assert.equal(fresh.vault().keyBackedUpAt, undefined)
		const kept = ctx({ key: null, pasted: KEY, vault: { repo: REPO, keyBackedUpAt: '2026-01-01T00:00:00.000Z', keyBackedUpFp: fingerprint(KEY) }, items: [item(fingerprint(KEY))] })
		await kept.go('import')
		assert.equal(kept.vault().keyBackedUpAt, '2026-01-01T00:00:00.000Z')
		assert.ok(!/vault key confirm/.test(kept.text()))
	})

	test('import pulls first, so a manifest newer than the clone refuses the key', async () => {
		const box = dir()
		const remote = join(box, 'remote.git')
		const w = join(box, 'w')
		const clone = join(box, 'clone')
		const g = (...a) => execFileSync(realGit, a, { stdio: 'ignore' })
		g('init', '-q', '-b', 'main', w)
		writeFileSync(join(w, 'README.md'), 'x\n')
		g('-C', w, 'add', 'README.md')
		g('-C', w, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'first')
		g('clone', '-q', '--bare', w, remote)
		g('clone', '-q', remote, clone)
		mkdirSync(join(w, 'manifest'))
		writeFileSync(join(w, 'manifest', 'other.json'), JSON.stringify({ version: 1, device: 'other', items: [item(fingerprint(KEY))] }))
		g('-C', w, 'add', 'manifest/other.json')
		g('-C', w, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'later')
		g('-C', w, 'push', '-q', remote, 'HEAD:refs/heads/main')
		const store = fakeKeystore()
		const config = join(box, 'brain.json')
		const cfg = { device: 'mac', vault: { repo: REPO } }
		writeFileSync(config, JSON.stringify(cfg))
		await assert.rejects(runVaultCli({ pos: ['key', 'import'], opt: {} }, { cfg, configPath: config, clone, cloneRepo: () => REPO, keystore: store, promptHidden: async () => OTHER, log: () => {} }), /fingerprint/)
		assert.equal(store.get('me'), null)
	})

	test('import says so when the clone could not be refreshed, and still checks what it has', async () => {
		const t = ctx({ key: null, pasted: KEY, items: [item(fingerprint(KEY))] })
		await t.go('import')
		assert.match(t.text(), /could not refresh/i)
		assert.equal(t.store.get('me'), KEY)
	})

	test('import refuses a different key already stored, and does not rewrite the same one', async () => {
		const t = ctx({ key: OTHER, pasted: KEY, items: [item(fingerprint(KEY))] })
		await assert.rejects(t.go('import'), (e) => /different/.test(e.message) && !e.message.includes(KEY) && !e.message.includes(OTHER))
		assert.deepEqual(t.sets, [])
		assert.equal(t.store.get('me'), OTHER)
		const same = ctx({ key: KEY, pasted: KEY })
		await same.go('import')
		assert.deepEqual(same.sets, [])
		assert.match(same.text(), /already/)
	})

	test('import of a text that is no key is refused without echoing it; so is a typo', async () => {
		const typo = `${KEY.slice(0, -1)}${KEY.at(-1) === 'Q' ? 'P' : 'Q'}`
		for (const pasted of ['hello there', typo, '']) {
			const t = ctx({ key: null, pasted })
			await assert.rejects(t.go('import'), (e) => e.message === 'not a valid vault key')
			assert.equal(t.store.get('me'), null)
		}
	})

	test('import with no clone says vault init, before asking for the key', async () => {
		const t = ctx({ key: null, pasted: KEY, withClone: false })
		await assert.rejects(t.go('import'), /vault init/)
		assert.deepEqual(t.prompts, [])
	})

	test('one bad manifest stops the import before the key is asked for', async () => {
		const t = ctx({ key: null, pasted: KEY, items: [{ ...item('x'), name: '../evil' }] })
		await assert.rejects(t.go('import'), /vault manifest/)
		assert.deepEqual(t.prompts, [])
		assert.equal(t.store.get('me'), null)
	})
})

describe('readLine', () => {
	const io = () => {
		const input = new PassThrough()
		const output = new PassThrough()
		let shown = ''
		output.on('data', (c) => (shown += c))
		return { input, output, shown: () => shown }
	}

	test('hidden input returns what was typed and never writes it out', async () => {
		const s = io()
		const got = readLine('Paste: ', { input: s.input, output: s.output, hidden: true })
		s.input.write('AGE-SECRET-KEY-1HIDDEN\n')
		assert.equal(await got, 'AGE-SECRET-KEY-1HIDDEN')
		assert.match(s.shown(), /^Paste: /)
		assert.ok(!s.shown().includes('HIDDEN'))
	})

	test('a closed input is a cancel, not an empty answer', async () => {
		const s = io()
		const got = readLine('Paste: ', { input: s.input, output: s.output, hidden: true })
		s.input.end()
		await assert.rejects(got, /Cancelled/)
	})
})

describe('doctor', () => {
	const doctor = (m) => m.run({}, 'doctor')
	const line = (out, what) => out.split('\n').find((l) => l.includes(what)) ?? ''
	// Doctor asks gh once whether the Brain's own repository is private; that isn't the vault.
	const vaultCalls = (m) => m.calls().filter((l) => (l.startsWith('security') || l.startsWith('gh ')) && !l.startsWith('gh repo view me/brain --json isPrivate'))

	test('off: one row, and neither gh nor the Keychain is asked', () => {
		const m = mac()
		const r = doctor(m)
		assert.match(line(r.out, 'Vault'), /off/)
		assert.deepEqual(vaultCalls(m), [])
	})

	test('on: age, key, offline copy, private repo and last verified snapshot, and never a key', () => {
		const verifiedAt = '2026-10-30T09:00:00.000Z'
		const m = mac({ key: KEY, config: { vault: { repo: REPO, keyBackedUpAt: '2026-10-29T00:00:00.000Z' } } })
		mkdirSync(join(m.clone, '.git'), { recursive: true })
		mkdirSync(join(m.clone, 'manifest'), { recursive: true })
		writeFileSync(join(m.clone, 'manifest', 'cli-test.json'), JSON.stringify({ version: 1, device: 'cli-test', items: [
			{ id: 'i-0000000000000001', kind: 'database', name: 'a.db', size: 1, sha256: 'a'.repeat(64), date: '2026-10-30T08:00:00.000Z', release: 'snap-x', encrypted: true, keyFp: fingerprint(KEY), parts: [], verifiedAt },
			{ id: 'i-0000000000000002', kind: 'video', name: 'v.mp4', size: 1, sha256: 'b'.repeat(64), date: '2026-10-31T08:00:00.000Z', release: 'videos-0001', encrypted: false, parts: [], verifiedAt: '2026-10-31T09:00:00.000Z' },
		] }))
		m.setState({ repo: 'exists' })
		const r = doctor(m)
		noKeyText(r)
		assert.match(line(r.out, 'Vault  '), /^✓ Vault\s+on — device cli-test$/)
		assert.match(line(r.out, 'Vault age'), /^✓/)
		assert.match(line(r.out, 'Vault key '), new RegExp(`^✓.*present.*${fingerprint(KEY)}`))
		assert.match(line(r.out, 'Vault key copy'), /^✓.*2026-10-29/)
		assert.match(line(r.out, 'Vault repo'), /^✓.*private/)
		assert.match(line(r.out, 'Vault snapshot'), new RegExp(`^✓.*${verifiedAt}`))
		assert.ok(m.calls().includes('security find-generic-password'), 'the stub answered')
		assert.ok(m.calls().every((l) => !l.startsWith('security add')))
	})

	test('on with nothing done yet: warnings that say what to run; a public repo is a problem that fails the check', () => {
		const m = mac({ config: { vault: { repo: REPO } }, state: { repo: 'exists', isPrivate: false } })
		const r = doctor(m)
		noKeyText(r)
		assert.notEqual(r.status, 0)
		assert.match(line(r.out, 'Vault repo'), /^✗.*public/)
		assert.match(line(r.out, 'Vault key '), /^!.*vault key import/)
		assert.match(line(r.out, 'Vault key copy'), /^!.*vault key export/)
		assert.match(line(r.out, 'Vault snapshot'), /^!.*vault init/)
	})

	test('a Keychain that cannot be read, a bad manifest and a bad vault section each show as a row, not a crash', () => {
		const m = mac({ key: KEY, config: { vault: { repo: REPO } }, state: { repo: 'exists' } })
		writeFileSync(m.paths.secBroken, '')
		mkdirSync(join(m.clone, '.git'), { recursive: true })
		mkdirSync(join(m.clone, 'manifest'), { recursive: true })
		writeFileSync(join(m.clone, 'manifest', 'x.json'), '{not json')
		const r = doctor(m)
		assert.match(line(r.out, 'Vault key '), /could not read the Keychain/)
		assert.match(line(r.out, 'Vault snapshot'), /^!.*manifests could not be read/)
		assert.ok(r.out.includes('Skill'), 'the rest of the doctor still ran')

		const bad = mac({ config: { vault: { repo: 'not a repo' } } })
		const b = doctor(bad)
		assert.match(line(b.out, 'Vault'), /vault\.repo/)
		assert.equal(vaultCalls(bad).length, 0)
	})

	test('no age on PATH shows as a row naming brew', () => {
		const m = mac({ key: KEY, config: { vault: { repo: REPO } }, state: { repo: 'exists' } })
		const r = m.run({ PATH: `${m.bin}:/usr/bin:/bin` }, 'doctor')
		assert.match(line(r.out, 'Vault age'), /^!.*brew install age/)
	})
})

test('the Brain skill has a Vault section with the rules the owner set', () => {
	const skill = readFileSync(join(here, '..', 'skills', 'workpulse-brain', 'SKILL.md'), 'utf8')
	const at = skill.indexOf('\n## Vault')
	assert.ok(at > 0)
	const next = skill.indexOf('\n## ', at + 5)
	const section = skill.slice(at, next)
	for (const sub of ['vault init', 'vault key export', 'vault key confirm', 'vault key import', 'vault backup', 'vault list', 'vault status', 'vault restore', 'vault prune']) assert.ok(section.includes(sub), sub)
	assert.match(section, /Claude never runs `vault key export`/)
	assert.match(section, /age key/)
	assert.match(section, /[Aa]sk the owner before every `--yes`/)
	assert.match(section, /not this Mac/)
	assert.match(section, /paper copy/)
	assert.match(section, /one bad manifest/i)
	assert.match(section, /prune stops/i)
	assert.ok(!section.includes('AGE-SECRET-KEY-1'))
})
