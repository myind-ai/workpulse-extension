// node --test cli/auto-backup.test.mjs
// Temp folders, a local bare remote, the fake vault storage and a fake key store. Never the real Keychain, GitHub or launchctl. Session text is synthetic.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { backupAll, backupRows, backupStatusLines, icloudWarning, readBackupStatus, staleParts, staleBackupLine, writeBackupStatus } from './auto-backup.mjs'
import { realParts } from './backup-parts.mjs'
import { loadMask, openMemory, writeBatch } from './memory-db.mjs'
import { transcript, writeSession } from './memory-fixture.mjs'
import { brainSandbox } from './sandbox.mjs'
import { unpack } from './session-pack.mjs'
import { tokensOf } from './budget.mjs'
import { backup } from './vault.mjs'
import { fakeKeystore, newKey } from './vault-crypto.mjs'
import { fakeStorage } from './vault-fake.mjs'
import { parseVaultConfig } from './vault-manifest.mjs'
import { restore } from './vault-restore.mjs'

const mask = await loadMask()
const DAY = 86_400_000
const NOW = Date.parse('2026-11-01T10:00:00Z')
const KEY = await newKey()
const SID = 'bbbbbbbb-1111-2222-3333-444444444444'
const PLAIN = 'zebra-marker private words'

/** Temp folders and every environment seam; the parts read these when they are called. */
function box(t, more = {}) {
	const root = mkdtempSync(join(tmpdir(), 'wp-backup-'))
	const env = {
		WP_MEMORY_DB: join(root, 'memory', 'memory.db'),
		WP_SESSIONS_MD: join(root, 'md'),
		WP_SESSIONS_PACK: join(root, 'memory', 'session-files.db'),
		WP_BACKUP_STATUS: join(root, 'memory', 'backup-status.json'),
		WP_BRAIN_SESSIONS: join(root, 'sessions'),
		CLAUDE_HOME: join(root, 'claude'),
		YT_LEARN_ROOT: join(root, 'learning'),
		WP_CLAUDE_DOCS: join(root, 'claude-docs'),
		WP_ICLOUD_DESKTOP: '0',
		...more,
	}
	const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
	Object.assign(process.env, env)
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
		rmSync(root, { recursive: true, force: true })
	})
	return { root, env }
}

/** A session in the database with a Markdown-worthy prompt, as the worker leaves it. */
function seedDb(env) {
	const db = openMemory(env.WP_MEMORY_DB)
	writeBatch(db, { session: { id: SID, cwd: '/x/app', repo: '/x/app', branch: 'main', title: 'A title', entrypoint: 'cli', startedAt: NOW - DAY, lastEventAt: NOW - DAY }, messages: [{ uuid: 'u1', block: 0, role: 'prompt', at: NOW - DAY, text: PLAIN }] }, { mask })
	db.close()
}

/** cfg, the fake storage and the vault seams. */
function vaultBox(t, b, cfgMore = {}, vaultMore = {}, fake = {}) {
	const sb = brainSandbox()
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	const store = join(b.root, 'store')
	const keystore = fakeKeystore()
	keystore.set('me', KEY)
	const cfg = { device: 'mac', vault: { repo: 'me/workpulse-vault', keyBackedUpAt: '2026-10-30T00:00:00.000Z', ...vaultMore }, ...cfgMore }
	const staging = join(b.root, 'vault-tmp')
	const seams = (extra = fake) => ({ storage: fakeStorage(store, extra), keystore, clone: sb.clone, stagingDir: staging, repoVisibility: () => 'private', cloneRepo: () => 'me/workpulse-vault', freeBytes: () => 1e12, partBytes: 1_000_000 })
	const assets = () => (existsSync(store) ? readdirSync(store).flatMap((tag) => readdirSync(join(store, tag, 'assets')).map((a) => join(store, tag, 'assets', a))) : [])
	return { sb, cfg, seams, store, staging, assets }
}

const quiet = () => {}
const noBrain = { libraryAdd: () => { throw new Error('no library here') }, configBackup: () => { throw new Error('no config here') } }
const run = (cfg, deps = {}, now = NOW, extra = {}) => backupAll({ cfg, parts: realParts(cfg, { ...noBrain, now: () => now, ...deps }), print: quiet, now: () => now, ...extra })
const states = (r) => Object.fromEntries(r.results.map((p) => [p.name, p.state]))

test('nothing set up: every part is skipped with a reason, and that is not a failure', async (t) => {
	box(t)
	const r = await run({ device: 'mac' })
	assert.deepEqual(r.failed, [])
	assert.deepEqual(r.results.map((p) => p.name), ['capture', 'export', 'library', 'config', 'pack', 'vault', 'restore'])
	assert.ok(r.results.every((p) => p.state === 'skipped' && p.reason), JSON.stringify(r.results))
})

test('one failing part never stops the others, and is named', async (t) => {
	box(t)
	const seen = []
	const parts = Object.fromEntries(['capture', 'export', 'library', 'config', 'pack', 'vault', 'restore'].map((name) => [name, async () => {
		seen.push(name)
		if (name === 'export') throw new Error('export went wrong')
		if (name === 'config') return { state: 'failed', reason: 'config went wrong' }
		return { state: 'done', counts: { files: 1 } }
	}]))
	const lines = []
	const r = await backupAll({ cfg: {}, parts, print: (l) => lines.push(l), now: () => NOW })
	assert.equal(seen.length, 7)
	assert.deepEqual(r.failed, ['export', 'config'])
	assert.match(lines.join('\n'), /export went wrong/)
	assert.match(lines.at(-1), /Failed: export, config/)
})

test('a part cannot print its own lines, and the scheduled log holds counts only', async (t) => {
	box(t)
	const parts = Object.fromEntries(['capture', 'export', 'library', 'config', 'pack', 'vault', 'restore'].map((name) => [name, async () => {
		console.log(`${PLAIN} from a part`)
		console.error(`${PLAIN} on stderr`)
		return name === 'library' ? { state: 'failed', reason: 'my-private-folder-name failed', counts: { added: 2 } } : { state: 'done' }
	}]))
	const lines = []
	const log = t.mock.method(console, 'log', () => {})
	const err = t.mock.method(console, 'error', () => {})
	const r = await backupAll({ cfg: {}, parts, print: (l) => lines.push(l), now: () => NOW, scheduled: true })
	assert.equal(log.mock.callCount(), 0)
	assert.equal(err.mock.callCount(), 0)
	const text = lines.join('\n')
	assert.ok(!text.includes(PLAIN))
	assert.ok(!text.includes('my-private-folder-name'))
	assert.match(text, /library +failed +added 2/)
	assert.deepEqual(r.failed, ['library'])
})

