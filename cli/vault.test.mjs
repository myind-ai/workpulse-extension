// wp-brain vault commands. Fake storage, fake key store and a local bare remote; real age and real SQLite.
// The CLI tests run with HOME, WP_BRAIN_CONFIG and visibility set, and stub gh and security first on PATH.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { sqlite } from './brain-db.mjs'
import { brainSandbox } from './sandbox.mjs'
import { backup, cloneRepoOf, list, pullRebase, repoFromUrl, runVaultCli, status } from './vault.mjs'
import { prune } from './vault-prune.mjs'
import { restore } from './vault-restore.mjs'
import { decryptFile, fakeKeystore, fingerprint, newKey } from './vault-crypto.mjs'
import { fakeStorage } from './vault-fake.mjs'
import { parseVaultConfig, readManifest, writeManifest } from './vault-manifest.mjs'
import { gunzipTo, sha256File } from './vault-pack.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'wp-vault-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const dir = () => {
	const d = join(root, `t${n++}`)
	mkdirSync(d)
	return d
}
const sha = (b) => createHash('sha256').update(b).digest('hex')
const joinParts = async (files, dest) => writeFileSync(dest, Buffer.concat(files.map((f) => readFileSync(f))))
const KEY = await newKey()
const TOKEN = `ghp_${'a1B2'.repeat(9)}`

/** A real SQLite file with `bytes` of incompressible data. */
function makeDb(path, bytes = 5000) {
	const DB = sqlite()
	const db = new DB(path)
	db.exec('CREATE TABLE t (v BLOB)')
	db.prepare('INSERT INTO t VALUES (?)').run(randomBytes(bytes))
	db.close()
	return path
}

/** A ctx with a fake storage in a folder, a fake key store, a temp staging folder and a clone with a local bare remote. */
function setup({ videos = [], databases = [], key = KEY, keyBackedUpAt = '2026-10-30T00:00:00.000Z', fake = {}, visibility = 'private', wrap = (s) => s, ...more } = {}) {
	const sb = brainSandbox()
	const store = dir()
	const puts = []
	const keystore = fakeKeystore()
	if (key) keystore.set('me', key)
	const sets = []
	const logged = []
	const ctx = {
		cfg: parseVaultConfig({ device: 'mac', vault: { repo: 'me/workpulse-vault', videos, databases, ...(keyBackedUpAt ? { keyBackedUpAt } : {}) } }),
		keystore: { ...keystore, set: (a, k) => (sets.push(a), keystore.set(a, k)) },
		clone: sb.clone,
		now: () => Date.parse('2026-10-31T10:00:00.000Z'),
		log: (l) => logged.push(l),
		stagingDir: join(dir(), 'vault-tmp'),
		partBytes: 1000,
		freeBytes: () => 1e12,
		repoVisibility: () => visibility,
		cloneRepo: () => 'me/workpulse-vault',
		...more,
	}
	const withStorage = (extra) => {
		const s = fakeStorage(store, extra)
		return { ...ctx, storage: wrap({ ...s, putAsset: async (tag, file, name) => (puts.push(name), s.putAsset(tag, file, name)) }) }
	}
	ctx.storage = withStorage(fake).storage
	const manifest = () => readManifest(join(sb.clone, 'manifest', 'mac.json'))
	const pushed = () => {
		try {
			return JSON.parse(sb.git('--git-dir', sb.remote, 'show', 'main:manifest/mac.json'))
		} catch {
			return null
		}
	}
	const release = (tag) => JSON.parse(readFileSync(join(store, tag, 'release.json'), 'utf8'))
	const assets = (tag) => readdirSync(join(store, tag, 'assets')).sort()
	const asset = (tag, name) => join(store, tag, 'assets', name)
	const tags = () => readdirSync(store).sort()
	return { ctx, sb, store, puts, sets, logged, withStorage, manifest, pushed, release, assets, asset, tags, text: () => logged.join('\n') }
}

const REAL = { yes: true }

describe('refusals before anything is read', () => {
	for (const visibility of ['public', 'unknown']) {
		test(`a ${visibility} repo refuses before reading a source, also on a dry run`, async () => {
			const t = setup({ visibility, videos: ['/nonexistent/videos'], databases: ['/nonexistent/a.db'], keyBackedUpAt: null, key: null })
			await assert.rejects(backup(t.ctx, REAL), /private/)
			await assert.rejects(backup(t.ctx, {}), /private/)
			assert.equal(existsSync(t.ctx.stagingDir), false)
			assert.deepEqual(t.tags(), [])
		})
	}

	test('an encrypted item with no key refuses, names key import, and makes no key', async () => {
		const d = dir()
		const t = setup({ databases: [makeDb(join(d, 'a.db'))], key: null })
		await assert.rejects(backup(t.ctx, REAL), /run `wp-brain vault key import`/)
		assert.deepEqual(t.sets, [])
		assert.deepEqual(t.tags(), [])
	})

	test('a Keychain that cannot be read is not reported as a missing key', async () => {
		const d = dir()
		const t = setup({ databases: [makeDb(join(d, 'a.db'))] })
		const ctx = { ...t.ctx, keystore: { get() { throw new Error('could not read the Keychain') }, set() { throw new Error('must not be called') } } }
		await assert.rejects(backup(ctx, REAL), (e) => /could not read the Keychain/.test(e.message) && !/key import/.test(e.message))
	})

	test('an encrypted item before the offline key copy refuses and says export then confirm', async () => {
		const d = dir()
		const t = setup({ databases: [makeDb(join(d, 'a.db'))], keyBackedUpAt: null })
		await assert.rejects(backup(t.ctx, REAL), (e) => /vault key export/.test(e.message) && /vault key confirm/.test(e.message))
		assert.deepEqual(t.tags(), [])
	})

	test('videos alone need no key', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d], key: null, keyBackedUpAt: null })
		const r = await backup(t.ctx, REAL)
		assert.equal(r.uploaded.length, 1)
	})

	test('not enough free disk stops before staging', async () => {
		const d = dir()
		const t = setup({ databases: [makeDb(join(d, 'a.db'))], freeBytes: () => 10 })
		await assert.rejects(backup(t.ctx, REAL), /free disk/i)
		assert.deepEqual(readdirSync(t.ctx.stagingDir).filter((f) => f !== '.lock'), [])
		assert.deepEqual(t.tags(), [])
	})

	test('a part size at or over 2 GiB is refused, from ctx and from the environment', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d], partBytes: 2 * 1024 ** 3 })
		await assert.rejects(backup(t.ctx, REAL), /2 GiB/)
		const u = setup({ videos: [d], partBytes: undefined })
		process.env.WP_VAULT_PART_BYTES = String(2 * 1024 ** 3)
		try {
			await assert.rejects(backup(u.ctx, REAL), /2 GiB/)
		} finally {
			delete process.env.WP_VAULT_PART_BYTES
		}
	})

	test('a clone whose origin is another repo, or none we can read, refuses before reading a source', async () => {
		for (const cloneRepo of [() => 'someone/else', () => null]) {
			const t = setup({ videos: ['/nonexistent/videos'], databases: ['/nonexistent/a.db'], cloneRepo })
			await assert.rejects(backup(t.ctx, REAL), /does not push to me\/workpulse-vault/)
			await assert.rejects(backup(t.ctx, {}), /does not push to me\/workpulse-vault/)
			assert.deepEqual(t.tags(), [])
			assert.equal(t.manifest(), null)
		}
		const u = setup({ cloneRepo: () => 'ME/WorkPulse-Vault' })
		await backup(u.ctx, REAL) // GitHub names ignore case
	})

	test('repoFromUrl takes the usual https and ssh forms of github.com, and nothing else', () => {
		for (const url of ['https://github.com/me/my.vault.git', 'https://github.com/me/my.vault', 'https://github.com/me/my.vault/', 'https://tok@github.com/me/my.vault.git', 'git@github.com:me/my.vault.git', 'ssh://git@github.com/me/my.vault.git', 'ssh://git@ssh.github.com:443/me/my.vault.git\n']) assert.equal(repoFromUrl(url), 'me/my.vault', url)
		for (const url of ['/tmp/remote.git', 'https://gitlab.com/me/v.git', 'https://github.com.evil.io/me/v.git', 'https://evil.io/github.com/me/v.git', 'git@gitlab.com:me/v.git', 'https://github.com/me']) assert.equal(repoFromUrl(url), null, url)
	})

	test('cloneRepoOf reads fetch and push URLs: a push URL elsewhere gives null', () => {
		const { sb } = setup({})
		assert.equal(cloneRepoOf(sb.clone), null, 'a local remote is not a repo')
		sb.git('-C', sb.clone, 'remote', 'set-url', 'origin', 'https://github.com/me/workpulse-vault.git')
		assert.equal(cloneRepoOf(sb.clone), 'me/workpulse-vault')
		sb.git('-C', sb.clone, 'remote', 'set-url', '--push', 'origin', 'git@github.com:someone/public.git')
		assert.equal(cloneRepoOf(sb.clone), null)
		assert.equal(cloneRepoOf(join(sb.root, 'nowhere')), null)
	})

	test('cloneRepoOf looks at every URL: one more push or fetch URL elsewhere gives null, and all alike is fine', () => {
		const { sb } = setup({})
		const g = (...a) => sb.git('-C', sb.clone, 'remote', ...a)
		g('set-url', 'origin', 'https://github.com/me/workpulse-vault.git')
		g('set-url', '--add', '--push', 'origin', 'https://github.com/me/workpulse-vault.git')
		g('set-url', '--add', '--push', 'origin', 'git@github.com:me/workpulse-vault.git')
		assert.equal(cloneRepoOf(sb.clone), 'me/workpulse-vault')
		g('set-url', '--add', '--push', 'origin', 'https://github.com/someone/public.git')
		assert.equal(sb.git('-C', sb.clone, 'remote', 'get-url', '--push', 'origin').trim(), 'https://github.com/me/workpulse-vault.git', 'plain get-url hides the others')
		assert.equal(cloneRepoOf(sb.clone), null)
		g('set-url', '--delete', '--push', 'origin', 'someone/public')
		assert.equal(cloneRepoOf(sb.clone), 'me/workpulse-vault')
		g('set-url', '--add', 'origin', 'https://github.com/someone/public.git')
		assert.equal(cloneRepoOf(sb.clone), null)
	})

	test('two push URLs, one elsewhere: the real check refuses and the message prints neither URL', async () => {
		const t = setup({})
		const ctx = { ...t.ctx }
		delete ctx.cloneRepo
		const g = (...a) => t.sb.git('-C', t.sb.clone, 'remote', ...a)
		g('set-url', 'origin', 'https://github.com/me/workpulse-vault.git')
		g('set-url', '--add', '--push', 'origin', 'https://github.com/me/workpulse-vault.git')
		g('set-url', '--add', '--push', 'origin', `https://x:${TOKEN}@github.com/someone/public.git`)
		await assert.rejects(backup(ctx, REAL), (e) => /does not push to/.test(e.message) && !e.message.includes(TOKEN) && !e.message.includes('someone/public'))
	})

	test('a run does not remove a lock it does not hold, and a held lock always names its run', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const seen = {}
		const t = setup({
			videos: [d],
			wrap: (s) => ({
				...s,
				createRelease: async (...a) => {
					const lock = join(t.ctx.stagingDir, '.lock')
					seen.lock = readFileSync(lock, 'utf8')
					seen.files = readdirSync(t.ctx.stagingDir)
					writeFileSync(lock, '999999') // another run's, from here on
					return s.createRelease(...a)
				},
			}),
		})
		await backup(t.ctx, REAL)
		assert.equal(seen.lock, String(process.pid))
		assert.ok(!seen.files.some((f) => f.endsWith('.partial')), 'the temp file is gone once linked')
		assert.equal(readFileSync(join(t.ctx.stagingDir, '.lock'), 'utf8'), '999999')
	})

	test('a killed run\'s lock leftovers are cleared; a live run\'s are not', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d] })
		mkdirSync(t.ctx.stagingDir, { recursive: true })
		const dead = spawnSync('node', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim()
		const deadFile = join(t.ctx.stagingDir, `.lock.${dead}.partial`)
		const liveFile = join(t.ctx.stagingDir, `.lock.${process.ppid}.partial`)
		writeFileSync(deadFile, dead)
		writeFileSync(liveFile, String(process.ppid))
		await backup(t.ctx, REAL)
		assert.equal(existsSync(deadFile), false)
		assert.equal(existsSync(liveFile), true)
	})

	test('a refusal message never prints the origin URL', async () => {
		const t = setup({ cloneRepo: undefined })
		const ctx = { ...t.ctx }
		delete ctx.cloneRepo
		const secretUrl = `https://x:${TOKEN}@gitlab.com/me/v.git`
		t.sb.git('-C', t.sb.clone, 'remote', 'set-url', 'origin', secretUrl)
		await assert.rejects(backup(ctx, REAL), (e) => /does not push/.test(e.message) && !e.message.includes(TOKEN))
	})

	test('an empty or garbled lock file is no live run', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		for (const text of ['', 'garbage', '0', '-1', '1.5']) {
			const t = setup({ videos: [d] })
			mkdirSync(t.ctx.stagingDir, { recursive: true })
			writeFileSync(join(t.ctx.stagingDir, '.lock'), text)
			assert.equal((await backup(t.ctx, REAL)).uploaded.length, 1, JSON.stringify(text))
		}
	})

	test('a second run while one is alive is refused; a dead run\'s lock is replaced', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d] })
		mkdirSync(t.ctx.stagingDir, { recursive: true })
		writeFileSync(join(t.ctx.stagingDir, '.lock'), String(process.pid))
		await assert.rejects(backup(t.ctx, REAL), (e) => /already running/.test(e.message) && e.message.includes(join(t.ctx.stagingDir, '.lock')) && /delete/.test(e.message) && e.message.includes(`ps -p ${process.pid}`))
		const dead = spawnSync('node', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim()
		writeFileSync(join(t.ctx.stagingDir, '.lock'), dead)
		assert.equal((await backup(t.ctx, REAL)).uploaded.length, 1)
		assert.equal(existsSync(join(t.ctx.stagingDir, '.lock')), false)
	})
})

describe('a database listed under videos', () => {
	test('a SQLite file is refused, on a dry run too, and told to go under databases', async () => {
		const d = dir()
		const db = makeDb(join(d, 'sessions.db'))
		const t = setup({ videos: [db] })
		const said = (e) => /SQLite/.test(e.message) && /"databases"/.test(e.message) && /not encrypted/.test(e.message)
		await assert.rejects(backup(t.ctx, REAL), said)
		await assert.rejects(backup(t.ctx, {}), said)
		assert.deepEqual(t.tags(), [])
		assert.deepEqual(t.puts, [])
	})

	test('one inside a folder is refused too, whatever its extension, by position when its name looks like a secret', async () => {
		const d = dir()
		makeDb(join(d, 'old.mp4'))
		const t = setup({ videos: [d] })
		await assert.rejects(backup(t.ctx, REAL), (e) => /SQLite/.test(e.message) && e.message.includes('old.mp4'))
		assert.deepEqual(t.tags(), [])

		const f = dir()
		mkdirSync(join(f, TOKEN))
		makeDb(join(f, TOKEN, 'a.mp4'))
		const u = setup({ videos: [f] })
		await assert.rejects(backup(u.ctx, REAL), (e) => /SQLite/.test(e.message) && /position 1/.test(e.message) && !e.message.includes(TOKEN))
	})

	test('a video, a short file and an empty one are not mistaken for a database', async () => {
		const d = dir()
		writeFileSync(join(d, 'a.mp4'), 'SQLite format 2 and more')
		writeFileSync(join(d, 'b.mp4'), 'SQL')
		writeFileSync(join(d, 'c.mp4'), '')
		const t = setup({ videos: [d] })
		assert.equal((await backup(t.ctx, REAL)).uploaded.length, 3)
	})
})

describe('the clone in an unfinished state', () => {
	/** A clone stopped in a rebase that conflicts, with the owner's resolution staged. */
	function midRebase() {
		const t = setup()
		const g = (...a) => t.sb.git('-C', t.sb.clone, ...a)
		const other = join(dir(), 'other')
		t.sb.git('clone', '-q', t.sb.remote, other)
		writeFileSync(join(other, 'f.txt'), 'theirs\n')
		t.sb.git('-C', other, 'add', 'f.txt')
		t.sb.git('-C', other, '-c', 'user.email=o@example.com', '-c', 'user.name=O', 'commit', '-q', '-m', 'theirs')
		t.sb.git('-C', other, 'push', '-q', 'origin', 'HEAD:main')
		writeFileSync(join(t.sb.clone, 'f.txt'), 'local\n')
		g('add', 'f.txt')
		g('commit', '-q', '-m', 'local')
		return { t, g }
	}

	test('pullRebase never undoes a rebase it did not start: the owner\'s resolution stays', () => {
		const { t, g } = midRebase()
		assert.throws(() => g('pull', '-q', '--rebase', 'origin', 'main'))
		writeFileSync(join(t.sb.clone, 'f.txt'), 'resolved by hand\n')
		g('add', 'f.txt')
		const before = g('rev-parse', 'HEAD')
		assert.throws(() => pullRebase({ clone: t.sb.clone }, 'main'), (e) => e.needsOwner === true && /rebase is unfinished/.test(e.message))
		assert.ok(existsSync(join(t.sb.clone, '.git', 'rebase-merge')) || existsSync(join(t.sb.clone, '.git', 'rebase-apply')), 'still mid-rebase')
		assert.equal(g('rev-parse', 'HEAD'), before)
		assert.equal(readFileSync(join(t.sb.clone, 'f.txt'), 'utf8'), 'resolved by hand\n')
		assert.match(g('status', '--porcelain', '--', 'f.txt'), /^[AM] /m, 'still staged')
	})

	test('pullRebase still undoes the rebase it started itself, and says so', () => {
		const { t, g } = midRebase()
		assert.throws(() => pullRebase({ clone: t.sb.clone }, 'main'), (e) => e.needsOwner === true && /the rebase was undone/.test(e.message))
		assert.equal(existsSync(join(t.sb.clone, '.git', 'rebase-merge')), false)
		assert.equal(readFileSync(join(t.sb.clone, 'f.txt'), 'utf8'), 'local\n')
		assert.match(g('log', '--format=%s', '-1'), /local/)
	})

	test('a clone on no branch stops the run before any upload, says the owner must act, and commits nothing there', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d] })
		t.sb.git('-C', t.sb.clone, 'checkout', '-q', '--detach')
		const head = t.sb.git('-C', t.sb.clone, 'rev-parse', 'HEAD')
		await assert.rejects(backup(t.ctx, REAL), (e) => /no run pushes it until this is sorted out/.test(e.message) && /not on a branch/.test(e.message) && !/next run pushes/.test(e.message))
		assert.deepEqual(t.tags(), [])
		assert.equal(t.sb.git('-C', t.sb.clone, 'rev-parse', 'HEAD'), head)
	})

	test('what git says goes in the message, unless it looks like it holds a secret', async () => {
		for (const [said, shows] of [['the hook said no', true], [`fatal: could not read from https://x:${TOKEN}@github.com/me/v.git`, false]]) {
			const d = dir()
			writeFileSync(join(d, 'clip.mp4'), 'video')
			const t = setup({ videos: [d] })
			const hook = join(t.sb.clone, '.git', 'hooks', 'pre-push')
			writeFileSync(hook, `#!/bin/sh\necho '${said}' >&2\nexit 1\n`)
			chmodSync(hook, 0o755)
			await assert.rejects(backup(t.ctx, REAL), (e) => /could not be synced/.test(e.message) && e.message.includes('the hook said no') === shows && !e.message.includes(TOKEN))
		}
	})
})

describe('dry run', () => {
	for (const [label, opts] of [['--dry-run', { dryRun: true, yes: true }], ['no --yes', {}]]) {
		test(`${label} uploads nothing, writes no manifest and prints what would go with sizes`, async () => {
			const d = dir()
			writeFileSync(join(d, 'clip.mp4'), randomBytes(2048))
			const t = setup({ videos: [d], databases: [makeDb(join(dir(), 'a.db'))] })
			const before = t.sb.git('-C', t.sb.clone, 'rev-parse', 'HEAD')
			const r = await backup(t.ctx, opts)
			assert.deepEqual(r.uploaded, [])
			assert.equal(r.snapshot, null)
			assert.deepEqual(t.puts, [])
			assert.deepEqual(t.tags(), [])
			assert.equal(t.manifest(), null)
			assert.equal(t.sb.git('-C', t.sb.clone, 'rev-parse', 'HEAD'), before)
			assert.equal(existsSync(t.ctx.stagingDir), false)
			assert.match(t.text(), /clip\.mp4/)
			assert.match(t.text(), /a\.db/)
			assert.match(t.text(), /2\.0 KB/)
			assert.match(t.text(), /--yes/)
		})
	}

	test('it says skipped for a video already in the vault', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d] })
		await backup(t.ctx, REAL)
		t.logged.length = 0
		await backup(t.ctx, {})
		assert.match(t.text(), /skipped clip\.mp4/)
	})
})