test('results stay in the status file: 0600, names, times and counts, and a secret in a reason is withheld', async (t) => {
	const b = box(t)
	const secret = `ghp_${'a1B2'.repeat(9)}`
	const parts = Object.fromEntries(['capture', 'export', 'library', 'config', 'pack', 'vault', 'restore'].map((name) => [name, async () => (name === 'vault' ? { state: 'failed', reason: `upload said ${secret}` } : { state: 'done', counts: { files: 3, words: 'not a number' } })]))
	await backupAll({ cfg: {}, parts, print: quiet, now: () => NOW })
	const raw = readFileSync(b.env.WP_BACKUP_STATUS, 'utf8')
	assert.ok(!raw.includes(secret))
	assert.equal(statSync(b.env.WP_BACKUP_STATUS).mode & 0o777, 0o600)
	const s = readBackupStatus()
	assert.equal(s.parts.capture.lastSuccessAt, NOW)
	assert.deepEqual(s.parts.capture.counts, { files: 3 })
	assert.equal(s.parts.vault.state, 'failed')
	assert.equal(s.parts.vault.lastSuccessAt, null)
	assert.ok(s.parts.vault.reason)
})

test('a second run is refused while one is running', async (t) => {
	const b = box(t)
	mkdirSync(join(b.root, 'memory', 'backup-all-run'), { recursive: true })
	writeFileSync(join(b.root, 'memory', 'backup-all-run', '.lock'), String(process.pid))
	await assert.rejects(run({}), /backup-all is already running/)
})