describe('backup', () => {
	test('a database plus a video: list shows original names, sizes and checksums; the video is plain, the database needs the key', async () => {
		const vids = dir()
		const name = 'मराठी café clip 1.mp4'
		const bytes = randomBytes(2500)
		writeFileSync(join(vids, name), bytes)
		const srcDb = makeDb(join(dir(), 'सत्र sessions.db'))
		const t = setup({ videos: [vids], databases: [srcDb] })
		const r = await backup(t.ctx, REAL)

		assert.equal(r.uploaded.length, 2)
		assert.match(r.snapshot, /^snap-20261031T100000Z-mac$/)
		const items = list(t.ctx)
		assert.equal(items.length, 2)
		const video = items.find((i) => i.kind === 'video')
		const db = items.find((i) => i.kind === 'database')
		assert.equal(video.name, name)
		assert.equal(video.size, 2500)
		assert.equal(video.sha256, sha(bytes))
		assert.equal(video.encrypted, false)
		assert.equal(video.keyFp, undefined)
		assert.equal(video.device, 'mac')
		assert.ok(video.verifiedAt)
		assert.equal(db.name, 'सत्र sessions.db')
		assert.equal(db.encrypted, true)
		assert.equal(db.keyFp, fingerprint(KEY))
		assert.ok(db.verifiedAt)
		assert.equal(db.date, '2026-10-31T10:00:00.000Z')
		assert.equal(db.release, r.snapshot)
		for (const i of items) assert.ok(!i.id.includes(i.name) && /^[0-9a-z-]+$/.test(i.id))

		// The video is stored as is: joining its assets gives the bytes.
		assert.match(video.release, /^videos-0001$/)
		const joined = join(dir(), 'v')
		await joinParts(video.parts.map((p) => t.asset(video.release, p.asset)), joined)
		assert.equal(await sha256File(joined), sha(bytes))
		for (const p of video.parts) assert.match(p.asset, new RegExp(`^${sha(bytes).slice(0, 8)}-\\d+\\.part\\d{3}$`))

		// The database: with the key it gives the snapshot back, without it nothing.
		const enc = join(dir(), 'enc')
		await joinParts(db.parts.map((p) => t.asset(db.release, p.asset)), enc)
		assert.notEqual(readFileSync(enc).subarray(0, 4).toString(), 'SQLi')
		await assert.rejects(decryptFile(enc, join(dir(), 'x'), await newKey()), /wrong key/)
		const gz = join(dir(), 'gz')
		await decryptFile(enc, gz, KEY)
		const out = join(dir(), 'out.db')
		await gunzipTo(gz, out)
		assert.equal(await sha256File(out), db.sha256)
		assert.equal(statSync(out).size, db.size)

		// Both releases published, manifest pushed, staging clean.
		assert.equal(t.release(db.release).draft, false)
		assert.equal(t.release(video.release).draft, false)
		assert.equal(t.pushed().items.length, 2)
		assert.deepEqual(readdirSync(t.ctx.stagingDir), [])
		const msg = t.sb.git('-C', t.sb.clone, 'log', '-1', '--format=%s')
		assert.ok(!msg.includes(name))
	})

	test('a database is split into parts under the cap', async () => {
		const t = setup({ databases: [makeDb(join(dir(), 'a.db'))] })
		const r = await backup(t.ctx, REAL)
		const assets = t.assets(r.snapshot)
		assert.ok(assets.length >= 5, `got ${assets.length}`)
		for (const a of assets) assert.ok(statSync(t.asset(r.snapshot, a)).size <= 1000)
		assert.equal(list(t.ctx)[0].parts.length, assets.length)
	})

	test('a video bigger than the cap is split and staged only as needed', async () => {
		const d = dir()
		writeFileSync(join(d, 'big.mp4'), randomBytes(3500))
		const t = setup({ videos: [d] })
		const seen = []
		const orig = t.ctx.storage.putAsset
		t.ctx.storage.putAsset = async (tag, file, name) => {
			seen.push(readdirSync(join(t.ctx.stagingDir, readdirSync(t.ctx.stagingDir).find((f) => f.startsWith('video-')))).filter((f) => f !== 'state.json').length)
			return orig(tag, file, name)
		}
		await backup(t.ctx, REAL)
		assert.equal(list(t.ctx)[0].parts.length, 4)
		assert.ok(seen.every((c) => c === 1), `at most one part on disk, saw ${seen}`)
	})

	test('two databases in one run share one snapshot release', async () => {
		const d = dir()
		const t = setup({ databases: [makeDb(join(d, 'a.db')), makeDb(join(d, 'b.db'))] })
		const r = await backup(t.ctx, REAL)
		const items = list(t.ctx)
		assert.equal(items.length, 2)
		assert.ok(items.every((i) => i.release === r.snapshot))
		assert.deepEqual(t.tags(), [r.snapshot])
	})

	test('killed after 2 parts: the next run uploads only the rest, into one release, and the staging holds no plaintext between', async () => {
		const srcDb = makeDb(join(dir(), 'a.db'))
		const t = setup({ databases: [srcDb], fake: { failPutsAfter: 2 } })
		await assert.rejects(backup(t.ctx, REAL), /fake upload/)
		const [tag] = t.tags()
		assert.equal(t.assets(tag).length, 2)
		assert.equal(t.release(tag).draft, true)
		assert.equal(t.manifest(), null)

		const [item] = readdirSync(t.ctx.stagingDir)
		const left = readdirSync(join(t.ctx.stagingDir, item))
		assert.ok(left.includes('state.json'))
		assert.ok(left.filter((f) => f !== 'state.json').every((f) => /\.part\d{3}$/.test(f)), left.join())
		const state = JSON.parse(readFileSync(join(t.ctx.stagingDir, item, 'state.json'), 'utf8'))
		const total = state.parts.length
		assert.ok(total > 2)

		t.puts.length = 0
		const r = await backup(t.withStorage({}), REAL)
		assert.equal(r.snapshot, tag)
		assert.equal(t.puts.length, total - 2)
		assert.deepEqual(t.tags(), [tag])
		assert.equal(t.release(tag).draft, false)
		assert.equal(list(t.ctx).length, 1)
		assert.deepEqual(readdirSync(t.ctx.stagingDir), [])
	})

	test('a failed post-upload check leaves a draft and no manifest item, names the asset, and the next run re-uploads that part', async () => {
		const t = setup({
			databases: [makeDb(join(dir(), 'a.db'))],
			wrap: (s) => ({
				...s,
				getAsset: async (tag, name, dest) => {
					const p = await s.getAsset(tag, name, dest)
					if (t.broken === undefined) t.broken = name
					if (t.broken === name && !t.healed) appendFileSync(p, 'x')
					return p
				},
			}),
		})
		let msg = ''
		await assert.rejects(backup(t.ctx, REAL), (e) => (msg = e.message, /check/.test(msg)))
		assert.ok(msg.includes(t.broken), msg)
		const [tag] = t.tags()
		assert.equal(t.release(tag).draft, true)
		assert.equal(t.manifest(), null)

		// The damage is real this time: same name and size in storage, but needsUpload forces it anyway.
		t.healed = true
		t.puts.length = 0
		const r = await backup(t.ctx, REAL)
		assert.equal(r.snapshot, tag)
		assert.deepEqual(t.puts, [t.broken])
		assert.equal(t.release(tag).draft, false)
		assert.equal(list(t.ctx).length, 1)
	})

	test('fake corruptAsset on a video: the check fails naming the asset, and no item is written', async () => {
		const d = dir()
		const bytes = randomBytes(500)
		writeFileSync(join(d, 'clip.mp4'), bytes)
		const corrupt = `${sha(bytes).slice(0, 8)}-1.part001`
		const t = setup({ videos: [d], fake: { corruptAsset: corrupt } })
		await assert.rejects(backup(t.ctx, REAL), new RegExp(corrupt.replace('.', '\\.')))
		assert.equal(t.release('videos-0001').draft, true)
		assert.equal(t.manifest(), null)
	})

	test('the same video twice: the second run uploads nothing and says skipped', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video bytes')
		const t = setup({ videos: [d] })
		await backup(t.ctx, REAL)
		t.puts.length = 0
		t.logged.length = 0
		const r = await backup(t.ctx, REAL)
		assert.deepEqual(t.puts, [])
		assert.deepEqual(r.uploaded, [])
		assert.ok(r.skipped.some((s) => s.name === 'clip.mp4' && /already/.test(s.why)))
		assert.match(t.text(), /skipped clip\.mp4/)
		assert.equal(list(t.ctx).length, 1)
	})

	test('videos fill one rolling release, published on its first item, and switch at 900 assets', async () => {
		const d = dir()
		writeFileSync(join(d, 'a.mp4'), 'first video')
		const t = setup({ videos: [d] })
		await backup(t.ctx, REAL)
		writeFileSync(join(d, 'b.mp4'), 'second video')
		t.puts.length = 0
		await backup(t.ctx, REAL)
		assert.equal(t.puts.length, 1)
		assert.deepEqual(t.tags(), ['videos-0001'])
		assert.equal(t.assets('videos-0001').length, 2)

		writeFileSync(join(d, 'c.mp4'), 'third video')
		const full = {
			...t.ctx,
			storage: {
				...t.ctx.storage,
				listAssets: async (tag) => (tag === 'videos-0001' ? Array.from({ length: 900 }, (_, i) => ({ name: `x${i}`, size: 1 })) : t.ctx.storage.listAssets(tag)),
			},
		}
		await backup(full, REAL)
		assert.deepEqual(t.tags(), ['videos-0001', 'videos-0002'])
		assert.equal(t.release('videos-0002').draft, false)
	})

	test('only video and audio files are taken from a folder, in subfolders too; others are reported', async () => {
		const d = dir()
		mkdirSync(join(d, '2026-10-31_talk_id'))
		writeFileSync(join(d, '2026-10-31_talk_id', 'video.MP4'), 'video')
		writeFileSync(join(d, '2026-10-31_talk_id', 'notes.md'), 'notes')
		writeFileSync(join(d, '.DS_Store'), 'x')
		const t = setup({ videos: [d] })
		const r = await backup(t.ctx, REAL)
		assert.deepEqual(r.uploaded.map((u) => u.name), ['video.MP4'])
		assert.ok(r.skipped.some((s) => s.name === '2026-10-31_talk_id/notes.md' && /not a video/.test(s.why)))
	})

	test('a symlink in the video folder is skipped and reported, never followed', async () => {
		const d = dir()
		const secretFile = join(dir(), 'outside.mp4')
		writeFileSync(secretFile, 'elsewhere')
		writeFileSync(join(d, 'real.mp4'), 'video')
		symlinkSync(secretFile, join(d, 'link.mp4'))
		const t = setup({ videos: [d] })
		const r = await backup(t.ctx, REAL)
		assert.deepEqual(r.uploaded.map((u) => u.name), ['real.mp4'])
		assert.ok(r.skipped.some((s) => s.name === 'link.mp4' && s.why === 'symlink'))
		assert.match(t.text(), /link\.mp4.*symlink/)
	})

	test('a file whose size changes between hash and upload fails naming it', async () => {
		const d = dir()
		const file = join(d, 'growing.mp4')
		writeFileSync(file, 'video bytes')
		const t = setup({
			videos: [d],
			wrap: (s) => ({ ...s, createRelease: async (...a) => (appendFileSync(file, 'more'), s.createRelease(...a)) }),
		})
		await assert.rejects(backup(t.ctx, REAL), /growing\.mp4/)
		assert.deepEqual(t.puts, [])
		assert.equal(t.manifest(), null)
	})

	test('a file whose content changes between hash and upload, same size, fails naming it', async () => {
		const d = dir()
		const file = join(d, 'edited.mp4')
		writeFileSync(file, 'aaaaaaaaaa')
		const t = setup({
			videos: [d],
			wrap: (s) => ({ ...s, createRelease: async (...a) => (writeFileSync(file, 'bbbbbbbbbb'), s.createRelease(...a)) }),
		})
		await assert.rejects(backup(t.ctx, REAL), /edited\.mp4/)
		assert.deepEqual(t.puts, [])
	})

	test('a file that keeps changing while being read is re-read once, then the run fails naming it', async () => {
		const d = dir()
		const file = join(d, 'live.mp4')
		writeFileSync(file, randomBytes(8 * 1024 * 1024))
		const t = setup({ videos: [d], partBytes: 1024 * 1024 })
		const timer = setInterval(() => appendFileSync(file, 'x'), 1)
		try {
			await assert.rejects(backup(t.ctx, REAL), /live\.mp4.*chang/)
		} finally {
			clearInterval(timer)
		}
		assert.deepEqual(t.puts, [])
	})

	test('a video named with a token stops the run without printing it, before any upload', async () => {
		const d = dir()
		writeFileSync(join(d, 'a-good.mp4'), 'video')
		writeFileSync(join(d, `${TOKEN}.mp4`), 'video')
		const t = setup({ videos: [d] })
		let msg = ''
		await assert.rejects(backup(t.ctx, REAL), (e) => ((msg = e.message), /secret/.test(msg)))
		assert.ok(!msg.includes(TOKEN))
		assert.ok(msg.includes(d), 'names the folder')
		assert.match(msg, /position 2/)
		assert.ok(!t.text().includes(TOKEN))
		assert.deepEqual(t.puts, [])
		assert.deepEqual(t.tags(), [])
		await assert.rejects(backup(t.ctx, {}), (e) => !e.message.includes(TOKEN))
		assert.ok(!t.text().includes(TOKEN))
	})

	test('a symlink with a token-shaped name is reported without printing it', async () => {
		const d = dir()
		writeFileSync(join(d, 'real.mp4'), 'video')
		symlinkSync(join(d, 'real.mp4'), join(d, `${TOKEN}.mp4`))
		const t = setup({ videos: [d] })
		const r = await backup(t.ctx, REAL)
		assert.ok(!t.text().includes(TOKEN))
		assert.ok(!JSON.stringify(r).includes(TOKEN))
		assert.ok(r.skipped.some((s) => s.why === 'symlink'))
	})

	test('a database named with a token stops the run without printing it', async () => {
		const d = dir()
		const t = setup({ databases: [makeDb(join(d, `${TOKEN}.db`))] })
		let msg = ''
		await assert.rejects(backup(t.ctx, REAL), (e) => ((msg = e.message), /secret/.test(msg)))
		assert.ok(!msg.includes(TOKEN))
		assert.match(msg, /vault\.databases entry 1/)
	})

	test('a manifest that could not be pushed stays local; the next run pushes it and the item is not uploaded again', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d] })
		const realPush = t.ctx.storage.publishRelease
		t.ctx.storage.publishRelease = async (tag) => {
			await realPush(tag)
			t.sb.git('-C', t.sb.clone, 'remote', 'set-url', '--push', 'origin', '/nonexistent/remote.git')
		}
		await assert.rejects(backup(t.ctx, REAL), /manifest/)
		assert.equal(t.manifest().items.length, 1)
		assert.equal(t.pushed(), null)

		t.sb.git('-C', t.sb.clone, 'remote', 'set-url', '--push', 'origin', t.sb.remote)
		t.puts.length = 0
		const r = await backup(t.ctx, REAL)
		assert.deepEqual(t.puts, [])
		assert.deepEqual(r.uploaded, [])
		assert.equal(t.pushed().items.length, 1)
		assert.deepEqual(readdirSync(t.ctx.stagingDir), [])
	})

	test('a video that cannot be downloaded back is uploaded again next run, not skipped forever', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), randomBytes(2500))
		const t = setup({
			videos: [d],
			wrap: (s) => ({
				...s,
				getAsset: async (tag, name, dest) => {
					if (name.endsWith('.part002') && !t.healed) throw new Error(`HTTP 500: fake download of ${name} failed`)
					return s.getAsset(tag, name, dest)
				},
			}),
		})
		await assert.rejects(backup(t.ctx, REAL), /fake download/)
		assert.equal(t.manifest(), null)
		t.healed = true
		t.puts.length = 0
		await backup(t.ctx, REAL)
		assert.equal(t.puts.length, 1)
		assert.match(t.puts[0], /\.part002$/)
		assert.equal(list(t.ctx).length, 1)
		assert.deepEqual(readdirSync(t.ctx.stagingDir), [])
	})

	test('a video upload killed after the asset appeared is uploaded again, not trusted for its name and size', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), randomBytes(2500))
		const t = setup({
			videos: [d],
			wrap: (s) => ({
				...s,
				putAsset: async (tag, file, name) => {
					await s.putAsset(tag, file, name)
					if (name.endsWith('.part001') && !t.healed) throw new Error('killed right after the upload')
				},
			}),
		})
		await assert.rejects(backup(t.ctx, REAL), /killed/)
		const [item] = readdirSync(t.ctx.stagingDir)
		const state = JSON.parse(readFileSync(join(t.ctx.stagingDir, item, 'state.json'), 'utf8'))
		assert.equal(state.parts[0].needsUpload, true)
		t.healed = true
		t.puts.length = 0
		await backup(t.ctx, REAL)
		assert.equal(t.puts.length, 3, 'the first part again, then the other two')
		assert.equal(list(t.ctx).length, 1)
	})

	test('a resumed video whose release was deleted makes it again', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), randomBytes(2500))
		const t = setup({ videos: [d], fake: { failPutsAfter: 1 } })
		await assert.rejects(backup(t.ctx, REAL), /fake upload/)
		await fakeStorage(t.store).deleteRelease('videos-0001')
		t.puts.length = 0
		await backup(t.withStorage({}), REAL)
		assert.equal(t.puts.length, 3)
		assert.equal(t.release('videos-0001').draft, false)
		assert.equal(list(t.ctx).length, 1)
	})

	test('a manifest conflict undoes the rebase and says so; the clone stays on its branch', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d] })
		await backup(t.ctx, REAL)
		const { sb } = t
		const rel = 'manifest/mac.json'
		const editDate = (clone, date) => {
			const m = JSON.parse(readFileSync(join(clone, rel), 'utf8'))
			m.items[0].date = date
			writeFileSync(join(clone, rel), JSON.stringify(m, null, '\t') + '\n')
			sb.git('-C', clone, 'add', '--', rel)
			sb.git('-C', clone, 'commit', '-q', '-m', 'edit')
		}
		const other = join(sb.root, 'other')
		sb.git('clone', '-q', sb.remote, other)
		sb.git('-C', other, 'config', 'user.email', 'o@example.com')
		sb.git('-C', other, 'config', 'user.name', 'O')
		editDate(other, '2026-01-01T00:00:00.000Z')
		sb.git('-C', other, 'push', '-q', 'origin', 'HEAD:main')
		editDate(sb.clone, '2026-02-02T00:00:00.000Z')

		for (let i = 0; i < 2; i++) await assert.rejects(backup(t.ctx, REAL), (e) => /rebase was undone/.test(e.message) && /until this is sorted out/.test(e.message) && !/not on a branch|next run pushes/.test(e.message))
		const gitDir = join(sb.clone, '.git')
		assert.equal(existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply')), false)
		assert.equal(sb.git('-C', sb.clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main')
	})

	test('a rebase that cannot be undone is not reported as undone, and the next run says it is unfinished', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d] })
		await backup(t.ctx, REAL)
		const { sb } = t
		const rel = 'manifest/mac.json'
		const editDate = (clone, date) => {
			const m = JSON.parse(readFileSync(join(clone, rel), 'utf8'))
			m.items[0].date = date
			writeFileSync(join(clone, rel), JSON.stringify(m, null, '\t') + '\n')
			sb.git('-C', clone, 'add', '--', rel)
			sb.git('-C', clone, 'commit', '-q', '-m', 'edit')
		}
		const other = join(sb.root, 'other')
		sb.git('clone', '-q', sb.remote, other)
		sb.git('-C', other, 'config', 'user.email', 'o@example.com')
		sb.git('-C', other, 'config', 'user.name', 'O')
		editDate(other, '2026-01-01T00:00:00.000Z')
		sb.git('-C', other, 'push', '-q', 'origin', 'HEAD:main')
		editDate(sb.clone, '2026-02-02T00:00:00.000Z')

		const bin = dir()
		const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
		writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$*" in\n  *"rebase --abort"*) exit 1 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`)
		chmodSync(join(bin, 'git'), 0o755)
		const oldPath = process.env.PATH
		process.env.PATH = `${bin}:${oldPath}`
		try {
			await assert.rejects(backup(t.ctx, REAL), (e) => /could not be undone/.test(e.message) && !/rebase was undone|next run pushes/.test(e.message))
		} finally {
			process.env.PATH = oldPath
		}
		await assert.rejects(backup(t.ctx, REAL), (e) => /rebase is unfinished/.test(e.message) && /until this is sorted out/.test(e.message))
	})

	test('an operation already unfinished in the clone stops the run before anything is committed', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d] })
		mkdirSync(join(t.sb.clone, '.git', 'rebase-merge'))
		const head = t.sb.git('-C', t.sb.clone, 'rev-parse', 'HEAD')
		await assert.rejects(backup(t.ctx, REAL), /rebase is unfinished/)
		assert.equal(t.sb.git('-C', t.sb.clone, 'rev-parse', 'HEAD'), head)
		assert.deepEqual(t.tags(), [])
	})

	test('a symlinked database is skipped, reported and never read', async () => {
		const d = dir()
		const target = makeDb(join(d, 'real.db'))
		const link = join(d, 'link.db')
		symlinkSync(target, link)
		const t = setup({ databases: [link] })
		const r = await backup(t.ctx, REAL)
		assert.deepEqual(r.uploaded, [])
		assert.ok(r.skipped.some((s) => s.name === 'link.db' && s.why === 'symlink'))
		assert.match(t.text(), /link\.db: symlink/)
		assert.deepEqual(t.tags(), [])
	})

	test('a symlinked root in vault.videos is skipped and reported, its target never walked', async () => {
		const real = dir()
		writeFileSync(join(real, 'clip.mp4'), 'video')
		const link = join(dir(), 'linked-videos')
		symlinkSync(real, link)
		const t = setup({ videos: [link] })
		const r = await backup(t.ctx, REAL)
		assert.deepEqual(r.uploaded, [])
		assert.deepEqual(t.puts, [])
		assert.ok(r.skipped.some((s) => s.name === link && s.why === 'symlink'))
		assert.match(t.text(), /linked-videos: symlink/)
	})

	test('--videos and --databases each pick their kind', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d], databases: [makeDb(join(dir(), 'a.db'))] })
		const r = await backup(t.ctx, { yes: true, videos: true })
		assert.deepEqual(r.uploaded.map((u) => u.kind), ['video'])
		const s = await backup(t.ctx, { yes: true, databases: true })
		assert.deepEqual(s.uploaded.map((u) => u.kind), ['database'])
	})
})

describe('staging', () => {
	test('stagingDir is 0700; snapshot and gzip are 0600 while they exist, and gone once encrypted', async () => {
		const bin = dir()
		const record = join(dir(), 'modes')
		const age = spawnSync('which', ['age'], { encoding: 'utf8' }).stdout.trim()
		assert.ok(age, 'the real age is required')
		const stub = join(bin, 'age')
		writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do last="$a"; done\nd=$(dirname "$last")\nstat -f '%Lp %N' "$d" "$d"/* >> ${JSON.stringify(record)}\nexec ${JSON.stringify(age)} "$@"\n`)
		chmodSync(stub, 0o755)
		const t = setup({ databases: [makeDb(join(dir(), 'a.db'))] })
		const oldPath = process.env.PATH
		process.env.PATH = `${bin}:${oldPath}`
		try {
			await backup(t.ctx, REAL)
		} finally {
			process.env.PATH = oldPath
		}
		const lines = readFileSync(record, 'utf8').trim().split('\n').map((l) => l.split(' '))
		const modeOf = (suffix) => lines.find(([, p]) => p.endsWith(suffix))?.[0]
		assert.equal(modeOf('snapshot.db'), '600')
		assert.equal(modeOf('snapshot.db.gz'), '600')
		assert.equal(statSync(t.ctx.stagingDir).mode & 0o777, 0o700)
	})

	test('an existing stagingDir with loose permissions is tightened', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d] })
		mkdirSync(t.ctx.stagingDir, { recursive: true, mode: 0o755 })
		chmodSync(t.ctx.stagingDir, 0o755)
		await backup(t.ctx, REAL)
		assert.equal(statSync(t.ctx.stagingDir).mode & 0o777, 0o700)
	})

	test('a failed encryption leaves no plaintext behind', async () => {
		const t = setup({ databases: [makeDb(join(dir(), 'a.db'))], key: 'not a key at all' })
		await assert.rejects(backup(t.ctx, REAL), /not a valid vault key/)
		assert.deepEqual(readdirSync(t.ctx.stagingDir), [])
	})

	test('each run deletes stale plaintext, keeping state.json and encrypted parts', async () => {
		const t = setup({ databases: [makeDb(join(dir(), 'a.db'))], fake: { failPutsAfter: 1 } })
		await assert.rejects(backup(t.ctx, REAL), /fake upload/)
		const [item] = readdirSync(t.ctx.stagingDir)
		const inside = join(t.ctx.stagingDir, item)
		const before = readdirSync(inside).sort()
		// What a hard kill leaves: plaintext next to a good resume, and a whole item with no state.
		for (const f of ['snapshot.db', 'snapshot.db.gz', 'snapshot.db.gz.age.partial', 'x.partial']) writeFileSync(join(inside, f), 'PLAINTEXT')
		const killed = join(t.ctx.stagingDir, 'database-killed')
		mkdirSync(killed)
		writeFileSync(join(killed, 'snapshot.db'), 'PLAINTEXT')
		writeFileSync(join(t.ctx.stagingDir, 'loose.partial'), 'PLAINTEXT')
		const seen = {}
		const plain = fakeStorage(t.store)
		const looking = async (...a) => {
			seen.files = readdirSync(inside).sort()
			seen.top = readdirSync(t.ctx.stagingDir)
			return plain.createRelease(...a)
		}
		await backup({ ...t.ctx, storage: { ...plain, createRelease: looking } }, REAL)
		assert.deepEqual(seen.files, before)
		assert.ok(!seen.top.includes('database-killed'))
		assert.ok(!seen.top.includes('loose.partial'))
		assert.deepEqual(readdirSync(t.ctx.stagingDir), [])
	})

	test('a refused real run clears stale plaintext too; a dry run leaves it alone', async () => {
		const t = setup({ databases: [makeDb(join(dir(), 'a.db'))], fake: { failPutsAfter: 1 } })
		await assert.rejects(backup(t.ctx, REAL), /fake upload/)
		const [item] = readdirSync(t.ctx.stagingDir)
		const inside = join(t.ctx.stagingDir, item)
		const before = readdirSync(inside).sort()
		const plain = join(inside, 'snapshot.db')
		writeFileSync(plain, 'PLAINTEXT')
		await backup(t.ctx, {})
		assert.equal(existsSync(plain), true, 'a dry run changes nothing')
		const refused = { ...t.ctx, repoVisibility: () => 'public' }
		await assert.rejects(backup(refused, REAL), /private/)
		assert.deepEqual(readdirSync(inside).sort(), before)
		assert.equal(existsSync(join(t.ctx.stagingDir, '.lock')), false)
	})

	test('a staged part that went missing or was damaged restarts that item from a fresh snapshot', async () => {
		const t = setup({ databases: [makeDb(join(dir(), 'a.db'))], fake: { failPutsAfter: 1 } })
		await assert.rejects(backup(t.ctx, REAL), /fake upload/)
		const [item] = readdirSync(t.ctx.stagingDir)
		const inside = join(t.ctx.stagingDir, item)
		const part = readdirSync(inside).find((f) => f !== 'state.json')
		rmSync(join(inside, part))
		const earlierTag = JSON.parse(readFileSync(join(inside, 'state.json'), 'utf8')).tag
		const later = { ...t.withStorage({}), now: () => Date.parse('2026-10-31T11:00:00.000Z') }
		await backup(later, REAL)
		assert.deepEqual(t.tags(), [earlierTag], 'no second draft')
		const [one] = list(t.ctx)
		assert.equal(t.release(one.release).draft, false)
		assert.equal(one.parts.every((p) => existsSync(t.asset(one.release, p.asset))), true)
		const enc = join(dir(), 'e')
		await joinParts(one.parts.map((p) => t.asset(one.release, p.asset)), enc)
		await decryptFile(enc, join(dir(), 'gz'), KEY)
	})

	test('a staged snapshot made with another key is not reused', async () => {
		const srcDb = makeDb(join(dir(), 'a.db'))
		const t = setup({ databases: [srcDb], fake: { failPutsAfter: 0 } })
		await assert.rejects(backup(t.ctx, REAL), /fake upload/)
		const other = await newKey()
		t.ctx.keystore.set('me', other)
		await backup(t.withStorage({}), REAL)
		assert.equal(list(t.ctx)[0].keyFp, fingerprint(other))
	})

	test('a changed video starts over instead of reusing a stale state', async () => {
		const d = dir()
		const file = join(d, 'clip.mp4')
		writeFileSync(file, randomBytes(2500))
		const t = setup({ videos: [d], fake: { failPutsAfter: 1 } })
		await assert.rejects(backup(t.ctx, REAL), /fake upload/)
		const bytes = randomBytes(2600)
		writeFileSync(file, bytes)
		await backup(t.withStorage({}), REAL)
		const [one] = list(t.ctx)
		assert.equal(one.sha256, sha(bytes))
	})

	test('--discard-staged removes the staged item and, without --yes, stops there', async () => {
		const t = setup({ databases: [makeDb(join(dir(), 'a.db'))], fake: { failPutsAfter: 0 } })
		await assert.rejects(backup(t.ctx, REAL), /fake upload/)
		assert.equal(readdirSync(t.ctx.stagingDir).length, 1)
		t.puts.length = 0
		await backup(t.ctx, { discardStaged: true })
		assert.deepEqual(readdirSync(t.ctx.stagingDir), [])
		assert.deepEqual(t.puts, [])
		assert.match(t.text(), /discard/i)
	})
})

describe('status', () => {
	test('shows an orphan draft, a snapshot with no manifest entry, key state and unlisted assets; never the key', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d], databases: [makeDb(join(dir(), 'a.db'))] })
		const r = await backup(t.ctx, REAL)
		const s0 = fakeStorage(t.store)
		await s0.createRelease('snap-20200101T000000Z-mac', { draft: true })
		await s0.createRelease('snap-20200102T000000Z-mac', { draft: false })
		const f = join(dir(), 'stray')
		writeFileSync(f, 'half an upload')
		await s0.putAsset('videos-0001', f, 'deadbeef-1.part001')

		const later = { ...t.ctx, now: () => Date.now() + 3 * 86_400_000 }
		const st = await status(later)
		assert.equal(st.repo, 'me/workpulse-vault')
		assert.equal(st.visibility, 'private')
		assert.equal(st.keyPresent, true)
		assert.equal(st.keyFp, fingerprint(KEY))
		assert.equal(st.keyBackedUpAt, '2026-10-30T00:00:00.000Z')
		assert.equal(st.items.length, 2)
		assert.ok(st.lastVerifiedAt)
		assert.deepEqual(st.orphans.sort(), ['snap-20200101T000000Z-mac', 'snap-20200102T000000Z-mac'])
		assert.ok(!st.orphans.includes(r.snapshot))
		assert.deepEqual(st.unlisted, [{ release: 'videos-0001', name: 'deadbeef-1.part001', size: 14 }])
		assert.ok(!JSON.stringify(st).includes(KEY))

		const young = await status({ ...t.ctx, now: () => Date.now() })
		assert.deepEqual(young.orphans, [])
	})

	test('a Keychain that cannot be read is reported as unknown, not as absent', async () => {
		const t = setup({})
		const st = await status({ ...t.ctx, keystore: { get() { throw new Error('could not read the Keychain') } } })
		assert.equal(st.keyPresent, null)
		assert.match(st.keyError, /could not read the Keychain/)
	})

	test('no key: absent, and no key is made', async () => {
		const t = setup({ key: null })
		const st = await status(t.ctx)
		assert.equal(st.keyPresent, false)
		assert.equal(st.keyFp, null)
		assert.deepEqual(t.sets, [])
	})

	test('storage that cannot be reached still gives the local part', async () => {
		const t = setup({})
		const st = await status({ ...t.ctx, storage: { listReleases: async () => { throw new Error('offline') } } })
		assert.equal(st.orphans, null)
		assert.match(st.storageError, /offline/)
	})
})

describe('list', () => {
	test('reads every device\'s manifest and never follows a linked one', async () => {
		const d = dir()
		writeFileSync(join(d, 'clip.mp4'), 'video')
		const t = setup({ videos: [d] })
		await backup(t.ctx, REAL)
		const m = join(t.sb.clone, 'manifest')
		writeFileSync(join(m, 'other.json'), JSON.stringify({ version: 1, device: 'other', items: [{ id: 'x1', kind: 'video', name: 'theirs.mp4', size: 1, sha256: 'a', date: '2026-01-01T00:00:00.000Z', release: 'videos-0001', encrypted: false, parts: [] }] }))
		const elsewhere = join(dir(), 'x.json')
		writeFileSync(elsewhere, JSON.stringify({ version: 1, device: 'x', items: [{ id: 'x2', kind: 'video', name: 'linked.mp4', size: 1, sha256: 'a', date: '2026-01-01T00:00:00.000Z', release: 'videos-0001', encrypted: false, parts: [] }] }))
		symlinkSync(elsewhere, join(m, 'linked.json'))
		const names = list(t.ctx).map((i) => `${i.device}:${i.name}`).sort()
		assert.deepEqual(names, ['mac:clip.mp4', 'other:theirs.mp4'])
	})

	test('a video already backed up from another device is skipped', async () => {
		const d = dir()
		const bytes = Buffer.from('shared video')
		writeFileSync(join(d, 'clip.mp4'), bytes)
		const t = setup({ videos: [d] })
		mkdirSync(join(t.sb.clone, 'manifest'))
		writeFileSync(join(t.sb.clone, 'manifest', 'other.json'), JSON.stringify({ version: 1, device: 'other', items: [{ id: 'x1', kind: 'video', name: 'theirs.mp4', size: bytes.length, sha256: sha(bytes), date: '2026-01-01T00:00:00.000Z', release: 'videos-0001', encrypted: false, parts: [] }] }))
		t.sb.git('-C', t.sb.clone, 'add', 'manifest/other.json')
		t.sb.git('-C', t.sb.clone, 'commit', '-q', '-m', 'other device')
		const r = await backup(t.ctx, REAL)
		assert.deepEqual(r.uploaded, [])
		assert.deepEqual(t.puts, [])
	})
})

describe('runVaultCli', () => {
	test('refuses an unknown subcommand and an unknown flag before doing anything', async () => {
		const deps = { cfg: { device: 'mac', vault: { repo: 'me/v' } }, storage: fakeStorage(dir()), keystore: fakeKeystore(), clone: dir(), log: () => {}, stagingDir: join(dir(), 's') }
		await assert.rejects(runVaultCli({ pos: ['nope'], opt: {} }, deps), /Usage/)
		await assert.rejects(runVaultCli({ pos: ['backup'], opt: { dryrun: true, yes: true } }, deps), /--dryrun/)
	})

	const usable = () => ({ cfg: { device: 'mac', vault: { repo: 'me/v' } }, storage: fakeStorage(dir()), keystore: fakeKeystore(), clone: dir(), log: () => {}, stagingDir: join(dir(), 's'), repoVisibility: () => 'private', cloneRepo: () => 'me/v' })

	test('backup refuses a stray word, so `backup one.mp4 --yes` never uploads everything configured', async () => {
		const puts = []
		const deps = { ...usable(), storage: { ...fakeStorage(dir()), putAsset: async (...a) => void puts.push(a) } }
		await assert.rejects(runVaultCli({ pos: ['backup', 'one.mp4'], opt: { yes: true } }, deps), /no argument/)
		for (const flag of ['yes', 'videos', 'databases', 'dry-run', 'discard-staged']) await assert.rejects(runVaultCli({ pos: ['backup'], opt: { [flag]: 'one.mp4' } }, deps), new RegExp(`--${flag} takes no value`))
		assert.deepEqual(puts, [])
	})

	test('list and status take no argument and no unknown flag; restore takes one name', async () => {
		const deps = usable()
		for (const sub of ['list', 'status']) {
			await assert.rejects(runVaultCli({ pos: [sub, 'word'], opt: {} }, deps), /no argument/, sub)
			await assert.rejects(runVaultCli({ pos: [sub], opt: { nope: true } }, deps), /--nope/, sub)
		}
		await assert.rejects(runVaultCli({ pos: ['restore', 'a.db', 'b.db'], opt: { to: '/x' } }, deps), /one name/)
		await assert.rejects(runVaultCli({ pos: ['restore', 'a.db'], opt: { to: '/x', force: 'b.db' } }, deps), /one name/)
	})

	test('with no clone, list, status and a bare restore say so and point at vault init, instead of "nothing yet"', async () => {
		for (const [pos, opt] of [[['list'], {}], [['status'], {}], [['restore'], {}], [['restore'], { to: '/x' }]]) {
			const logged = []
			const calls = []
			const storage = { listReleases: async () => (calls.push('list'), [{ tag: 'snap-x', createdAt: '2020-01-01T00:00:00Z' }]) }
			await runVaultCli({ pos, opt }, { ...usable(), storage, log: (l) => logged.push(l) })
			const text = logged.join('\n')
			assert.match(text, /no vault clone/, pos.join(' '))
			assert.match(text, /wp-brain vault init/, pos.join(' '))
			assert.doesNotMatch(text, /lists nothing|Items: +0|Orphan/, pos.join(' '))
			assert.deepEqual(calls, [], 'a release no manifest here lists is not an orphan')
		}
	})

	test('a clone with nothing in it still says the vault lists nothing', async () => {
		const t = setup()
		const logged = []
		await runVaultCli({ pos: ['list'], opt: {} }, { ...t.ctx, cfg: { device: 'mac', vault: { repo: 'me/workpulse-vault' } }, log: (l) => logged.push(l) })
		assert.match(logged.join('\n'), /lists nothing yet/)
	})

	test('a config with no vault says the vault is off', async () => {
		await assert.rejects(runVaultCli({ pos: ['status'], opt: {} }, { cfg: { device: 'mac' } }), /off/)
	})
})

describe('the CLI, end to end through stubs', () => {
	/** Stub gh (a fake storage in a folder, logging every call) and stub security first on PATH; HOME and config are temp. */
	function cli({ partBytes = '1000', key = KEY, stubOrigin = true } = {}) {
		const bin = dir()
		const home = dir()
		const store = dir()
		const ghLog = join(dir(), 'gh.log')
		const secLog = join(dir(), 'security.log')
		const keyFile = join(dir(), 'key')
		if (key) writeFileSync(keyFile, `${key}\n`)
		writeFileSync(join(bin, 'gh.mjs'), `import { appendFileSync } from 'node:fs'
const { fakeStorage } = await import(${JSON.stringify(join(here, 'vault-fake.mjs'))})
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(ghLog)}, args.join(' ') + '\\n')
const s = fakeStorage(${JSON.stringify(store)})
const after = (flag) => args[args.indexOf(flag) + 1]
try {
	const [what, sub, tag] = args
	if (what !== 'release') throw new Error('stub gh: only release, got ' + what)
	if (sub === 'list') console.log(JSON.stringify((await s.listReleases()).map((r) => ({ tagName: r.tag, isDraft: r.draft, createdAt: r.createdAt }))))
	else if (sub === 'create') await s.createRelease(tag, { draft: args.includes('--draft') })
	else if (sub === 'edit') await s.publishRelease(tag)
	else if (sub === 'delete') await s.deleteRelease(tag)
	else if (sub === 'view') console.log(JSON.stringify({ isDraft: false, assets: await s.listAssets(tag) }))
	else if (sub === 'upload') await s.putAsset(tag, args[3], args[3].split('/').pop())
	else if (sub === 'download') await s.getAsset(tag, after('-p'), after('-D'))
	else throw new Error('stub gh: unexpected ' + sub)
} catch (e) {
	console.error(e.message)
	process.exit(1)
}
`)
		writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec node ${JSON.stringify(join(bin, 'gh.mjs'))} "$@"\n`)
		writeFileSync(join(bin, 'security'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(secLog)}\ncase "$1" in\n  find-generic-password) if [ -f ${JSON.stringify(keyFile)} ]; then cat ${JSON.stringify(keyFile)}; else exit 44; fi ;;\n  *) exit 1 ;;\nesac\n`)
		// The vault clone's remote is a local bare repo here; only what `remote get-url` reports is stubbed.
		if (stubOrigin) {
			const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
			writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$*" in\n  *"remote get-url"*) echo https://github.com/me/workpulse-vault.git; exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`)
			chmodSync(join(bin, 'git'), 0o755)
		}
		chmodSync(join(bin, 'gh'), 0o755)
		chmodSync(join(bin, 'security'), 0o755)

		const vids = dir()
		writeFileSync(join(vids, 'clip one.mp4'), randomBytes(1500))
		const dbs = dir()
		const srcDb = makeDb(join(dbs, 'a.db'))
		const sb = brainSandbox({ config: { vault: { repo: 'me/workpulse-vault', device: 'mac', videos: [vids], databases: [srcDb], keyBackedUpAt: '2026-10-30T00:00:00.000Z' } } })
		const clone = join(home, '.workpulse', 'vault')
		mkdirSync(join(home, '.workpulse'))
		execFileSync('git', ['clone', '-q', sb.remote, clone], { stdio: 'ignore' })
		execFileSync('git', ['-C', clone, 'config', 'user.email', 'test@example.com'])
		execFileSync('git', ['-C', clone, 'config', 'user.name', 'Test'])
		const env = { HOME: home, PATH: `${bin}:${process.env.PATH}`, WP_BRAIN_REPO_VISIBILITY: 'private', WP_VAULT_PART_BYTES: partBytes }
		const run = (more, ...args) => sb.runWith({ ...env, ...more }, ...args)
		const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n') : [])
		const secCalls = () => (existsSync(secLog) ? readFileSync(secLog, 'utf8').trim().split('\n') : [])
		return { run, home, store, sb, clone, ghCalls, secCalls, env }
	}

	test('dry run, real run, list and status: only stubs are reached and the key is never printed', () => {
		const c = cli()
		const dry = c.run({}, 'vault', 'backup')
		assert.equal(dry.status, 0, dry.err)
		assert.match(dry.out, /clip one\.mp4/)
		assert.deepEqual(c.ghCalls(), [])

		const real = c.run({}, 'vault', 'backup', '--yes')
		assert.equal(real.status, 0, real.err)
		assert.match(real.out, /uploaded/i)
		assert.ok(c.ghCalls().some((l) => l.startsWith('release upload')))
		assert.ok(c.ghCalls().every((l) => l.includes('-R me/workpulse-vault')), 'every call names the vault repo')
		assert.ok(c.secCalls().every((l) => l === 'find-generic-password'))

		const pushed = JSON.parse(c.sb.git('--git-dir', c.sb.remote, 'show', 'main:manifest/mac.json'))
		assert.equal(pushed.items.length, 2)
		assert.deepEqual(readdirSync(join(c.home, '.workpulse', 'vault-tmp')), [])

		const l = c.run({}, 'vault', 'list')
		assert.equal(l.status, 0, l.err)
		assert.match(l.out, /clip one\.mp4/)
		assert.match(l.out, /a\.db/)

		const st = c.run({}, 'vault', 'status')
		assert.equal(st.status, 0, st.err)
		assert.match(st.out, /me\/workpulse-vault/)
		assert.match(st.out, /private/)
		assert.match(st.out, new RegExp(fingerprint(KEY)))

		const again = c.run({}, 'vault', 'backup', '--videos', '--yes')
		assert.equal(again.status, 0, again.err)
		assert.match(again.out, /skipped clip one\.mp4/)

		for (const r of [dry, real, l, st, again]) assert.ok(!(r.out + r.err).includes('AGE-SECRET-KEY-1'))
	})

	test('prune through the CLI: a dry run deletes nothing, --keep 0 --yes keeps the only snapshot, a bad --keep is refused', () => {
		const c = cli()
		assert.equal(c.run({}, 'vault', 'backup', '--yes').status, 0)
		const before = c.ghCalls().length
		const dry = c.run({}, 'vault', 'prune')
		assert.equal(dry.status, 0, dry.err)
		assert.match(dry.out, /nothing to delete/i)
		const yes = c.run({}, 'vault', 'prune', '--keep', '0', '--yes')
		assert.equal(yes.status, 0, yes.err)
		assert.match(yes.out, /newest verified snapshot is always kept/i)
		assert.ok(!c.ghCalls().slice(before).some((l) => l.startsWith('release delete')))
		const bad = c.run({}, 'vault', 'prune', '--keep', 'x')
		assert.notEqual(bad.status, 0)
		assert.match(bad.err, /--keep/)
		assert.notEqual(c.run({}, 'vault', 'prune', '--nope').status, 0)
		assert.ok(c.ghCalls().every((l) => l.includes('-R me/workpulse-vault')))
	})

	test('a public repo refuses with a non-zero exit, before gh or the Keychain', () => {
		const c = cli()
		const r = c.run({ WP_BRAIN_REPO_VISIBILITY: 'public' }, 'vault', 'backup', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /private/)
		assert.deepEqual(c.ghCalls(), [])
		assert.deepEqual(c.secCalls(), [])
		assert.equal(existsSync(join(c.home, '.workpulse', 'vault-tmp')), false)
	})

	test('a clone whose real origin is not the vault repo refuses, before gh or the Keychain', () => {
		const c = cli({ stubOrigin: false })
		const r = c.run({}, 'vault', 'backup', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /does not push to me\/workpulse-vault/)
		assert.deepEqual(c.ghCalls(), [])
		assert.deepEqual(c.secCalls(), [])
	})

	test('a missing key refuses through the real Keychain path, and nothing is added to it', () => {
		const c = cli({ key: null })
		const r = c.run({}, 'vault', 'backup', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /vault key import/)
		assert.deepEqual(c.secCalls(), ['find-generic-password'])
		assert.deepEqual(c.ghCalls(), [])
	})

	test('the part-size override is refused at 2 GiB', () => {
		const c = cli({ partBytes: String(2 * 1024 ** 3) })
		const r = c.run({}, 'vault', 'backup', '--yes')
		assert.notEqual(r.status, 0)
		assert.match(r.err, /2 GiB/)
		assert.deepEqual(c.ghCalls().filter((l) => l.startsWith('release upload')), [])
	})

	test('restore into a clean folder from a fresh clone: only stubs are reached, bytes and rows come back, the key is never printed', () => {
		const c = cli()
		assert.equal(c.run({}, 'vault', 'backup', '--yes').status, 0)
		rmSync(c.clone, { recursive: true, force: true })
		execFileSync('git', ['clone', '-q', c.sb.remote, c.clone], { stdio: 'ignore' })
		const to = join(dir(), 'restored')
		const ghBefore = c.ghCalls().length
		const none = c.run({}, 'vault', 'restore')
		assert.equal(none.status, 0, none.err)
		assert.match(none.out, /clip one\.mp4/)
		assert.match(none.out, /a\.db/)
		const v = c.run({}, 'vault', 'restore', 'clip one.mp4', '--to', to)
		assert.equal(v.status, 0, v.err)
		const d = c.run({}, 'vault', 'restore', 'a.db', '--to', to)
		assert.equal(d.status, 0, d.err)
		assert.deepEqual(readdirSync(to).sort(), ['a.db', 'clip one.mp4'])
		const DB = sqlite()
		const db = new DB(join(to, 'a.db'), { readOnly: true })
		assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok')
		db.close()
		assert.ok(c.ghCalls().slice(ghBefore).every((l) => l.startsWith('release ') && l.includes('-R me/workpulse-vault')))
		assert.ok(c.secCalls().every((l) => l === 'find-generic-password'))
		assert.deepEqual(readdirSync(join(c.home, '.workpulse', 'vault-tmp')), [])
		const again = c.run({}, 'vault', 'restore', 'a.db', '--to', to)
		assert.equal(again.status, 0, again.err)
		assert.match(again.out, /kept/i)
		const forced = c.run({}, 'vault', 'restore', '--force', 'a.db', '--to', to)
		assert.equal(forced.status, 0, forced.err)
		assert.doesNotMatch(forced.out, /kept/i)
		for (const r of [none, v, d, again, forced]) assert.ok(!(r.out + r.err).includes('AGE-SECRET-KEY-1'))
	})

	test('restore with a wrong key exits non-zero with wrong key and writes nothing', async () => {
		const c = cli()
		assert.equal(c.run({}, 'vault', 'backup', '--yes').status, 0)
		const other = await newKey()
		const bin = c.env.PATH.split(':')[0]
		writeFileSync(join(bin, 'security'), `#!/bin/sh\necho "$1" >> /dev/null\ncase "$1" in\n  find-generic-password) echo ${other} ;;\n  *) exit 1 ;;\nesac\n`)
		const to = join(dir(), 'restored')
		const r = c.run({}, 'vault', 'restore', 'a.db', '--to', to)
		assert.notEqual(r.status, 0)
		assert.match(r.err, /wrong key/)
		assert.ok(!r.err.includes('AGE-SECRET-KEY-1'))
		assert.equal(existsSync(to), false)
	})

	test('help lists the vault commands', () => {
		const c = cli()
		const r = c.run({}, 'help')
		assert.match(r.out, /wp-brain vault backup/)
		assert.match(r.out, /wp-brain vault list \| status/)
	})
})

describe('restore', () => {
	/** A backup of one video and one database, then a fresh clone and an empty target folder. */
	async function proof({ videoName = 'क्लिप one é.mp4', rows = 1 } = {}) {
		const d = dir()
		const vids = dir()
		const video = randomBytes(3500)
		writeFileSync(join(vids, videoName), video)
		const dbPath = makeDb(join(d, 'sessions.db'), 3000)
		const t = setup({ videos: [vids], databases: [dbPath] })
		await backup(t.ctx, REAL)
		const DB = sqlite()
		const src = new DB(dbPath, { readOnly: true })
		const expected = src.prepare('SELECT hex(v) AS h FROM t').all().map((r) => r.h)
		src.close()
		const fresh = join(dir(), 'clone')
		execFileSync('git', ['clone', '-q', t.sb.remote, fresh], { stdio: 'ignore' })
		const to = join(dir(), 'restored')
		mkdirSync(to)
		const ctx = { ...t.ctx, clone: fresh, stagingDir: join(dir(), 'vault-tmp') }
		return { t, ctx, to, video, videoName, expected, dbPath, vids }
	}
	const left = (p) => readdirSync(p)
	const noTemp = (ctx) => assert.deepEqual(left(ctx.stagingDir).filter((f) => f !== '.lock'), [])

	test('restores the video byte for byte under its original name, and the database with ok integrity and the same rows', async () => {
		const p = await proof()
		const v = await restore(p.ctx, { name: p.videoName, to: p.to })
		assert.deepEqual(v.files, [join(p.to, p.videoName)])
		assert.equal(sha(readFileSync(join(p.to, p.videoName))), sha(p.video))
		const r = await restore(p.ctx, { name: 'sessions.db', to: p.to })
		assert.deepEqual(r.files, [join(p.to, 'sessions.db')])
		const DB = sqlite()
		const db = new DB(join(p.to, 'sessions.db'), { readOnly: true })
		assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok')
		assert.deepEqual(db.prepare('SELECT hex(v) AS h FROM t').all().map((x) => x.h), p.expected)
		db.close()
		assert.equal(statSync(join(p.to, 'sessions.db')).mode & 0o777, 0o600)
		assert.deepEqual(left(p.to).sort(), [p.videoName, 'sessions.db'].sort())
		noTemp(p.ctx)
	})

	test('restores by id, and a name picks the newest snapshot', async () => {
		const p = await proof()
		const first = list(p.t.ctx).find((i) => i.kind === 'database')
		const DB = sqlite()
		const db = new DB(p.dbPath)
		db.prepare('INSERT INTO t VALUES (?)').run(Buffer.from('second'))
		db.close()
		await backup({ ...p.t.ctx, now: () => Date.parse('2026-11-01T10:00:00.000Z') }, { yes: true, databases: true })
		execFileSync('git', ['-C', p.ctx.clone, 'pull', '-q'], { stdio: 'ignore' })
		await restore(p.ctx, { name: 'sessions.db', to: p.to })
		const open = (f) => {
			const x = new DB(f, { readOnly: true })
			const n = x.prepare('SELECT count(*) AS n FROM t').get().n
			x.close()
			return n
		}
		assert.equal(open(join(p.to, 'sessions.db')), 2)
		const old = join(dir(), 'old')
		await restore(p.ctx, { id: first.id, to: old })
		assert.equal(open(join(old, 'sessions.db')), 1)
	})

	test('a different key refuses with wrong key and leaves no file, no partial and no temp', async () => {
		const p = await proof()
		const other = fakeKeystore()
		other.set('me', await newKey())
		const ctx = { ...p.ctx, keystore: other }
		await assert.rejects(restore(ctx, { name: 'sessions.db', to: p.to }), (e) => /wrong key/.test(e.message) && !e.message.includes('AGE-SECRET-KEY-1'))
		assert.deepEqual(left(p.to), [])
		assert.ok(!existsSync(ctx.stagingDir) || left(ctx.stagingDir).every((f) => f === '.lock'))
	})

	test('no key at all refuses and tells the owner to import it', async () => {
		const p = await proof()
		const ctx = { ...p.ctx, keystore: fakeKeystore() }
		await assert.rejects(restore(ctx, { name: 'sessions.db', to: p.to }), /vault key import/)
		assert.deepEqual(left(p.to), [])
	})

	test('a Keychain that cannot be read keeps its own error', async () => {
		const p = await proof()
		const ctx = { ...p.ctx, keystore: { get() { throw new Error('could not read the Keychain') } } }
		await assert.rejects(restore(ctx, { name: 'sessions.db', to: p.to }), (e) => /could not read the Keychain/.test(e.message) && !/key import/.test(e.message))
	})

	test('a damaged part stops at that part, names it, and writes nothing', async () => {
		const p = await proof()
		const item = list(p.ctx).find((i) => i.kind === 'video')
		const bad = item.parts[2].asset
		const ctx = { ...p.ctx, storage: p.t.withStorage({ corruptAsset: bad }).storage }
		await assert.rejects(restore(ctx, { name: p.videoName, to: p.to }), (e) => e.message.includes(bad) && /damaged|differs/.test(e.message))
		assert.deepEqual(left(p.to), [])
		noTemp(ctx)
	})

	test('a part missing from the release says the snapshot is incomplete', async () => {
		const p = await proof()
		const item = list(p.ctx).find((i) => i.kind === 'video')
		rmSync(p.t.asset(item.release, item.parts[1].asset))
		await assert.rejects(restore(p.ctx, { name: p.videoName, to: p.to }), (e) => /incomplete/.test(e.message) && e.message.includes(item.parts[1].asset))
		assert.deepEqual(left(p.to), [])
		noTemp(p.ctx)
	})

	test('a file that is already there is kept and reported, and --force replaces it', async () => {
		const p = await proof()
		writeFileSync(join(p.to, p.videoName), 'mine')
		const r = await restore(p.ctx, { name: p.videoName, to: p.to })
		assert.deepEqual(r.files, [])
		assert.deepEqual(r.kept, [join(p.to, p.videoName)])
		assert.equal(readFileSync(join(p.to, p.videoName), 'utf8'), 'mine')
		assert.match(p.t.text(), /kept/i)
		const f = await restore(p.ctx, { name: p.videoName, to: p.to, force: true })
		assert.deepEqual(f.files, [join(p.to, p.videoName)])
		assert.equal(sha(readFileSync(join(p.to, p.videoName))), sha(p.video))
		assert.deepEqual(left(p.to), [p.videoName])
	})

	test('a manifest name that is not a bare filename is refused and nothing is written outside --to', async () => {
		const p = await proof()
		const file = join(p.ctx.clone, 'manifest', 'mac.json')
		const m = JSON.parse(readFileSync(file, 'utf8'))
		m.items[0].name = '../escape.mp4'
		writeFileSync(file, JSON.stringify(m))
		await assert.rejects(restore(p.ctx, { id: m.items[0].id, to: p.to }), /vault manifest: item .* not a bare filename/)
		assert.equal(existsSync(join(p.to, '..', 'escape.mp4')), false)
		assert.deepEqual(left(p.to), [])
	})

	test('a repo that is not private, or a clone of another repo, refuses before reading', async () => {
		const p = await proof()
		await assert.rejects(restore({ ...p.ctx, repoVisibility: () => 'public' }, { name: p.videoName, to: p.to }), /private/)
		await assert.rejects(restore({ ...p.ctx, repoVisibility: () => 'unknown' }, { name: p.videoName, to: p.to }), /private/)
		await assert.rejects(restore({ ...p.ctx, cloneRepo: () => 'me/other' }, { name: p.videoName, to: p.to }), /does not push to me\/workpulse-vault/)
		assert.deepEqual(left(p.to), [])
	})

	test('an unknown name, a missing --to and not enough disk are refused', async () => {
		const p = await proof()
		await assert.rejects(restore(p.ctx, { name: 'nope.mp4', to: p.to }), /nothing in the vault/i)
		await assert.rejects(restore(p.ctx, { name: p.videoName }), /--to/)
		await assert.rejects(restore({ ...p.ctx, freeBytes: () => 10 }, { name: p.videoName, to: p.to }), /free disk/i)
		assert.deepEqual(left(p.to), [])
	})

	test('a backup still waiting to resume keeps its staged parts through a restore', async () => {
		const p = await proof()
		const d = dir()
		const db2 = makeDb(join(d, 'other.db'), 3000)
		const t2 = setup({ databases: [db2], fake: { failPutsAfter: 1 } })
		const ctx = { ...p.ctx, stagingDir: t2.ctx.stagingDir }
		await assert.rejects(backup(t2.ctx, REAL))
		const before = readdirSync(t2.ctx.stagingDir).filter((f) => f !== '.lock')
		const staged = before.flatMap((f) => readdirSync(join(t2.ctx.stagingDir, f)).map((x) => `${f}/${x}`)).sort()
		assert.ok(staged.length > 1)
		await restore(ctx, { name: p.videoName, to: p.to })
		const after = readdirSync(t2.ctx.stagingDir).filter((f) => f !== '.lock')
		assert.deepEqual(after, before)
		assert.deepEqual(after.flatMap((f) => readdirSync(join(t2.ctx.stagingDir, f)).map((x) => `${f}/${x}`)).sort(), staged)
	})

	test('a live backup holds the staging folder, so a restore stops', async () => {
		const p = await proof()
		mkdirSync(p.ctx.stagingDir, { recursive: true })
		writeFileSync(join(p.ctx.stagingDir, '.lock'), String(process.pid))
		await assert.rejects(restore(p.ctx, { name: p.videoName, to: p.to }), /already running/)
		assert.deepEqual(left(p.to), [])
	})

	test('a part name that is not a bare filename is refused by restore itself', async () => {
		const p = await proof()
		const file = join(p.ctx.clone, 'manifest', 'mac.json')
		const m = JSON.parse(readFileSync(file, 'utf8'))
		const v = m.items.find((i) => i.kind === 'video')
		v.parts[0].asset = '../x'
		writeFileSync(file, JSON.stringify(m))
		await assert.rejects(restore(p.ctx, { id: v.id, to: p.to }), /lists a part name that is not a bare filename/)
		assert.deepEqual(left(p.to), [])
	})

	test('stale plaintext of a killed backup is cleared even by a refused restore; state and encrypted parts stay', async () => {
		const p = await proof()
		const item = join(p.ctx.stagingDir, 'database-x')
		mkdirSync(item, { recursive: true })
		writeFileSync(join(item, 'state.json'), JSON.stringify({ tag: 'snap-x', kind: 'database', parts: [{ asset: 'aa.part001' }] }))
		for (const f of ['aa.part001', 'snapshot.db', 'snapshot.db.gz', 'x.partial']) writeFileSync(join(item, f), 'secret')
		mkdirSync(join(p.ctx.stagingDir, 'restore-dead'))
		await assert.rejects(restore(p.ctx, { name: 'nope.mp4', to: p.to }), /nothing in the vault/i)
		assert.deepEqual(left(item).sort(), ['aa.part001', 'state.json'])
		assert.equal(existsSync(join(p.ctx.stagingDir, 'restore-dead')), false)
		await assert.rejects(restore({ ...p.ctx, repoVisibility: () => 'public' }, { name: p.videoName, to: p.to }), /private/)
	})

	test('a restore waiting behind a live run does not pull the clone', async () => {
		const p = await proof()
		mkdirSync(p.ctx.stagingDir, { recursive: true })
		writeFileSync(join(p.ctx.stagingDir, '.lock'), String(process.pid))
		const before = execFileSync('git', ['-C', p.ctx.clone, 'reflog'], { encoding: 'utf8' })
		await assert.rejects(restore(p.ctx, { name: p.videoName, to: p.to }), /already running/)
		assert.equal(execFileSync('git', ['-C', p.ctx.clone, 'reflog'], { encoding: 'utf8' }), before)
	})

	test('a file that appears in --to while the parts download is kept, without --force', async () => {
		const p = await proof()
		const s = p.ctx.storage
		const storage = { ...s, getAsset: async (...a) => (writeFileSync(join(p.to, p.videoName), 'mine'), s.getAsset(...a)) }
		const r = await restore({ ...p.ctx, storage }, { name: p.videoName, to: p.to })
		assert.deepEqual(r.files, [])
		assert.deepEqual(r.kept, [join(p.to, p.videoName)])
		assert.equal(readFileSync(join(p.to, p.videoName), 'utf8'), 'mine')
		assert.deepEqual(left(p.to), [p.videoName])
		noTemp(p.ctx)
	})

	test('a release that cannot be read says so, and only a missing one reads as incomplete', async () => {
		const p = await proof()
		const down = { ...p.ctx.storage, listAssets: async () => { throw new Error('HTTP 503: try later') } }
		await assert.rejects(restore({ ...p.ctx, storage: down }, { name: p.videoName, to: p.to }), (e) => /could not be read/.test(e.message) && !/incomplete/.test(e.message))
		const gone = { ...p.ctx.storage, listAssets: async (t) => { throw new Error(`release ${t} not found`) } }
		await assert.rejects(restore({ ...p.ctx, storage: gone }, { name: p.videoName, to: p.to }), /incomplete/)
		assert.deepEqual(left(p.to), [])
	})

	test('a database beside an old -wal or -shm is refused, also with --force', async () => {
		const p = await proof()
		writeFileSync(join(p.to, 'sessions.db'), 'old')
		writeFileSync(join(p.to, 'sessions.db-wal'), 'log')
		await assert.rejects(restore(p.ctx, { name: 'sessions.db', to: p.to, force: true }), (e) => /sessions\.db-wal/.test(e.message) && /replay/.test(e.message))
		assert.equal(readFileSync(join(p.to, 'sessions.db'), 'utf8'), 'old')
		rmSync(join(p.to, 'sessions.db'))
		writeFileSync(join(p.to, 'sessions.db-shm'), 'x')
		await assert.rejects(restore(p.ctx, { name: 'sessions.db', to: p.to }), /sessions\.db-shm/)
		assert.equal(existsSync(join(p.to, 'sessions.db')), false)
	})

	for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']) {
		test(`where hard links fail (${code}) a restore without --force falls back to an exclusive copy`, async () => {
			const p = await proof()
			const calls = []
			const linkFile = (a, b) => {
				calls.push(b)
				throw Object.assign(new Error('no links here'), { code })
			}
			const ctx = { ...p.ctx, linkFile }
			await restore(ctx, { name: p.videoName, to: p.to })
			await restore(ctx, { name: 'sessions.db', to: p.to })
			assert.equal(calls.length, 2)
			assert.equal(sha(readFileSync(join(p.to, p.videoName))), sha(p.video))
			assert.equal(statSync(join(p.to, 'sessions.db')).mode & 0o777, 0o600)
			assert.deepEqual(left(p.to).sort(), [p.videoName, 'sessions.db'].sort())
			noTemp(ctx)
		})
	}

	test('where hard links fail, the copy goes to a temp name: a kill during it leaves no file under the real name, and a failure leaves nothing', async () => {
		const p = await proof()
		const linkFile = () => { throw Object.assign(new Error('no links here'), { code: 'EXDEV' }) }
		for (const name of [p.videoName, 'sessions.db']) {
			const dest = join(p.to, name)
			let during = null
			const copyFile = (from, to) => {
				writeFileSync(to, readFileSync(from).subarray(0, 100)) // the first bytes are out when it stops
				during = { real: existsSync(dest), temp: to }
				throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
			}
			await assert.rejects(restore({ ...p.ctx, linkFile, copyFile }, { name, to: p.to }), /no space left/)
			assert.equal(during.real, false, 'a kill at this moment leaves no file that reads as kept')
			assert.notEqual(during.temp, dest)
			assert.equal(existsSync(during.temp), false)
			assert.deepEqual(left(p.to).filter((f) => f === name || f.includes('.partial')), [])
			noTemp(p.ctx)
			const again = await restore({ ...p.ctx, linkFile }, { name, to: p.to })
			assert.deepEqual(again.files, [dest], 'not "kept": nothing was left to keep')
		}
		assert.equal(sha(readFileSync(join(p.to, p.videoName))), sha(p.video))
	})

	test('where hard links fail, a file that appears while the copy runs is kept and the temp copy goes', async () => {
		const p = await proof()
		const linkFile = () => { throw Object.assign(new Error('no links here'), { code: 'ENOTSUP' }) }
		const dest = join(p.to, 'sessions.db')
		const copyFile = (from, to, mode) => {
			copyFileSync(from, to, mode)
			writeFileSync(dest, 'mine')
		}
		const r = await restore({ ...p.ctx, linkFile, copyFile }, { name: 'sessions.db', to: p.to })
		assert.deepEqual(r.kept, [dest])
		assert.equal(readFileSync(dest, 'utf8'), 'mine')
		assert.deepEqual(left(p.to), ['sessions.db'])
	})

	test('an empty file left under the real name is kept, and the message says it is empty', async () => {
		const p = await proof()
		const dest = join(p.to, 'sessions.db')
		writeFileSync(dest, '')
		const r = await restore(p.ctx, { name: 'sessions.db', to: p.to })
		assert.deepEqual(r.kept, [dest])
		assert.match(p.t.text(), /empty/)
		assert.match(p.t.text(), /--force/)
	})

	test('a restore says which device and date the file came from', async () => {
		const p = await proof()
		await restore(p.ctx, { name: 'sessions.db', to: p.to })
		const line = p.t.logged.find((l) => l.startsWith('restored '))
		assert.match(line, /from device mac/)
		assert.match(line, /2026-10-31/)
	})

	test('the exclusive-copy fallback still keeps a file that appeared meanwhile, for a database too', async () => {
		const p = await proof()
		const linkFile = () => { throw Object.assign(new Error('no links here'), { code: 'EPERM' }) }
		const s = p.ctx.storage
		const storage = { ...s, getAsset: async (...a) => (writeFileSync(join(p.to, 'sessions.db'), 'mine'), s.getAsset(...a)) }
		const r = await restore({ ...p.ctx, linkFile, storage }, { name: 'sessions.db', to: p.to })
		assert.deepEqual(r.kept, [join(p.to, 'sessions.db')])
		assert.equal(readFileSync(join(p.to, 'sessions.db'), 'utf8'), 'mine')
		assert.deepEqual(left(p.to), ['sessions.db'])
	})
})