test('end to end, no vault: capture, export, library, config and pack; session text stays out of the Brain repository', (t) => {
	const b = box(t)
	const sb = brainSandbox({ config: { library: true, memory: true, capture_since: Date.now() - DAY } })
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	const home = sb.root
	const env = { ...b.env, CLAUDE_HOME: join(home, 'claude-home'), WP_LAUNCHCTL: join(home, 'no-launchctl') }
	mkdirSync(join(env.CLAUDE_HOME, 'skills', 'one'), { recursive: true })
	writeFileSync(join(env.CLAUDE_HOME, 'CLAUDE.md'), '# rules\n')
	writeFileSync(join(env.CLAUDE_HOME, 'skills', 'one', 'SKILL.md'), 'a skill\n')
	writeFileSync(join(env.CLAUDE_HOME, 'skills', 'one', 'token-helper.md'), 'left out by name\n')
	const s = transcript({ sessionId: SID, cwd: '/x/app' })
	writeSession(join(env.CLAUDE_HOME, 'projects', '-x-app', `${SID}.jsonl`), s.user(PLAIN), s.answer('an answer'), s.turnEnd())
	const folder = join(env.YT_LEARN_ROOT, '2026-10-01_a-talk_abc')
	mkdirSync(folder, { recursive: true })
	writeFileSync(join(folder, 'notes.md'), 'my notes\n')
	writeFileSync(join(folder, 'meta.json'), JSON.stringify({ source_type: 'youtube' }))
	mkdirSync(join(env.YT_LEARN_ROOT, '2026-10-02_other_def'))
	writeFileSync(join(env.YT_LEARN_ROOT, '2026-10-02_other_def', 'notes.md'), 'no meta here\n')

	const first = sb.runWith(env, 'backup-all')
	assert.equal(first.status, 0, first.out + first.err)
	assert.match(first.out, /capture +done/)
	assert.match(first.out, /export +done +.*written 1/)
	assert.match(first.out, /library +done +added 2/)
	assert.match(first.out, /config +done/)
	assert.match(first.out, /pack +done/)
	assert.match(first.out, /vault +skipped/)
	assert.match(first.out, /restore test +skipped/)
	assert.ok(!first.out.includes(PLAIN))

	const md = readdirSync(join(env.WP_SESSIONS_MD, 'app'))
	assert.equal(md.length, 1)
	assert.ok(readFileSync(join(env.WP_SESSIONS_MD, 'app', md[0]), 'utf8').includes(PLAIN))
	assert.ok(existsSync(env.WP_SESSIONS_PACK))

	const git = (...a) => execFileSync('git', ['-C', sb.clone, ...a], { encoding: 'utf8' })
	git('fetch', '-q', 'origin')
	const tracked = git('ls-tree', '-r', '--name-only', 'origin/main').split('\n')
	assert.ok(tracked.includes('bridge/library/youtube/2026-10-01_a-talk_abc/notes.md'), tracked.join('\n'))
	assert.ok(tracked.includes('bridge/library/manual/2026-10-02_other_def/notes.md'), 'no meta: kept as manual')
	assert.ok(tracked.some((p) => p.startsWith('bridge/config/')))
	assert.ok(!tracked.some((p) => /claude-sessions|session-files|memory\.db|^bridge\/.*sessions-md|\/md\//.test(p)), tracked.join('\n'))
	assert.ok(!git('log', '-p', 'origin/main').includes('zebra-marker'), 'session text never reaches the Brain repository')

	const rawStatus = readFileSync(env.WP_BACKUP_STATUS, 'utf8')
	assert.ok(!rawStatus.includes('zebra-marker'))

	// Nothing new: only what changed goes again. The vault's own case is tested below.
	const packBefore = statSync(env.WP_SESSIONS_PACK, { bigint: true }).mtimeNs
	const second = sb.runWith(env, 'backup-all')
	assert.equal(second.status, 0, second.out + second.err)
	assert.match(second.out, /library +done +added 0/)
	assert.match(second.out, /export +done +.*written 0/)
	assert.equal(statSync(env.WP_SESSIONS_PACK, { bigint: true }).mtimeNs, packBefore)
	writeFileSync(join(folder, 'notes.md'), 'my notes, changed\n')
	assert.match(sb.runWith(env, 'backup-all').out, /library +done +added 1/)

	const status = sb.runWith(env, 'backup', 'status')
	assert.equal(status.status, 0, status.err)
	assert.match(status.out, /Left out of config backup: 1 file/)
	assert.ok(!status.out.includes('zebra-marker'))
})

test('config backup says how many files it left out, in one line', (t) => {
	const sb = brainSandbox({ config: { library: true } })
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	const claude = join(sb.root, 'claude-home')
	mkdirSync(join(claude, 'skills', 'one'), { recursive: true })
	writeFileSync(join(claude, 'CLAUDE.md'), '# rules\n')
	writeFileSync(join(claude, 'skills', 'one', 'credentials.md'), 'by name\n')
	writeFileSync(join(claude, 'skills', 'one', 'SKILL.md'), 'kept\n')
	const r = sb.run('config', 'backup')
	assert.equal(r.status, 0, r.err)
	assert.equal(r.out.split('\n').filter((l) => /^Left out: 1 file/.test(l)).length, 1, r.out)
})

test('a folder holding a secret fails the library part, the other folders still go, and the exit code names it', (t) => {
	const b = box(t)
	const secret = `ghp_${'a1B2'.repeat(9)}`
	const sb = brainSandbox({ config: { library: true } })
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	const env = { ...b.env, CLAUDE_HOME: join(sb.root, 'claude-home') }
	mkdirSync(join(env.CLAUDE_HOME), { recursive: true })
	writeFileSync(join(env.CLAUDE_HOME, 'CLAUDE.md'), '# rules\n')
	for (const [name, text] of [['a-bad', `leak ${secret}\n`], ['b-good', 'fine\n']]) {
		mkdirSync(join(env.YT_LEARN_ROOT, name), { recursive: true })
		writeFileSync(join(env.YT_LEARN_ROOT, name, 'notes.md'), text)
	}
	const r = sb.runWith(env, 'backup-all')
	assert.equal(r.status, 1)
	assert.match(r.err + r.out, /Failed: library/)
	assert.match(r.out, /config +done/, 'the next part still ran')
	assert.ok(!(r.out + r.err + readFileSync(env.WP_BACKUP_STATUS, 'utf8')).includes(secret))
	execFileSync('git', ['-C', sb.clone, 'fetch', '-q', 'origin'])
	const tracked = execFileSync('git', ['-C', sb.clone, 'ls-tree', '-r', '--name-only', 'origin/main'], { encoding: 'utf8' })
	assert.match(tracked, /b-good\/notes\.md/)
	assert.doesNotMatch(tracked, /a-bad/)
})

test('a corrupt database fails capture and export; the rest still run and the command exits 1', (t) => {
	const b = box(t)
	const sb = brainSandbox({ config: { memory: true, capture_since: 1234 } })
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	mkdirSync(join(b.root, 'memory'), { recursive: true })
	writeFileSync(b.env.WP_MEMORY_DB, 'this is not a database, not at all, and it is long enough to be read')
	const r = sb.runWith({ ...b.env, CLAUDE_HOME: join(sb.root, 'claude-home') }, 'backup-all')
	assert.equal(r.status, 1)
	assert.match(r.out, /capture +failed/)
	assert.match(r.out, /export +failed/)
	assert.match(r.out, /vault +skipped/)
	assert.match(r.err + r.out, /Failed: capture, export/)
})

test('vault part: databases only, encrypted, and the Markdown comes back through restore and unpack', async (t) => {
	const b = box(t)
	const v = vaultBox(t, b, { memory: true, capture_since: 1234 }, { videos: [join(b.root, 'videos')] })
	mkdirSync(join(b.root, 'videos'))
	writeFileSync(join(b.root, 'videos', 'clip.mp4'), 'video bytes')
	seedDb(b.env)
	const r = await run(v.cfg, { vault: v.seams() })
	assert.deepEqual(r.failed, [], JSON.stringify(r.results))
	assert.equal(states(r).vault, 'done')
	assert.equal(r.results.find((p) => p.name === 'vault').counts.uploaded, 2)
	const assets = v.assets()
	assert.ok(assets.length >= 2)
	for (const a of assets) {
		assert.equal(readFileSync(a).subarray(0, 21).toString(), 'age-encryption.org/v1', 'encrypted, not merely compressed')
		assert.ok(!readFileSync(a).includes('zebra-marker'), 'nothing unencrypted went up')
	}
	assert.ok(!assets.some((a) => readFileSync(a).includes('video bytes')), 'videos stay out unless asked for')

	const ctx = { ...v.seams(), cfg: parseVaultConfig(v.cfg), log: quiet }
	const to = join(b.root, 'restored')
	await restore(ctx, { name: 'session-files.db', to })
	const out = join(b.root, 'unpacked')
	assert.equal(unpack(join(to, 'session-files.db'), out).files, 1)
	const [project] = readdirSync(out)
	const [file] = readdirSync(join(out, project))
	assert.ok(readFileSync(join(out, project, file), 'utf8').includes(PLAIN))
})

test('vault part: videos go only when asked for', async (t) => {
	const b = box(t)
	const v = vaultBox(t, b, {}, { videos: [join(b.root, 'videos')] })
	mkdirSync(join(b.root, 'videos'))
	writeFileSync(join(b.root, 'videos', 'clip.mp4'), 'video bytes')
	const r = await run(v.cfg, { vault: v.seams(), videos: true })
	assert.deepEqual(r.failed, [], JSON.stringify(r.results))
	assert.ok(v.assets().some((a) => readFileSync(a).includes('video bytes')))
})

test('vault part: a default path not there yet is skipped with a note; a path you listed still stops it', async (t) => {
	const b = box(t)
	seedDb(b.env)
	const v = vaultBox(t, b, { memory: true })
	const cfg = parseVaultConfig(v.cfg)
	assert.ok(cfg.databases.includes(b.env.WP_SESSIONS_PACK))
	const logged = []
	const ctx = { ...v.seams(), cfg, log: (l) => logged.push(l) }
	const got = await backup(ctx, { yes: true, databases: true })
	assert.deepEqual(got.uploaded.map((u) => u.name), ['memory.db'])
	assert.match(logged.join('\n'), /skipped session-files\.db: not there yet/)
	assert.deepEqual(got.skipped.map((s) => s.why), ['not there yet'])

	const listed = vaultBox(t, b, {}, { databases: [join(b.root, 'gone.db')] })
	const hand = { ...listed.seams(), cfg: parseVaultConfig(listed.cfg), log: quiet }
	await assert.rejects(backup(hand, { yes: true, databases: true }), /was not found/)

	const both = vaultBox(t, b, { memory: true }, { databases: [b.env.WP_SESSIONS_PACK] })
	const handToo = { ...both.seams(), cfg: parseVaultConfig(both.cfg), log: quiet }
	await assert.rejects(backup(handToo, { yes: true, databases: true }), /was not found/, 'listed by hand too: a missing one stops as it always did')
})

test('vault snapshot holds text still in the -wal file', async (t) => {
	const b = box(t)
	const v = vaultBox(t, b, { memory: true })
	const writer = openMemory(b.env.WP_MEMORY_DB)
	t.after(() => writer.close())
	writer.exec('PRAGMA wal_autocheckpoint = 0')
	writeBatch(writer, { session: { id: SID, cwd: '/x', repo: '/x', title: 'T', entrypoint: 'cli', startedAt: NOW, lastEventAt: NOW }, messages: [{ uuid: 'wal', block: 0, role: 'prompt', at: NOW, text: 'walrus-only-in-the-log' }] }, { mask })
	assert.ok(!readFileSync(b.env.WP_MEMORY_DB).includes('walrus-only-in-the-log'), 'still only in the log')
	assert.ok(readFileSync(`${b.env.WP_MEMORY_DB}-wal`).includes('walrus-only-in-the-log'))
	const ctx = { ...v.seams(), cfg: parseVaultConfig(v.cfg), log: quiet }
	await backup(ctx, { yes: true, databases: true })
	const to = join(b.root, 'restored')
	await restore(ctx, { name: 'memory.db', to })
	const db = new DatabaseSync(join(to, 'memory.db'), { readOnly: true })
	t.after(() => db.close())
	assert.equal(db.prepare('SELECT text FROM messages').get().text, 'walrus-only-in-the-log')
})

test('monthly restore test: runs when none has, counts rows, leaves no folder; not due for 30 days; due again after', async (t) => {
	const b = box(t)
	seedDb(b.env)
	const v = vaultBox(t, b, { memory: true, capture_since: 1234 })
	const first = await run(v.cfg, { vault: v.seams() })
	const part = first.results.find((p) => p.name === 'restore')
	assert.equal(part.state, 'done', part.reason)
	assert.deepEqual([part.counts.messages, part.counts.sessions], [1, 1])
	assert.deepEqual(readdirSync(v.staging).filter((n) => n.startsWith('restore')), [], 'the temp folder is gone')
	assert.equal(readBackupStatus().parts.restore.lastSuccessAt, NOW)

	const soon = await run(v.cfg, { vault: v.seams() }, NOW + 10 * DAY)
	const skipped = soon.results.find((p) => p.name === 'restore')
	assert.equal(skipped.state, 'skipped')
	assert.match(skipped.reason, /not due/)
	const kept = readBackupStatus().parts.restore
	assert.equal(kept.lastSuccessAt, NOW)
	assert.equal(kept.counts.messages, 1, 'the last result stays readable')

	const later = await run(v.cfg, { vault: v.seams() }, NOW + 31 * DAY)
	assert.equal(later.results.find((p) => p.name === 'restore').state, 'done')
	assert.equal(readBackupStatus().parts.restore.lastSuccessAt, NOW + 31 * DAY)
})

test('monthly restore test: a damaged snapshot fails the part, and status, doctor and the warning say so', async (t) => {
	const b = box(t)
	seedDb(b.env)
	const v = vaultBox(t, b, { memory: true, capture_since: 1234 })
	await run(v.cfg, { vault: { ...v.seams(), now: () => NOW } })
	const good = v.seams()
	const storage = { ...good.storage, getAsset: async (tag, name, dest) => {
		const file = await good.storage.getAsset(tag, name, dest)
		writeFileSync(file, 'damaged on the way back')
		return file
	} }
	const damaged = await run(v.cfg, { vault: { ...good, storage, now: () => NOW + 31 * DAY } }, NOW + 31 * DAY)
	assert.ok(damaged.failed.includes('restore'), JSON.stringify(damaged.results.at(-1)))
	assert.deepEqual(readdirSync(v.staging).filter((n) => n.startsWith('restore')), [], 'a failed test leaves no folder either')
	assert.match((await backupStatusLines(v.cfg, { now: NOW + 31 * DAY })).join('\n'), /restore test +failed/)
	assert.ok(staleParts(readBackupStatus(), NOW + 31 * DAY).includes('restore'), 'it warns at once, not after 3 days')
	assert.match(staleBackupLine({ now: NOW + 31 * DAY }), /restore test/)
	assert.ok((await backupRows({ now: NOW + 31 * DAY })).some((row) => row.what === 'Backup restore test' && !row.ok))
})

test('monthly restore test: skipped when the snapshot would take over 25% of free disk, when no vault, and when no item', async (t) => {
	const b = box(t)
	seedDb(b.env)
	const v = vaultBox(t, b, { memory: true, capture_since: 1234 })
	const noItem = vaultBox(t, b, {})
	const empty = await run(noItem.cfg, { vault: noItem.seams() })
	assert.match(empty.results.find((p) => p.name === 'restore').reason, /no memory\.db/)
	writeBackupStatus({})
	await run(v.cfg, { vault: v.seams() })
	writeBackupStatus({})
	const item = (await import('./vault.mjs')).list({ cfg: parseVaultConfig(v.cfg), clone: v.sb.clone }).find((i) => i.name === 'memory.db')
	const tight = await run(v.cfg, { vault: { ...v.seams(), freeBytes: () => item.size * 3 } })
	const part = tight.results.find((p) => p.name === 'restore')
	assert.equal(part.state, 'skipped')
	assert.match(part.reason, /25%/)
	assert.deepEqual(readdirSync(v.staging).filter((n) => n.startsWith('restore-test')), [], 'skipped before any folder was made')
})

test('owner\'s switches: claude-docs and project memory stay out until true, then go through a pack into the vault', async (t) => {
	const b = box(t)
	mkdirSync(b.env.WP_CLAUDE_DOCS)
	writeFileSync(join(b.env.WP_CLAUDE_DOCS, 'plan.md'), 'docs words')
	mkdirSync(join(b.env.CLAUDE_HOME, 'projects', '-x-app', 'memory'), { recursive: true })
	writeFileSync(join(b.env.CLAUDE_HOME, 'projects', '-x-app', 'memory', 'MEMORY.md'), 'memory words')

	const off = vaultBox(t, b)
	const none = await run(off.cfg, { vault: off.seams() })
	assert.equal(states(none).pack, 'skipped')
	assert.equal(parseVaultConfig(off.cfg).databases.length, 0)
	const lines = await backupStatusLines(off.cfg, { now: NOW })
	assert.equal(lines.filter((l) => /left out \(owner's choice\)/i.test(l)).length, 2, lines.join('\n'))

	const on = vaultBox(t, b, { backup: { claudeDocs: true, projectMemory: true } })
	const r = await run(on.cfg, { vault: on.seams() })
	assert.deepEqual(r.failed, [], JSON.stringify(r.results))
	assert.equal(r.results.find((p) => p.name === 'vault').counts.uploaded, 2)
	const ctx = { ...on.seams(), cfg: parseVaultConfig(on.cfg), log: quiet }
	const to = join(b.root, 'r')
	await restore(ctx, { name: 'claude-docs.db', to })
	await restore(ctx, { name: 'project-memory.db', to })
	unpack(join(to, 'claude-docs.db'), join(to, 'docs'))
	unpack(join(to, 'project-memory.db'), join(to, 'mem'))
	assert.equal(readFileSync(join(to, 'docs', 'plan.md'), 'utf8'), 'docs words')
	assert.equal(readFileSync(join(to, 'mem', '-x-app', 'memory', 'MEMORY.md'), 'utf8'), 'memory words')
	const after = await backupStatusLines(on.cfg, { now: NOW })
	assert.equal(after.filter((l) => /left out \(owner's choice\)/i.test(l)).length, 0, after.join('\n'))
})

test('backup status fits one screen, and says what is not backed up yet', async (t) => {
	const b = box(t)
	const cfg = { memory: true, capture_since: NOW - 30 * DAY, device: 'mac' }
	seedDb(b.env)
	await run(cfg, {}, NOW)
	// A session file changed after the last export, and a Markdown file after the last pack.
	const transcriptPath = join(b.env.CLAUDE_HOME, 'projects', '-x-app', `${SID}.jsonl`)
	writeSession(transcriptPath, transcript({ sessionId: SID }).user('x'.repeat(4000)))
	const later = new Date(NOW + DAY)
	utimesSync(transcriptPath, later, later)
	const [project] = readdirSync(b.env.WP_SESSIONS_MD)
	const [md] = readdirSync(join(b.env.WP_SESSIONS_MD, project))
	utimesSync(join(b.env.WP_SESSIONS_MD, project, md), later, later)
	const long = readBackupStatus()
	long.parts.vault = { state: 'failed', at: NOW, lastSuccessAt: null, firstTriedAt: NOW, reason: 'x'.repeat(400) }
	writeBackupStatus(long)
	const lines = await backupStatusLines(cfg, { now: NOW + 2 * DAY })
	const text = lines.join('\n')
	assert.ok(lines.length < 24, text)
	assert.ok(lines.every((l) => [...l].length <= 80), text)
	assert.match(text, /Not exported: 1 session file/)
	assert.match(text, /Not packed: 1 file/)
	assert.match(text, /Not in the vault|vault/i)
	assert.match(text, /vault +failed/)
	assert.ok(!text.includes('zebra-marker'))
	assert.ok(!text.includes('xxxxx'.repeat(40)))
	for (const part of ['capture', 'export', 'library', 'config', 'pack', 'vault', 'restore test']) assert.match(text, new RegExp(`^${part}`, 'm'))
})

test('backup status before any run says so', async (t) => {
	box(t)
	const lines = await backupStatusLines({}, { now: NOW })
	assert.match(lines.join('\n'), /never/)
	assert.deepEqual((await backupRows({ now: NOW })).map((r) => [r.what, r.ok]).slice(0, 1), [['Backup', true]])
})

/** A temp HOME, as Desktop & Documents sync is judged by where the folder sits under it. */
function homeIn(t, root) {
	const saved = process.env.HOME
	process.env.HOME = root
	t.after(() => { process.env.HOME = saved })
}

const MOBILE = (root) => join(root, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'claude-sessions')

test('iCloud: a folder under Mobile Documents always warns; Desktop & Documents sync only for a folder it carries', async (t) => {
	const b = box(t)
	homeIn(t, b.root)
	const cfg = { memory: true }
	assert.equal(icloudWarning(), null)
	process.env.WP_ICLOUD_DESKTOP = '1'
	assert.equal(icloudWarning(), null, 'WP_SESSIONS_MD elsewhere is the way out the owner was told about')
	process.env.WP_SESSIONS_MD = join(b.root, 'Documents', 'claude-sessions')
	assert.match(icloudWarning(), /plain session text would leave this machine/i)
	assert.match((await backupStatusLines(cfg, { now: NOW })).join('\n'), /iCloud: .*leave this machine/)
	assert.ok((await backupRows({ cfg, now: NOW })).some((r) => r.what === 'Backup iCloud' && !r.ok))
	process.env.WP_SESSIONS_MD = join(b.root, 'Desktop', 'sessions')
	assert.match(icloudWarning(), /leave this machine/)
	process.env.WP_ICLOUD_DESKTOP = '0'
	process.env.WP_SESSIONS_MD = MOBILE(b.root)
	assert.match(icloudWarning(), /leave this machine/, 'a folder not made yet is judged by where it would be')
	process.env.WP_SESSIONS_MD = join(b.root, 'library', 'MOBILE DOCUMENTS', 'x')
	assert.match(icloudWarning(), /leave this machine/, 'the Mac ignores case, so a wrong-case path still syncs')
	process.env.WP_ICLOUD_DESKTOP = '1'
	process.env.WP_SESSIONS_MD = join(b.root, 'DOCUMENTS', 'sessions')
	assert.match(icloudWarning(), /leave this machine/, 'wrong-case Documents is still Documents')
	process.env.WP_ICLOUD_DESKTOP = 'nonsense'
	process.env.WP_SESSIONS_MD = b.env.WP_SESSIONS_MD
	assert.equal(icloudWarning(), null)
})

test('iCloud: export as a part refuses, fails with the reason, writes nothing, and session start says so at once; the switch lets it through', async (t) => {
	const b = box(t)
	seedDb(b.env)
	process.env.WP_SESSIONS_MD = MOBILE(b.root)
	const cfg = { memory: true, capture_since: NOW - 30 * DAY }
	const out = []
	const r = await run(cfg, {}, NOW, { print: (l) => out.push(l) })
	assert.equal(states(r).export, 'failed')
	const row = r.results.find((p) => p.name === 'export')
	assert.match(row.reason, /leave this machine/)
	assert.match(row.reason, /allowICloud/)
	assert.match(row.reason, /WP_SESSIONS_MD/, 'both ways out are in the 200 characters a reason keeps')
	assert.equal(existsSync(MOBILE(b.root)), false, 'no plain text written')
	assert.ok(out.some((l) => /^export +failed .*leave this machine/.test(l)), out.join('\n'))
	assert.equal(states(r).capture, 'done', 'the rest still run')
	assert.equal(readBackupStatus().parts.export.icloud, true)

	const line = staleBackupLine({ now: NOW })
	assert.match(line, /^WARNING: session files are not being written/)
	assert.match(line, /iCloud/)
	assert.equal(line.split('\n').length, 1)
	assert.ok(tokensOf(line) <= 60, String(tokensOf(line)))

	const scheduled = []
	await run(cfg, {}, NOW, { print: (l) => scheduled.push(l), scheduled: true })
	assert.ok(scheduled.some((l) => /^export +failed$/.test(l)), scheduled.join('\n'))

	const allowed = { ...cfg, backup: { allowICloud: true } }
	const through = await run(allowed, {}, NOW + 1000)
	assert.equal(states(through).export, 'done', JSON.stringify(through.results))
	assert.equal(readdirSync(MOBILE(b.root), { recursive: true }).some((f) => String(f).endsWith('.md')), true)
	assert.equal(readBackupStatus().parts.export.icloud, undefined)
	assert.equal(staleBackupLine({ now: NOW + 1000 }), null)
	const lines = (await backupStatusLines(allowed, { now: NOW + 1000 })).join('\n')
	assert.match(lines, /iCloud: allowed by backup\.allowICloud/)
	assert.ok((await backupRows({ cfg: allowed, now: NOW + 1000 })).some((row2) => row2.what === 'Backup iCloud' && row2.ok && /allowICloud/.test(row2.detail)))
})

test('iCloud: another part stopping as well still gives one line, naming both', (t) => {
	const b = box(t)
	mkdirSync(join(b.root, 'memory'), { recursive: true })
	const old = { state: 'failed', at: NOW, lastSuccessAt: NOW - 9 * DAY, firstTriedAt: NOW - 90 * DAY }
	writeBackupStatus({ lastRunAt: NOW, parts: { export: { state: 'failed', at: NOW, icloud: true, lastSuccessAt: null, firstTriedAt: NOW }, vault: old } })
	const line = staleBackupLine({ now: NOW })
	assert.equal(line.split('\n').length, 1)
	assert.match(line, /export \(iCloud\), vault/)
	assert.ok(tokensOf(line) <= 60, String(tokensOf(line)))
})

test('iCloud: `memory export` refuses with the override stated; the switch lets it through', (t) => {
	const b = box(t)
	seedDb(b.env)
	const synced = MOBILE(b.root)
	const sb = brainSandbox({ config: { memory: true } })
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	const refused = sb.runWith({ ...b.env, WP_SESSIONS_MD: synced }, 'memory', 'export')
	assert.equal(refused.status, 1)
	assert.match(refused.err, /leave this machine/)
	assert.match(refused.err, /allowICloud/)
	assert.equal(existsSync(synced), false)
	const allowed = brainSandbox({ config: { memory: true, backup: { allowICloud: true } } })
	t.after(() => rmSync(allowed.root, { recursive: true, force: true }))
	const r = allowed.runWith({ ...b.env, WP_SESSIONS_MD: synced }, 'memory', 'export')
	assert.equal(r.status, 0, r.err)
	assert.ok(existsSync(synced))
})

test('someone who never turned memory on and has no Markdown folder hears nothing of iCloud or of a choice they do not have', async (t) => {
	const b = box(t)
	homeIn(t, b.root)
	process.env.WP_ICLOUD_DESKTOP = '1'
	process.env.WP_SESSIONS_MD = join(b.root, 'Documents', 'claude-sessions')
	for (const cfg of [{}, { memory: false }]) {
		const lines = (await backupStatusLines(cfg, { now: NOW })).join('\n')
		assert.doesNotMatch(lines, /iCloud/)
		assert.doesNotMatch(lines, /owner's choice/)
		assert.ok(!(await backupRows({ cfg, now: NOW })).some((r) => r.what === 'Backup iCloud'))
		const out = []
		await run(cfg, {}, NOW, { print: (l) => out.push(l) })
		assert.ok(!out.some((l) => /iCloud|leave this machine/.test(l)), out.join('\n'))
	}
	assert.ok(!(await backupRows({ now: NOW })).some((r) => r.what === 'Backup iCloud'), 'no config at all')
	mkdirSync(process.env.WP_SESSIONS_MD, { recursive: true })
	assert.ok((await backupRows({ cfg: {}, now: NOW })).some((r) => r.what === 'Backup iCloud' && !r.ok), 'a folder that exists holds what would sync')
})

test('stale parts: 3 days without a success; a part turned off or never tried is quiet', (t) => {
	box(t)
	const part = (over) => ({ state: 'done', at: NOW, lastSuccessAt: NOW, firstTriedAt: NOW - 90 * DAY, ...over })
	const at = (parts, extra = {}) => staleParts({ lastRunAt: NOW, parts, ...extra }, NOW)
	assert.deepEqual(at({ capture: part() }), [])
	assert.deepEqual(at({ capture: part({ lastSuccessAt: NOW - 2 * DAY }) }), [])
	assert.deepEqual(at({ capture: part({ lastSuccessAt: NOW - 4 * DAY }) }), ['capture'])
	assert.deepEqual(at({ vault: part({ state: 'failed', lastSuccessAt: null, firstTriedAt: NOW - 4 * DAY }) }), ['vault'])
	assert.deepEqual(at({ vault: part({ state: 'failed', lastSuccessAt: null, firstTriedAt: NOW - DAY }) }), [])
	assert.deepEqual(at({ vault: part({ state: 'skipped', lastSuccessAt: NOW - 40 * DAY }) }), [])
	assert.deepEqual(at({ restore: part({ state: 'skipped', lastSuccessAt: NOW - 40 * DAY }) }), [], 'a test not run for lack of disk is not a failure')
	assert.deepEqual(at({ restore: part({ state: 'failed', lastSuccessAt: NOW - DAY }) }), ['restore'])
	assert.deepEqual(at({ made_up: part({ lastSuccessAt: 1 }) }), [], 'only known names, so a damaged file cannot put words in the line')
})

test('init and setup keep the owner\'s backup switches', (t) => {
	const sb = brainSandbox({ config: { backup: { claudeDocs: true, projectMemory: true, allowICloud: true } } })
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	const r = sb.run('init', 'test/brain', '--no-push', '--clone', sb.clone, '--device', 'cli-test')
	assert.equal(r.status, 0, r.err)
	assert.deepEqual(JSON.parse(readFileSync(sb.configPath, 'utf8')).backup, { claudeDocs: true, projectMemory: true, allowICloud: true })
})

const vaultRow = (r) => r.results.find((p) => p.name === 'vault')

test('vault part: nothing uploaded is skipped, names what was skipped, and is no success', async (t) => {
	const b = box(t)
	const v = vaultBox(t, b, { memory: true })
	const r = await run(v.cfg, { vault: v.seams() })
	const part = vaultRow(r)
	assert.equal(part.state, 'skipped', JSON.stringify(part))
	assert.match(part.reason, /memory\.db/)
	assert.match(part.reason, /session-files\.db/)
	assert.equal(part.counts.uploaded, 0)
	assert.equal(readBackupStatus().parts.vault.lastSuccessAt, null)
	assert.deepEqual(r.failed, [])
})

test('vault part: memory.db as a link, or gone after a capture, fails even when the pack went up', async (t) => {
	const b = box(t)
	const real = join(b.root, 'real.db')
	const saved = b.env.WP_MEMORY_DB
	process.env.WP_MEMORY_DB = real
	seedDb({ WP_MEMORY_DB: real })
	process.env.WP_MEMORY_DB = saved
	mkdirSync(join(b.root, 'memory'), { recursive: true })
	symlinkSync(real, saved)
	const v = vaultBox(t, b, { memory: true })
	const linked = await run(v.cfg, { vault: v.seams() })
	assert.ok(linked.failed.includes('vault'), JSON.stringify(vaultRow(linked)))
	assert.match(vaultRow(linked).reason, /memory\.db.*symlink/)
	assert.equal(vaultRow(linked).counts.uploaded, 1, 'the pack still went')

	rmSync(saved)
	writeFileSync(join(b.root, 'memory', 'status.json'), JSON.stringify({ lastWriteAt: NOW }))
	writeBackupStatus({})
	const gone = await run(v.cfg, { vault: v.seams() }, NOW + DAY)
	assert.ok(gone.failed.includes('vault'), JSON.stringify(vaultRow(gone)))
	assert.match(vaultRow(gone).reason, /memory\.db.*not there yet/)
})

test('vault part: unchanged databases stay put and are counted; a change in the file or its -wal goes up; by hand it always goes', async (t) => {
	const b = box(t)
	const v = vaultBox(t, b, { memory: true, capture_since: NOW - 30 * DAY })
	seedDb(b.env)
	const s = transcript({ sessionId: SID, cwd: '/x/app' })
	writeSession(join(b.env.CLAUDE_HOME, 'projects', '-x-app', `${SID}.jsonl`), s.user('a prompt'), s.answer('an answer'), s.turnEnd())
	const first = await run(v.cfg, { vault: v.seams() })
	assert.equal(vaultRow(first).counts.uploaded, 2, JSON.stringify(vaultRow(first)))
	const count = () => v.assets().length
	const assets = count()
	const raw = readFileSync(b.env.WP_BACKUP_STATUS, 'utf8')
	assert.ok(!raw.includes('zebra-marker'))

	const idle = await run(v.cfg, { vault: v.seams() }, NOW + DAY)
	assert.deepEqual(idle.failed, [])
	assert.equal(vaultRow(idle).state, 'skipped', JSON.stringify(vaultRow(idle)))
	assert.match(vaultRow(idle).reason, /2 unchanged/)
	assert.deepEqual([vaultRow(idle).counts.uploaded, vaultRow(idle).counts.unchanged], [0, 2])
	assert.equal(count(), assets, 'nothing went up')
	assert.equal(readBackupStatus().parts.vault.lastSuccessAt, NOW)

	const writer = openMemory(b.env.WP_MEMORY_DB)
	writer.exec('PRAGMA wal_autocheckpoint = 0')
	writeBatch(writer, { session: { id: SID }, messages: [{ uuid: 'later', block: 0, role: 'note', at: NOW, text: 'only in the log' }] }, { mask })
	const changed = await run(v.cfg, { vault: v.seams() }, NOW + 2 * DAY)
	assert.equal(vaultRow(changed).state, 'done', JSON.stringify(vaultRow(changed)))
	assert.ok(vaultRow(changed).counts.uploaded >= 1)
	assert.ok(count() > assets)
	writer.close()

	await run(v.cfg, { vault: v.seams() }, NOW + 3 * DAY)
	const settled = count()
	const idleAgain = await run(v.cfg, { vault: v.seams() }, NOW + 4 * DAY)
	assert.equal(vaultRow(idleAgain).counts.uploaded, 0, JSON.stringify(vaultRow(idleAgain)))
	assert.equal(count(), settled)

	const hand = { ...v.seams(), cfg: parseVaultConfig(v.cfg), log: quiet, now: () => NOW + 5 * DAY }
	assert.equal((await backup(hand, { yes: true, databases: true })).uploaded.length, 2, 'vault backup by hand stays as it is')
})

test('vault part: a recorded item no longer in the manifest goes up again', async (t) => {
	const b = box(t)
	const v = vaultBox(t, b, { memory: true, capture_since: NOW - 30 * DAY })
	seedDb(b.env)
	await run(v.cfg, { vault: v.seams() })
	const s = readBackupStatus()
	for (const k of Object.keys(s.vaultSources)) s.vaultSources[k].id = 'i-gone'
	writeBackupStatus(s)
	assert.equal(vaultRow(await run(v.cfg, { vault: v.seams() }, NOW + DAY)).counts.uploaded, 2)
})

test('vault part: a resumed snapshot is not stamped as the live file, so the newer text goes up on the next run', async (t) => {
	const b = box(t)
	const v = vaultBox(t, b, { memory: true, capture_since: NOW - 30 * DAY })
	seedDb(b.env)
	const failing = await run(v.cfg, { vault: v.seams({ failPuts: 99 }) })
	assert.equal(vaultRow(failing).state, 'failed', JSON.stringify(vaultRow(failing)))

	const writer = openMemory(b.env.WP_MEMORY_DB)
	writeBatch(writer, { session: { id: SID }, messages: [{ uuid: 'later', block: 0, role: 'prompt', at: NOW, text: 'giraffe-newer-words' }] }, { mask })
	writer.close()

	const resumed = await run(v.cfg, { vault: v.seams() }, NOW + DAY)
	assert.equal(vaultRow(resumed).state, 'done', JSON.stringify(vaultRow(resumed)))
	assert.equal(readBackupStatus().vaultSources?.[b.env.WP_MEMORY_DB], undefined, 'the old snapshot says nothing about the live file')

	const next = await run(v.cfg, { vault: v.seams() }, NOW + 2 * DAY)
	assert.equal(vaultRow(next).state, 'done', JSON.stringify(vaultRow(next)))
	const { id } = readBackupStatus().vaultSources[b.env.WP_MEMORY_DB]
	const to = join(b.root, 'back')
	await restore({ ...v.seams(), cfg: parseVaultConfig(v.cfg), log: quiet }, { id, to })
	const back = new DatabaseSync(join(to, 'memory.db'), { readOnly: true })
	t.after(() => back.close())
	assert.equal(back.prepare("SELECT count(*) AS n FROM messages WHERE text LIKE '%giraffe-newer-words%'").get().n, 1, 'the vault holds the newer text')

	const idle = await run(v.cfg, { vault: v.seams() }, NOW + 3 * DAY)
	assert.equal(vaultRow(idle).state, 'skipped', 'and then it settles')
})

test('vault part: a failed upload leaves the stored marks as they were', async (t) => {
	const b = box(t)
	const v = vaultBox(t, b, { memory: true, capture_since: NOW - 30 * DAY })
	seedDb(b.env)
	await run(v.cfg, { vault: v.seams() })
	const before = readBackupStatus().vaultSources
	assert.ok(before[b.env.WP_MEMORY_DB], 'stamped after a good run')
	const writer = openMemory(b.env.WP_MEMORY_DB)
	writeBatch(writer, { session: { id: SID }, messages: [{ uuid: 'later', block: 0, role: 'prompt', at: NOW, text: 'words' }] }, { mask })
	writer.close()
	const failing = await run(v.cfg, { vault: v.seams({ failPuts: 99 }) }, NOW + DAY)
	assert.equal(vaultRow(failing).state, 'failed', JSON.stringify(vaultRow(failing)))
	assert.deepEqual(readBackupStatus().vaultSources, before)
})

test('vault part: uploads are matched to paths by path, so a skipped database of the same name takes no stamp', async (t) => {
	const b = box(t)
	for (const d of ['one', 'two']) mkdirSync(join(b.root, d))
	const real = join(b.root, 'two', 'same.db')
	const db = new DatabaseSync(real)
	db.exec('CREATE TABLE t (a)')
	db.close()
	const linked = join(b.root, 'one', 'same.db')
	symlinkSync(real, linked)
	const v = vaultBox(t, b, {}, { databases: [linked, real] })
	const r = await run(v.cfg, { vault: v.seams() })
	assert.equal(vaultRow(r).counts.uploaded, 1, JSON.stringify(vaultRow(r)))
	const sources = readBackupStatus().vaultSources
	assert.deepEqual(Object.keys(sources), [real])
	assert.equal(vaultRow(await run(v.cfg, { vault: v.seams() }, NOW + DAY)).counts.uploaded, 0, 'the real one stays put')
})

test('restore test: a failure keeps warning through a later skip, and a due test skipped over 30 days warns', async (t) => {
	box(t)
	const parts = (restore) => Object.fromEntries(['capture', 'export', 'library', 'config', 'pack', 'vault', 'restore'].map((name) => [name, async () => (name === 'restore' ? restore : { state: 'skipped', reason: 'off' })]))
	const go = (restore, now) => backupAll({ cfg: {}, parts: parts(restore), print: quiet, now: () => now })
	await go({ state: 'failed', reason: 'damaged' }, NOW)
	await go({ state: 'skipped', reason: 'over 25%', due: true }, NOW + DAY)
	assert.deepEqual(staleParts(readBackupStatus(), NOW + DAY), ['restore'], 'the last real attempt failed')
	await go({ state: 'done', counts: { messages: 1 } }, NOW + 2 * DAY)
	assert.deepEqual(staleParts(readBackupStatus(), NOW + 2 * DAY), [])
	await go({ state: 'skipped', reason: 'over 25%', due: true }, NOW + 40 * DAY)
	await go({ state: 'skipped', reason: 'over 25%', due: true }, NOW + 60 * DAY)
	assert.deepEqual(staleParts(readBackupStatus(), NOW + 60 * DAY), [])
	assert.deepEqual(staleParts(readBackupStatus(), NOW + 71 * DAY), ['restore'], 'skipped while due for over 30 days')
	await go({ state: 'skipped', reason: 'no vault set up' }, NOW + 72 * DAY)
	assert.deepEqual(staleParts(readBackupStatus(), NOW + 72 * DAY), [], 'turned off is quiet')
})

test('a real restore test skipped for disk is marked due, one not due is not', async (t) => {
	const b = box(t)
	seedDb(b.env)
	const v = vaultBox(t, b, { memory: true, capture_since: 1234 })
	await run(v.cfg, { vault: { ...v.seams(), freeBytes: () => 1e12 } })
	assert.equal(readBackupStatus().parts.restore.dueSkippedSince, undefined)
	writeBackupStatus({ ...readBackupStatus(), parts: { ...readBackupStatus().parts, restore: {} } })
	await run(v.cfg, { vault: { ...v.seams(), freeBytes: () => 1 } }, NOW + DAY)
	assert.equal(readBackupStatus().parts.restore.state, 'skipped')
	assert.equal(readBackupStatus().parts.restore.dueSkippedSince, NOW + DAY)
})

test('only a held lock reads as already running; any other error says what it is', async (t) => {
	const b = box(t)
	writeFileSync(join(b.root, 'a-file'), '')
	process.env.WP_BACKUP_STATUS = join(b.root, 'a-file', 'backup-status.json')
	await assert.rejects(run({}), (e) => !/already running/.test(e.message) && /ENOTDIR/.test(`${e.code} ${e.message}`))
})

test('pack part: an unreadable file fails the part and is counted, and tooBig shows in backup status', async (t) => {
	const b = box(t)
	mkdirSync(join(b.env.WP_SESSIONS_MD, 'app'), { recursive: true })
	writeFileSync(join(b.env.WP_SESSIONS_MD, 'app', 'ok.md'), 'fine')
	const locked = join(b.env.WP_SESSIONS_MD, 'app', 'locked.md')
	writeFileSync(locked, 'no reading')
	chmodSync(locked, 0o000)
	const cfg = { memory: true }
	const pack = (await run(cfg)).results.find((p) => p.name === 'pack')
	assert.equal(pack.state, 'failed', JSON.stringify(pack))
	assert.equal(pack.counts.unreadable, 1)
	chmodSync(locked, 0o600)
	const s = readBackupStatus()
	s.parts.pack.counts.tooBig = 2
	writeBackupStatus(s)
	assert.match((await backupStatusLines(cfg, { now: NOW })).join('\n'), /Left out of packs: 2 files over 32 MiB/)
})

test('export refuses a Markdown folder inside the Brain clone, as a part and as a command', async (t) => {
	const b = box(t)
	const sb = brainSandbox({ config: { memory: true } })
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	seedDb(b.env)
	const inside = join(sb.clone, 'bridge', 'sessions-md')
	const command = sb.runWith({ ...b.env, WP_SESSIONS_MD: inside }, 'memory', 'export')
	assert.equal(command.status, 1)
	assert.match(command.err, /inside the Brain/)
	assert.equal(existsSync(inside), false)
	const all = sb.runWith({ ...b.env, WP_SESSIONS_MD: inside, CLAUDE_HOME: join(sb.root, 'claude-home') }, 'backup-all')
	assert.equal(all.status, 1)
	assert.match(all.out, /export +failed/)
	assert.equal(existsSync(inside), false)
})

test('memory on with nothing captured yet: export is skipped, not failed', async (t) => {
	box(t)
	const r = await run({ memory: true })
	assert.equal(states(r).export, 'skipped')
	assert.deepEqual(r.failed, [])
})

test('the warning line: silent when nothing ever ran, one short line when stale, and it never writes', (t) => {
	const b = box(t)
	assert.equal(staleBackupLine({ now: NOW }), null)
	assert.equal(existsSync(b.env.WP_BACKUP_STATUS), false)
	mkdirSync(join(b.root, 'memory'), { recursive: true })
	const parts = Object.fromEntries(['capture', 'export', 'library', 'config', 'pack', 'vault', 'restore'].map((name) => [name, { state: 'failed', at: NOW, lastSuccessAt: NOW - 9 * DAY, firstTriedAt: NOW - 90 * DAY }]))
	writeBackupStatus({ lastRunAt: NOW, parts })
	const line = staleBackupLine({ now: NOW })
	assert.equal(line.split('\n').length, 1)
	assert.ok(tokensOf(line) <= 60, String(tokensOf(line)))
	assert.match(line, /^WARNING: .*capture.*restore test.*wp-brain backup status/)
	writeFileSync(b.env.WP_BACKUP_STATUS, 'not json')
	assert.match(staleBackupLine({ now: NOW }), /could not be read/)
})