describe('prune', () => {
	const DATES = ['2026-06-01', '2026-08-05', '2026-08-20', '2026-09-03', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']
	const PRUNED = ['2026-06-01', '2026-08-05', '2026-10-20']
	const at = (day) => () => Date.parse(`${day}T09:00:00.000Z`)

	/** A vault with one snapshot per date in DATES (and a video in the first run), made by real backups. */
	async function vault(more = {}) {
		const d = dir()
		const videos = dir()
		writeFileSync(join(videos, 'clip.mp4'), randomBytes(2500))
		const t = setup({ databases: [makeDb(join(d, 'a.db'), 1500)], videos: [videos], ...more })
		const tagOf = {}
		for (const [i, day] of DATES.entries()) {
			const r = await backup({ ...t.ctx, now: at(day) }, { yes: true, videos: i === 0 ? undefined : false, databases: i === 0 ? undefined : true })
			tagOf[day] = r.snapshot
		}
		return { t, tagOf, days: (tags) => DATES.filter((x) => tags.includes(tagOf[x])) }
	}
	const prunedTags = (v) => PRUNED.map((x) => v.tagOf[x])
	const orphan = (t, tag, createdAt) => {
		mkdirSync(join(t.store, tag, 'assets'), { recursive: true })
		writeFileSync(join(t.store, tag, 'assets', 'x-1.part000'), 'leftover!')
		writeFileSync(join(t.store, tag, 'release.json'), JSON.stringify({ draft: false, createdAt }))
	}
	const NOW = '2026-10-31T10:00:00.000Z'

	test('without --yes it deletes nothing and lists every snapshot with its size', async () => {
		const v = await vault()
		const before = v.t.tags()
		const m = v.t.manifest()
		const items = m.items
		// a pending, uncommitted manifest change: a preview must neither commit nor push it
		writeManifest(join(v.t.sb.clone, 'manifest', 'mac.json'), { ...m, items: m.items.map((i) => (i.kind === 'video' ? { ...i, name: 'renamed.mp4' } : i)) })
		const remoteHead = v.t.sb.git('--git-dir', v.t.sb.remote, 'rev-parse', 'main').trim()
		const cloneHead = v.t.sb.git('-C', v.t.sb.clone, 'rev-parse', 'HEAD').trim()
		const r = await prune(v.t.ctx, {})
		assert.equal(v.t.sb.git('--git-dir', v.t.sb.remote, 'rev-parse', 'main').trim(), remoteHead, 'nothing pushed')
		assert.equal(v.t.sb.git('-C', v.t.sb.clone, 'rev-parse', 'HEAD').trim(), cloneHead, 'nothing committed')
		assert.ok(v.t.sb.git('-C', v.t.sb.clone, 'status', '--porcelain', '--', 'manifest/mac.json').trim(), 'the pending change is still pending')
		assert.deepEqual(v.t.tags(), before)
		assert.deepEqual(v.t.manifest().items.map((i) => i.id), items.map((i) => i.id))
		assert.deepEqual(r.deleted, [])
		const text = v.t.text()
		for (const tag of prunedTags(v)) assert.ok(text.includes(tag), `lists ${tag}`)
		assert.match(text, /would free/i)
		assert.match(text, /--yes/)
		assert.match(text, /\d+(\.\d)? (B|KB)/)
		assert.ok(!text.includes(v.tagOf['2026-10-25'] + ' '), 'a kept snapshot is not offered')
	})

	test('with --yes: pruned snapshots lose their releases and manifest items; recent, monthly and videos stay; restore of a kept one works', async () => {
		const v = await vault()
		const r = await prune(v.t.ctx, { yes: true })
		assert.deepEqual([...r.deleted].sort(), prunedTags(v).sort())
		const tags = v.t.tags()
		for (const tag of prunedTags(v)) assert.ok(!tags.includes(tag))
		const left = v.t.manifest().items
		assert.deepEqual(left.filter((i) => i.kind === 'database').map((i) => i.release).sort(), DATES.filter((x) => !PRUNED.includes(x)).map((x) => v.tagOf[x]).sort())
		assert.equal(left.filter((i) => i.kind === 'video').length, 1)
		assert.ok(tags.includes('videos-0001'))
		assert.deepEqual(v.t.pushed().items.map((i) => i.id).sort(), left.map((i) => i.id).sort(), 'the pruned manifest is pushed')
		const kept = left.find((i) => i.kind === 'database')
		const to = dir()
		const res = await restore(v.t.ctx, { id: kept.id, to })
		assert.equal(res.files.length, 1)
		assert.equal(statSync(res.files[0]).size, kept.size)
	})

	test('--keep 0 still keeps the newest verified snapshot and says so', async () => {
		const v = await vault()
		await prune(v.t.ctx, { yes: true, keep: 0 })
		const dbs = v.t.manifest().items.filter((i) => i.kind === 'database')
		assert.ok(dbs.length >= 1)
		assert.ok(dbs.some((i) => i.release === v.tagOf['2026-10-25']))
		assert.ok(v.t.tags().includes(v.tagOf['2026-10-25']))
		assert.match(v.t.text(), /newest verified snapshot is always kept/i)
	})

	test('--keep N sets only the recent count', async () => {
		const v = await vault()
		const r = await prune(v.t.ctx, { yes: true, keep: 2 })
		// recent 2 (10-25, 10-24) + newest of Oct, Sep, Aug (10-25, 09-03, 08-20)
		assert.deepEqual(v.days(v.t.tags()), ['2026-08-20', '2026-09-03', '2026-10-24', '2026-10-25'])
		assert.equal(r.deleted.length, 6)
	})

	test('a bad --keep is refused before anything is read', async () => {
		const v = await vault()
		for (const keep of [-1, 1.5, 'x', NaN]) await assert.rejects(prune(v.t.ctx, { yes: true, keep }), /--keep/)
	})

	test('an orphan older than 24 hours is listed first and deleted only with --yes; a younger one is reported and left', async () => {
		const v = await vault()
		const old = 'snap-20260101T000000Z-mac'
		const young = 'snap-20261031T000000Z-mac'
		orphan(v.t, old, '2026-01-01T00:00:00.000Z')
		orphan(v.t, young, '2026-10-31T00:00:00.000Z')
		const mark = v.t.logged.length
		const dry = await prune(v.t.ctx, {})
		assert.ok(v.t.tags().includes(old))
		assert.deepEqual(dry.orphans, [old])
		const text = v.t.logged.slice(mark).join('\n')
		assert.ok(text.indexOf(old) < text.indexOf(prunedTags(v)[0]), 'orphans come first')
		assert.match(text, new RegExp(`left\\s+${young}\\s+published.*under a day`))
		const r = await prune(v.t.ctx, { yes: true })
		assert.deepEqual(r.orphans, [old])
		assert.ok(!v.t.tags().includes(old))
		assert.ok(v.t.tags().includes(young))
	})

	test('an orphan of another device, and a videos- release, are never deleted', async () => {
		const v = await vault()
		orphan(v.t, 'snap-20260101T000000Z-other', '2026-01-01T00:00:00.000Z')
		orphan(v.t, 'videos-0002', '2026-01-01T00:00:00.000Z')
		orphan(v.t, 'snap-20260101T000000Z-big-mac', '2026-01-01T00:00:00.000Z')
		const r = await prune(v.t.ctx, { yes: true })
		assert.deepEqual(r.orphans, [])
		for (const tag of ['snap-20260101T000000Z-other', 'videos-0002', 'snap-20260101T000000Z-big-mac']) assert.ok(v.t.tags().includes(tag), tag)
	})

	test("a release an unfinished backup is resuming is not an orphan to delete", async () => {
		const d = dir()
		const t = setup({ databases: [makeDb(join(d, 'a.db'), 3000)], fake: { failPutsAfter: 1 } })
		await assert.rejects(backup(t.ctx, REAL))
		const [tag] = t.tags()
		assert.ok(tag.startsWith('snap-'))
		writeFileSync(join(t.store, tag, 'release.json'), JSON.stringify({ draft: true, createdAt: '2026-01-01T00:00:00.000Z' }))
		const r = await prune(t.ctx, { yes: true })
		assert.deepEqual(r.orphans, [])
		assert.ok(t.tags().includes(tag))
		assert.match(t.text(), /resum/i)
		// once the staged copy is discarded, the same release is an ordinary old orphan
		await backup(t.ctx, { discardStaged: true })
		const r2 = await prune(t.ctx, { yes: true })
		assert.deepEqual(r2.orphans, [tag])
		assert.ok(!t.tags().includes(tag))
	})

	test('a failed delete leaves that manifest item, continues, and status still tells the truth', async () => {
		const v = await vault()
		const [first, ...rest] = prunedTags(v)
		const real = v.t.ctx.storage
		const ctx = { ...v.t.ctx, storage: { ...real, deleteRelease: async (tag) => (tag === first ? Promise.reject(new Error('HTTP 502: boom')) : real.deleteRelease(tag)) } }
		const r = await prune(ctx, { yes: true })
		assert.deepEqual([...r.deleted].sort(), rest.sort())
		assert.deepEqual(r.failed.map((f) => f.tag), [first])
		assert.ok(v.t.tags().includes(first))
		const releases = v.t.manifest().items.map((i) => i.release)
		assert.ok(releases.includes(first), 'its item stays')
		for (const tag of rest) assert.ok(!releases.includes(tag))
		assert.match(v.t.text(), /HTTP 502/)
		const s = await status(v.t.ctx)
		assert.equal(s.orphans.length, 0)
	})

	test('it refuses a public repo and a foreign clone, deleting nothing', async () => {
		const v = await vault()
		await assert.rejects(prune({ ...v.t.ctx, repoVisibility: () => 'public' }, { yes: true }), /private/)
		await assert.rejects(prune({ ...v.t.ctx, cloneRepo: () => 'someone/else' }, { yes: true }), /does not push to/)
		assert.equal(v.t.tags().length, DATES.length + 1)
	})

	test('it holds the staging lock', async () => {
		const v = await vault()
		writeFileSync(join(v.t.ctx.stagingDir, '.lock'), String(process.pid))
		await assert.rejects(prune(v.t.ctx, { yes: true }), /already running/)
		assert.equal(v.t.tags().length, DATES.length + 1)
	})

	test("another device's snapshots and manifest are never touched, and its manifest is pulled before orphans are judged", async () => {
		const v = await vault()
		const other = join(dir(), 'other')
		v.t.sb.git('clone', '-q', v.t.sb.remote, other)
		v.t.sb.git('-C', other, 'config', 'user.email', 't@example.com')
		v.t.sb.git('-C', other, 'config', 'user.name', 'T')
		const tag = 'snap-20260101T000000Z-other'
		orphan(v.t, tag, '2026-01-01T00:00:00.000Z')
		writeManifest(join(other, 'manifest', 'other.json'), { version: 1, device: 'other', items: [{ id: 'i-0123456789abcdef', kind: 'database', name: 'o.db', size: 1, sha256: 'a'.repeat(64), date: '2026-01-01T00:00:00.000Z', release: tag, parts: [{ asset: 'x-1.part000', size: 9, sha256: 'b'.repeat(64) }], verifiedAt: '2026-01-01T00:00:00.000Z' }] })
		v.t.sb.git('-C', other, 'add', 'manifest/other.json')
		v.t.sb.git('-C', other, 'commit', '-q', '-m', 'other')
		v.t.sb.git('-C', other, 'push', '-q', 'origin', 'HEAD:main')
		await prune(v.t.ctx, { yes: true })
		assert.ok(existsSync(join(v.t.sb.clone, 'manifest', 'other.json')), 'pulled')
		assert.ok(v.t.tags().includes(tag))
		assert.equal(readManifest(join(v.t.sb.clone, 'manifest', 'other.json')).items.length, 1)
	})
	/** A vault with two snapshots a day apart: `--keep 0` prunes the first one. */
	async function small(more = {}) {
		const d = dir()
		const t = setup({ databases: [makeDb(join(d, 'a.db'), 1500)], ...more })
		const first = (await backup({ ...t.ctx, now: at('2026-10-01') }, REAL)).snapshot
		const second = (await backup({ ...t.ctx, now: at('2026-10-02') }, REAL)).snapshot
		return { t, first, second }
	}
	const rawCfg = { device: 'mac', vault: { repo: 'me/workpulse-vault' } }

	test('a preview works offline on the local view and creates no staging folder; a refused run creates none either', async () => {
		const t = setup()
		await assert.rejects(prune({ ...t.ctx, repoVisibility: () => 'public' }, { yes: true }), /private/)
		await assert.rejects(prune({ ...t.ctx, cloneRepo: () => 'someone/else' }, { yes: true }), /does not push to/)
		assert.equal(existsSync(t.ctx.stagingDir), false)
		t.sb.git('-C', t.sb.clone, 'remote', 'set-url', 'origin', join(dir(), 'nowhere.git'))
		await prune(t.ctx, {})
		assert.match(t.text(), /local view/)
		assert.equal(existsSync(t.ctx.stagingDir), false, 'a preview takes no lock')
	})

	test('through the CLI: --yes with a value, an extra word and a failed delete are all refused or non-zero', async () => {
		const s = await small()
		const deps = { ...s.t.ctx, cfg: rawCfg }
		await assert.rejects(runVaultCli({ pos: ['prune'], opt: { yes: 'no' } }, deps), /--yes takes no value/)
		await assert.rejects(runVaultCli({ pos: ['prune', '3'], opt: {} }, deps), /no argument/)
		assert.ok(s.t.tags().includes(s.first))
		const real = s.t.ctx.storage
		const failing = { ...deps, storage: { ...real, deleteRelease: async () => Promise.reject(new Error('HTTP 502')) } }
		await assert.rejects(runVaultCli({ pos: ['prune'], opt: { keep: '0', yes: true } }, failing), (e) => e.message.includes(s.first) && /could not be deleted/.test(e.message))
		assert.ok(s.t.tags().includes(s.first))
		await runVaultCli({ pos: ['prune'], opt: { keep: '0', yes: true } }, deps)
		assert.ok(!s.t.tags().includes(s.first))
		assert.ok(s.t.tags().includes(s.second))
	})

	test("a snapshot whose release also holds a kept item, and one another device lists, are not deleted", async () => {
		const v = await vault()
		const [shared, holds] = [v.tagOf['2026-08-05'], v.tagOf['2026-06-01']]
		// the video item now points at an old snapshot's release: that snapshot is not whole
		const path = join(v.t.sb.clone, 'manifest', 'mac.json')
		const m = readManifest(path)
		writeManifest(path, { ...m, items: m.items.map((i) => (i.kind === 'video' ? { ...i, release: holds } : i)) })
		// another device lists a pruned snapshot too
		writeManifest(join(v.t.sb.clone, 'manifest', 'other.json'), { version: 1, device: 'other', items: [{ id: 'i-0123456789abcdef', kind: 'database', name: 'o.db', size: 1, sha256: 'a'.repeat(64), date: '2026-08-05T00:00:00.000Z', release: shared, parts: [{ asset: 'x-1.part000', size: 9, sha256: 'b'.repeat(64) }], verifiedAt: '2026-08-05T00:00:00.000Z' }] })
		const r = await prune(v.t.ctx, { yes: true })
		assert.deepEqual(r.deleted, [v.tagOf['2026-10-20']])
		assert.ok(v.t.tags().includes(holds) && v.t.tags().includes(shared))
		assert.match(v.t.text(), /another device's manifest lists/)
	})

	test("an emptied manifest with published snapshot releases deletes nothing and says so; drafts alone are still cleaned", async () => {
		const s = await small()
		writeManifest(join(s.t.sb.clone, 'manifest', 'mac.json'), { version: 1, device: 'mac', items: [] })
		s.t.sb.git('-C', s.t.sb.clone, 'commit', '-q', '-am', 'oops')
		const tags = s.t.tags()
		await assert.rejects(prune(s.t.ctx, { yes: true }), (e) => /lists no database/.test(e.message) && /nothing was deleted/.test(e.message))
		await assert.rejects(prune(s.t.ctx, {}), /lists no database/)
		assert.deepEqual(s.t.tags(), tags)
	})

})
