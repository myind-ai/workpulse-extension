// node --test cli/library.test.mjs
// Runs the real CLI against a temp bare repository and a temp config. Never touches the real Brain.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { brainSandbox } from './sandbox.mjs'

test('an entry records where it came from, and search finds it by source', () => {
	const { run } = brainSandbox()
	const added = run('add', 'learning', 'Reels teach idempotency keys', '--source-type', 'instagram', '--source-url', 'https://www.instagram.com/reel/a/', '--source-by', 'someone', '--no-push')
	assert.equal(added.status, 0, added.err)
	assert.match(added.out, /instagram/)
	run('add', 'learning', 'A plain lesson about retries', '--no-push')
	const found = run('search', 'source:instagram')
	assert.equal(found.status, 0, found.err)
	assert.match(found.out, /Reels teach idempotency keys/)
	assert.doesNotMatch(found.out, /plain lesson/)
})

test('an unknown --source-type is refused and the allowed ones are listed', () => {
	const { run } = brainSandbox()
	const r = run('add', 'learning', 'x', '--source-type', 'podcast', '--no-push')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /youtube, instagram, site, workpulse, session, manual/)
})

test('edit can set the source as an object', () => {
	const { run } = brainSandbox()
	run('add', 'learning', 'Edit me later', '--no-push')
	const id = run('list').out.match(/\[(\w+)\]/)[1]
	const r = run('edit', id, '--source-type', 'site', '--source-url', 'https://example.com/post', '--no-push')
	assert.equal(r.status, 0, r.err)
	assert.match(run('search', 'source:site').out, /Edit me later/)
})

test('list --source keeps one source type, and --source none the rest', () => {
	const { run } = brainSandbox()
	run('add', 'learning', 'A video lesson', '--source-type', 'youtube', '--source-url', 'https://youtu.be/abc', '--no-push')
	run('add', 'learning', 'A plain lesson', '--no-push')
	const yt = run('list', '--source', 'youtube')
	assert.equal(yt.status, 0, yt.err)
	assert.match(yt.out, /A video lesson/)
	assert.doesNotMatch(yt.out, /A plain lesson/)
	const none = run('list', '--source', 'none')
	assert.match(none.out, /A plain lesson/)
	assert.doesNotMatch(none.out, /A video lesson/)
})

// ── library ────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { configFiles, fileSecretsIn, pickFiles } from './library.mjs'
const bridgeTs = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'src', 'core', 'bridge.ts'))

function learnedFolder(root, name, files) {
	const dir = join(root, name)
	mkdirSync(dir, { recursive: true })
	for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), content)
	return dir
}

test('pickFiles keeps the six text files and says why it skipped the rest', () => {
	const { root } = brainSandbox()
	const dir = learnedFolder(root, 'f', { 'notes.md': 'n', 'transcript.md': 't', 'transcript.txt': 't', 'article.md': 'a', 'description.md': 'd', 'meta.json': '{}', 'video.mp4': 'x' })
	writeFileSync(join(dir, 'big.md'), '')
	writeFileSync(join(dir, 'transcript.md'), Buffer.alloc(3 * 1024 * 1024, 97))
	const { keep, skipped } = pickFiles(dir)
	assert.deepEqual(keep, ['article.md', 'description.md', 'meta.json', 'notes.md', 'transcript.txt'])
	assert.deepEqual(skipped.filter((s) => s.name !== 'big.md'), [{ name: 'transcript.md', why: 'over 2 MB' }, { name: 'video.mp4', why: 'not allowed' }])
	assert.deepEqual(skipped.find((s) => s.name === 'big.md'), { name: 'big.md', why: 'not allowed' })
})

test('pickFiles skips a symlink, even one named like an allowed file', () => {
	const { root } = brainSandbox()
	const outside = join(root, 'outside.txt')
	writeFileSync(outside, 'private')
	const dir = learnedFolder(root, 'f', { 'meta.json': '{}' })
	symlinkSync(outside, join(dir, 'notes.md'))
	const { keep, skipped } = pickFiles(dir)
	assert.deepEqual(keep, ['meta.json'])
	assert.deepEqual(skipped, [{ name: 'notes.md', why: 'symlink' }])
})

test('restore --force does not write through a symlink in the root', () => {
	const { run, root } = brainSandbox({ config: { library: true } })
	const dir = learnedFolder(root, 'vid1', { 'notes.md': 'from backup' })
	assert.equal(run('library', 'add', dir, '--type', 'site').status, 0)
	const target = join(root, 'restored')
	mkdirSync(join(target, 'vid1'), { recursive: true })
	const outside = join(root, 'outside.txt')
	writeFileSync(outside, 'untouched')
	symlinkSync(outside, join(target, 'vid1', 'notes.md'))
	const r = run('library', 'restore', '--root', target, '--force')
	assert.equal(r.status, 0, r.err)
	assert.equal(readFileSync(outside, 'utf8'), 'untouched')
})

test('library add is refused while "library" is not true in the config', () => {
	const { run, root, remote, git } = brainSandbox()
	const dir = learnedFolder(root, 'vid', { 'notes.md': 'hello' })
	const before = git('-C', remote, 'rev-parse', 'main')
	const r = run('library', 'add', dir, '--type', 'instagram')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /"library": true/)
	assert.equal(git('-C', remote, 'rev-parse', 'main'), before)
})

test('library add, ownership, secrets, restore and the extension listing', () => {
	const { run, root, remote, clone, configPath, git } = brainSandbox({ config: { library: true } })
	const dir = learnedFolder(root, 'vid1', { 'notes.md': 'hello', 'meta.json': '{}', 'video.mp4': 'binary' })
	const added = run('library', 'add', dir, '--type', 'instagram')
	assert.equal(added.status, 0, added.err)
	assert.match(added.out, /library: bridge\/library\/instagram\/vid1/)
	assert.match(added.out, /skipped video\.mp4: not allowed/)
	const onRemote = git('-C', remote, 'ls-tree', '-r', '--name-only', 'main').split('\n')
	assert.ok(onRemote.includes('bridge/library/instagram/vid1/notes.md'))
	assert.ok(onRemote.includes('bridge/library/instagram/vid1/meta.json'))
	assert.ok(!onRemote.some((p) => p.endsWith('video.mp4')))
	assert.equal(readFileSync(join(clone, 'bridge/library/instagram/vid1/.owner'), 'utf8').trim(), 'cli-test')

	// the extension's change listing ignores the library
	const tree = onRemote.map((path) => ({ path, sha: 'x' }))
	assert.deepEqual(bridgeTs.changedFiles({}, tree).fetch.filter((p) => p.includes('library')), [])

	// a second device does not take over the folder
	writeFileSync(join(clone, 'bridge/library/instagram/vid1/.owner'), 'other-device\n')
	git('-C', clone, 'commit', '-q', '-am', 'owner')
	git('-C', clone, 'push', '-q', 'origin', 'HEAD')
	writeFileSync(join(dir, 'notes.md'), 'changed')
	const second = run('library', 'add', dir, '--type', 'instagram')
	assert.notEqual(second.status, 0)
	assert.match(second.err, /other-device/)
	assert.equal(git('-C', clone, 'show', 'HEAD:bridge/library/instagram/vid1/notes.md'), 'hello')

	// a secret stops the whole operation, naming the file and not the value
	const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2'
	const bad = learnedFolder(root, 'vid2', { 'notes.md': `key ${token}`, 'meta.json': '{}' })
	const head = git('-C', remote, 'rev-parse', 'main')
	const leak = run('library', 'add', bad, '--type', 'site')
	assert.notEqual(leak.status, 0)
	assert.match(leak.err, /notes\.md/)
	assert.ok(!(leak.err + leak.out).includes(token))
	assert.equal(git('-C', remote, 'rev-parse', 'main'), head)
	assert.ok(!existsSync(join(clone, 'bridge/library/site/vid2')))
	assert.equal(git('-C', clone, 'status', '--porcelain'), '')
	assert.notEqual(run('library', 'add', '/', '--type', 'site').status, 0)

	// restore into an empty root; an existing file is kept without --force
	const target = join(root, 'restored')
	const restored = run('library', 'restore', '--root', target)
	assert.equal(restored.status, 0, restored.err)
	assert.equal(readFileSync(join(target, 'vid1', 'notes.md'), 'utf8'), 'hello')
	assert.ok(!existsSync(join(target, 'vid1', '.owner')))
	writeFileSync(join(target, 'vid1', 'notes.md'), 'mine')
	const again = run('library', 'restore', '--root', target)
	assert.match(again.out, /kept \(already there\): vid1\/notes\.md/)
	assert.equal(readFileSync(join(target, 'vid1', 'notes.md'), 'utf8'), 'mine')
	assert.match(run('library', 'list').out, /instagram\/vid1/)
})

// ── backfill, config backup and restore ────────────────────────────────────

const lastLine = (path) => JSON.parse(readFileSync(path, 'utf8').trim().split('\n').pop())

test('backfill-source writes nothing without --yes, sets the source with it, and a second run finds 0', () => {
	const { run, remote, clone, git } = brainSandbox()
	run('add', 'learning', 'Old video lesson', '--project', 'youtube-learning', '--body', 'From https://youtu.be/abc123 notes', '--no-push')
	run('add', 'learning', 'Old reel lesson', '--project', 'youtube-learning', '--body', 'From https://www.instagram.com/reel/xyz/', '--no-push')
	run('add', 'learning', 'Plain lesson, no source to tell', '--no-push')
	const head = git('-C', remote, 'rev-parse', 'main')
	const dry = run('backfill-source')
	assert.equal(dry.status, 0, dry.err)
	assert.match(dry.out, /2 lessons would get a source/)
	assert.equal(run('search', 'source:youtube').out.includes('Old video lesson'), true, 'derived source is already searchable')
	assert.equal(git('-C', clone, 'status', '--porcelain'), '', 'a dry run writes nothing')
	const commits = git('-C', clone, 'rev-list', '--count', 'HEAD')
	const wet = run('backfill-source', '--yes', '--no-push')
	assert.equal(wet.status, 0, wet.err)
	assert.match(wet.out, /2 lessons got a source/)
	assert.match(run('backfill-source').out, /0 lessons would get a source/)
	assert.match(run('backfill-source', '--yes', '--no-push').out, /0 lessons got a source/)
	assert.equal(Number(git('-C', clone, 'rev-list', '--count', 'HEAD')) - Number(commits), 1, 'one commit for the whole backfill')
	assert.match(run('search', 'source:youtube').out, /Old video lesson/)
	assert.equal(git('-C', remote, 'rev-parse', 'main'), head)
})

function claudeHome(root, name = 'home') {
	const home = join(root, name)
	const claude = join(home, '.claude')
	mkdirSync(join(claude, 'skills', 'real-skill', 'node_modules', 'dep'), { recursive: true })
	mkdirSync(join(claude, 'skills', 'real-skill', 'scripts'), { recursive: true })
	mkdirSync(join(root, 'elsewhere-skill'), { recursive: true })
	writeFileSync(join(root, 'elsewhere-skill', 'SKILL.md'), 'linked skill')
	writeFileSync(join(claude, 'CLAUDE.md'), '# my rules\n')
	writeFileSync(join(claude, 'RTK.md'), '# rtk\n')
	writeFileSync(join(claude, 'skills', 'real-skill', 'SKILL.md'), '# real skill\n')
	writeFileSync(join(claude, 'skills', 'real-skill', 'scripts', 'run.sh'), 'echo hi\n')
	writeFileSync(join(claude, 'skills', 'real-skill', 'logo.png'), 'PNGDATA')
	writeFileSync(join(claude, 'skills', 'real-skill', 'node_modules', 'dep', 'index.js'), 'x')
	symlinkSync(join(root, 'elsewhere-skill'), join(claude, 'skills', 'linked-skill'))
	return home
}

test('configFiles keeps rules and real skills as text and skips a symlinked skill, a PNG and node_modules', () => {
	const { root } = brainSandbox()
	const { keep, skipped } = configFiles(claudeHome(root))
	assert.deepEqual(keep.map((k) => k.rel), ['CLAUDE.md', 'RTK.md', 'skills/real-skill/SKILL.md', 'skills/real-skill/scripts/run.sh'])
	const why = Object.fromEntries(skipped.map((s) => [s.rel, s.why]))
	assert.equal(why['skills/linked-skill'], 'symlink')
	assert.equal(why['skills/real-skill/logo.png'], 'not text')
	assert.equal(why['skills/real-skill/node_modules'], 'node_modules')
})

test('a skill installed as a link is stored; a link to anything else, or from outside the home folder, is not', () => {
	const { root } = brainSandbox()
	const home = join(root, 'home')
	const skills = join(home, '.claude', 'skills')
	mkdirSync(skills, { recursive: true })
	const place = (dir, files) => {
		mkdirSync(dir, { recursive: true })
		for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
	}
	place(join(home, '.agents', 'skills', 'asc-cli'), { 'SKILL.md': '# asc\n', 'notes.md': 'n\n', '.env': 'A=1\n', 'logo.png': 'x' })
	symlinkSync(join(home, '.agents', 'skills', 'asc-cli'), join(skills, 'asc-cli'))
	symlinkSync(join(home, '.agents', 'skills'), join(home, '.agents', 'skills', 'asc-cli', 'loop'))
	place(join(home, 'Documents', 'stuff'), { 'private.md': 'mine\n' })
	symlinkSync(join(home, 'Documents', 'stuff'), join(skills, 'not-a-skill'))
	place(join(root, 'elsewhere', 'outside'), { 'SKILL.md': '# outside\n' })
	symlinkSync(join(root, 'elsewhere', 'outside'), join(skills, 'outside'))
	symlinkSync(join(home, 'gone'), join(skills, 'broken'))
	const { keep, skipped } = configFiles(home)
	assert.deepEqual(keep.map((k) => k.rel), ['skills/asc-cli/SKILL.md', 'skills/asc-cli/notes.md'])
	const why = Object.fromEntries(skipped.map((s) => [s.rel, s.why]))
	for (const rel of ['skills/not-a-skill', 'skills/outside', 'skills/broken', 'skills/asc-cli/loop']) assert.equal(why[rel], 'symlink', rel)
	assert.equal(why['skills/asc-cli/.env'], 'sensitive name')
})

test('a linked skill comes back on a new computer as a real folder, and a secret in one stops the backup', () => {
	const { run, root } = brainSandbox({ config: { library: true } })
	const home = join(root, 'home')
	mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
	mkdirSync(join(home, '.agents', 'asc-cli'), { recursive: true })
	writeFileSync(join(home, '.agents', 'asc-cli', 'SKILL.md'), '# asc\n')
	symlinkSync(join(home, '.agents', 'asc-cli'), join(home, '.claude', 'skills', 'asc-cli'))
	const backup = run('config', 'backup', '--home', home)
	assert.equal(backup.status, 0, backup.err)
	const fresh = join(root, 'fresh')
	const restored = run('config', 'restore', '--home', fresh)
	assert.equal(restored.status, 0, restored.err)
	const back = join(fresh, '.claude', 'skills', 'asc-cli')
	assert.equal(lstatSync(back).isDirectory(), true)
	assert.equal(readFileSync(join(back, 'SKILL.md'), 'utf8'), '# asc\n')

	writeFileSync(join(home, '.agents', 'asc-cli', 'key.md'), `key: ${['sk', 'ant', 'api03', 'a'.repeat(40)].join('-')}\n`)
	const leaked = run('config', 'backup', '--home', home)
	assert.notEqual(leaked.status, 0)
	assert.match(leaked.err, /skills\/asc-cli\/key\.md/)
})

test('config backup and restore are refused while the library is off', () => {
	const { run, root, remote, git } = brainSandbox()
	const head = git('-C', remote, 'rev-parse', 'main')
	const r = run('config', 'backup', '--home', claudeHome(root))
	assert.notEqual(r.status, 0)
	assert.match(r.err, /"library": true/)
	assert.notEqual(run('config', 'restore', '--home', join(root, 'x')).status, 0)
	assert.equal(git('-C', remote, 'rev-parse', 'main'), head)
})

test('config backup with a secret commits nothing and names the file, not the value', () => {
	const { run, root, remote, clone, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2'
	writeFileSync(join(home, '.claude', 'skills', 'real-skill', 'SKILL.md'), `token ${token}`)
	const head = git('-C', remote, 'rev-parse', 'main')
	const r = run('config', 'backup', '--home', home)
	assert.notEqual(r.status, 0)
	assert.match(r.err, /skills\/real-skill\/SKILL\.md/)
	assert.ok(!(r.err + r.out).includes(token))
	assert.equal(git('-C', remote, 'rev-parse', 'main'), head)
	assert.ok(!existsSync(join(clone, 'bridge', 'config')))
	assert.equal(git('-C', clone, 'status', '--porcelain'), '')
})

test('config backup prints its counts in one commit, and restore keeps an existing file without --force', () => {
	const { run, root, remote, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	const before = git('-C', remote, 'rev-list', '--count', 'main')
	const b = run('config', 'backup', '--home', home)
	assert.equal(b.status, 0, b.err)
	assert.match(b.out, /kept 4 files, skipped 3 \(/)
	assert.equal(Number(git('-C', remote, 'rev-list', '--count', 'main')) - Number(before), 1)
	const onRemote = git('-C', remote, 'ls-tree', '-r', '--name-only', 'main').split('\n')
	assert.ok(onRemote.includes('bridge/config/cli-test/skills/real-skill/SKILL.md'))
	assert.ok(!onRemote.some((p) => p.endsWith('logo.png') || p.includes('node_modules')))
	assert.match(run('config', 'backup', '--home', home).out, /nothing changed/)

	const fresh = join(root, 'fresh')
	mkdirSync(join(fresh, '.claude'), { recursive: true })
	writeFileSync(join(fresh, '.claude', 'CLAUDE.md'), 'mine')
	const r = run('config', 'restore', '--home', fresh)
	assert.equal(r.status, 0, r.err)
	assert.equal(readFileSync(join(fresh, '.claude', 'CLAUDE.md'), 'utf8'), 'mine')
	assert.equal(readFileSync(join(fresh, '.claude', 'skills', 'real-skill', 'SKILL.md'), 'utf8'), '# real skill\n')
	assert.match(r.out, /kept \(already there\): CLAUDE\.md/)
	run('config', 'restore', '--home', fresh, '--force')
	assert.equal(readFileSync(join(fresh, '.claude', 'CLAUDE.md'), 'utf8'), '# my rules\n')
})

test('a new machine gets the library, the rules and the skills back, and search finds a lesson of each source type', () => {
	const a = brainSandbox({ config: { library: true } })
	const home = claudeHome(a.root)
	const types = ['youtube', 'instagram', 'site']
	for (const t of types) {
		assert.equal(a.run('library', 'add', learnedFolder(a.root, `f-${t}`, { 'notes.md': `notes ${t}` }), '--type', t).status, 0)
		const r = a.run('add', 'learning', `Lesson from a ${t} source`, '--source-type', t, '--source-library', `bridge/library/${t}/f-${t}`)
		assert.equal(r.status, 0, r.err)
	}
	assert.equal(a.run('config', 'backup', '--home', home).status, 0)

	// machine B: a new clone of the same remote and its own config
	const b = brainSandbox({ config: { library: true, device: 'cli-new' } })
	b.git('-C', b.clone, 'remote', 'set-url', 'origin', a.remote)
	b.git('-C', b.clone, 'fetch', '-q', 'origin')
	b.git('-C', b.clone, 'reset', '-q', '--hard', 'origin/main')
	const lib = join(b.root, 'learning')
	assert.equal(b.run('library', 'restore', '--root', lib).status, 0)
	assert.equal(readFileSync(join(lib, 'f-instagram', 'notes.md'), 'utf8'), 'notes instagram')
	const newHome = join(b.root, 'newhome')
	const r = b.run('config', 'restore', '--home', newHome)
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /from cli-test/)
	assert.equal(readFileSync(join(newHome, '.claude', 'RTK.md'), 'utf8'), '# rtk\n')
	assert.ok(existsSync(join(newHome, '.claude', 'skills', 'real-skill', 'scripts', 'run.sh')))
	for (const t of types) assert.match(b.run('search', `source:${t}`).out, new RegExp(`Lesson from a ${t} source`))
})

test('doctor says whether the library is on and how many folders it holds; setup --defaults leaves it off', () => {
	const claude = mkdtempSync(join(tmpdir(), 'wp-claude-'))
	const env = { CLAUDE_HOME: claude }
	const offBox = brainSandbox({ env })
	assert.match(offBox.run('doctor').out, /Library\s+off/)
	const s = offBox.run('setup', '--defaults', '--repo', 'test/brain', '--no-push', '--clone', offBox.clone)
	assert.equal(s.status, 0, s.err)
	assert.equal(JSON.parse(readFileSync(offBox.configPath, 'utf8')).library, undefined)

	const on = brainSandbox({ config: { library: true }, env })
	on.run('library', 'add', learnedFolder(on.root, 'v1', { 'notes.md': 'n' }), '--type', 'youtube')
	assert.match(on.run('doctor').out, /Library\s+on — 1 learning folder/)
	const again = on.run('setup', '--defaults', '--repo', 'test/brain', '--no-push', '--clone', on.clone)
	assert.equal(again.status, 0, again.err)
	assert.equal(JSON.parse(readFileSync(on.configPath, 'utf8')).library, true, 'running setup again keeps the choice')
})

// ── fix round 1 ────────────────────────────────────────────────────────────

const onMain = (git, remote) => git('-C', remote, 'ls-tree', '-r', '--name-only', 'main').split('\n')

test('a credential-looking NAME is skipped and reported, whatever the file holds; hidden and venv folders are not entered', () => {
	const { run, root, remote, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	const sk = join(home, '.claude', 'skills', 'a')
	mkdirSync(join(sk, '.secrets'), { recursive: true })
	mkdirSync(join(sk, '.venv', 'lib'), { recursive: true })
	mkdirSync(join(sk, 'venv'), { recursive: true })
	mkdirSync(join(sk, '__pycache__'), { recursive: true })
	mkdirSync(join(sk, 'secrets'), { recursive: true })
	for (const f of ['SKILL.md', 'credentials.json', 'token.json', 'secrets.yaml', '.env.sh', '.ENV.local.md', 'server.pem', 'deploy.key', 'id_rsa_work.txt', 'api-key.md', 'service_account.json', 'Password-notes.md', 'tokens-guide.md', '.secrets/google.txt', '.venv/lib/x.py', 'venv/y.py', '__pycache__/z.py', 'secrets/inside.md'])
		writeFileSync(join(sk, f), 'plain text\n')
	const r = run('config', 'backup', '--home', home)
	assert.equal(r.status, 0, r.err)
	const files = onMain(git, remote).filter((f) => f.includes('/skills/a/'))
	assert.deepEqual(files, ['bridge/config/cli-test/skills/a/SKILL.md'])
	assert.match(r.out, /sensitive name/)
	assert.match(r.out, /hidden folder/)
})

test('a device name that is not a plain folder name is refused before anything is removed', () => {
	for (const device of ['..', '../..', 'x/../../entries', '.']) {
		const { run, root, clone, git } = brainSandbox({ config: { library: true, device } })
		mkdirSync(join(clone, 'bridge', 'entries'), { recursive: true })
		writeFileSync(join(clone, 'bridge', 'entries', 'keep.txt'), 'x')
		git('-C', clone, 'add', 'bridge')
		git('-C', clone, 'commit', '-q', '-m', 'entries')
		const r = run('config', 'backup', '--home', claudeHome(root))
		assert.notEqual(r.status, 0, device)
		assert.match(r.err, /device/)
		assert.ok(existsSync(join(clone, '.git')) && existsSync(join(clone, 'bridge', 'entries', 'keep.txt')), device)
		assert.equal(git('-C', clone, 'status', '--porcelain'), '', device)
	}
	const { run, root } = brainSandbox()
	const bad = run('init', 'me/notes', '--device', '../x', '--clone', join(root, 'c2'))
	assert.notEqual(bad.status, 0)
	assert.match(bad.err, /--device/)
})

test('fileSecretsIn: the bare word service_role is fine, the new shapes and a real password are not, and no value is printed', () => {
	assert.deepEqual(fileSecretsIn('Never use the service_role key in an app.'), [])
	assert.deepEqual(fileSecretsIn('password: changeme-please, password=<your password>, password = "example1234"'), [])
	assert.deepEqual(fileSecretsIn('SUPABASE service_role=eyJ' + 'a'.repeat(30)), ['Supabase token'])
	const shapes = { 'Google API key': 'AIza' + 'A'.repeat(35), 'Google OAuth token': 'ya29.' + 'a'.repeat(25), 'Resend key': 're_' + 'aB3'.repeat(8), 'NVIDIA key': 'nvapi-' + 'a'.repeat(24), 'Stripe live key': 'sk_live_' + 'a'.repeat(20), 'age secret key': 'AGE-SECRET-KEY-' + '1' + 'Q'.repeat(30), password: 'password = "hunter2hunter2"' }
	for (const [name, text] of Object.entries(shapes)) assert.ok(fileSecretsIn(text).includes(name), name)
	assert.deepEqual(fileSecretsIn('AGE-SECRET-KEY-' + '1' + 'Q'.repeat(58)), ['age secret key'], 'named once, though both lists know it')
})

test('config backup and library add name every secret-looking file at once, and never the value', () => {
	const { run, root, remote, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	const value = 'hunter2hunter2'
	writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'The service_role key must never ship.\n') // an ordinary rule, not a hit
	writeFileSync(join(home, '.claude', 'skills', 'real-skill', 'SKILL.md'), `password = "${value}"`)
	writeFileSync(join(home, '.claude', 'skills', 'real-skill', 'scripts', 'run.sh'), 'KEY=AIza' + 'B'.repeat(35))
	const head = git('-C', remote, 'rev-parse', 'main')
	const r = run('config', 'backup', '--home', home)
	assert.notEqual(r.status, 0)
	assert.match(r.err, /skills\/real-skill\/SKILL\.md \(password\)/)
	assert.match(r.err, /scripts\/run\.sh \(Google API key\)/)
	assert.doesNotMatch(r.err, /CLAUDE\.md/)
	assert.ok(!(r.err + r.out).includes(value))
	const dir = learnedFolder(root, 'vid', { 'notes.md': `password: "${value}"` })
	const l = run('library', 'add', dir, '--type', 'site')
	assert.notEqual(l.status, 0)
	assert.match(l.err, /notes\.md \(password\)/)
	assert.equal(git('-C', remote, 'rev-parse', 'main'), head)
})

test('a symlinked skills folder is skipped as a whole', () => {
	const { root } = brainSandbox()
	const home = join(root, 'h')
	mkdirSync(join(home, '.claude'), { recursive: true })
	mkdirSync(join(root, 'other-skills', 's'), { recursive: true })
	writeFileSync(join(root, 'other-skills', 's', 'SKILL.md'), 'x')
	writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'r')
	symlinkSync(join(root, 'other-skills'), join(home, '.claude', 'skills'))
	const { keep, skipped } = configFiles(home)
	assert.deepEqual(keep.map((k) => k.rel), ['CLAUDE.md'])
	assert.deepEqual(skipped, [{ rel: 'skills', why: 'symlink' }])
})

test('a failing commit hook leaves the clone clean, and a re-run after a failed push does not claim success', () => {
	const { run, root, remote, clone, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	const hook = join(clone, '.git', 'hooks', 'pre-commit')
	writeFileSync(hook, '#!/bin/sh\nexit 1\n')
	chmodSync(hook, 0o755)
	const r = run('config', 'backup', '--home', home)
	assert.notEqual(r.status, 0)
	assert.equal(git('-C', clone, 'status', '--porcelain'), '')
	assert.ok(!existsSync(join(clone, 'bridge', 'config')))
	rmSync(hook)

	const rej = join(remote, 'hooks', 'pre-receive')
	writeFileSync(rej, '#!/bin/sh\nexit 1\n')
	chmodSync(rej, 0o755)
	const head = git('-C', remote, 'rev-parse', 'main')
	const first = run('config', 'backup', '--home', home)
	assert.notEqual(first.status, 0)
	assert.match(first.err, /locally/)
	const again = run('config', 'backup', '--home', home)
	assert.notEqual(again.status, 0)
	assert.match(again.err, /only on this machine/)
	assert.doesNotMatch(again.out, /nothing changed/)
	const offline = run('config', 'backup', '--home', home, '--no-push')
	assert.equal(offline.status, 0, offline.err)
	assert.match(offline.out, /not pushed yet/)
	rmSync(rej)
	const ok = run('config', 'backup', '--home', home)
	assert.equal(ok.status, 0, ok.err)
	assert.notEqual(git('-C', remote, 'rev-parse', 'main'), head)
})

test('library restore does not write through a dangling symlink', () => {
	const { run, root } = brainSandbox({ config: { library: true } })
	assert.equal(run('library', 'add', learnedFolder(root, 'vid1', { 'notes.md': 'from backup' }), '--type', 'site').status, 0)
	const target = join(root, 'restored')
	mkdirSync(join(target, 'vid1'), { recursive: true })
	const nowhere = join(root, 'not-there.txt')
	symlinkSync(nowhere, join(target, 'vid1', 'notes.md'))
	const r = run('library', 'restore', '--root', target)
	assert.equal(r.status, 0, r.err)
	assert.ok(!existsSync(nowhere))
	assert.match(r.out, /kept \(already there\): vid1\/notes\.md/)
})

test('restore ignores linked device folders, only puts back CLAUDE.md, RTK.md and skills, and keeps a file where a folder belongs', () => {
	const { run, root, clone, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	assert.equal(run('config', 'backup', '--home', home).status, 0)
	const dev = join(clone, 'bridge', 'config', 'cli-test')
	writeFileSync(join(dev, 'settings.json'), '{"hooks":{}}')
	symlinkSync(join(root, 'nowhere'), join(clone, 'bridge', 'config', 'dangling'))
	symlinkSync(dev, join(clone, 'bridge', 'config', 'linked'))
	git('-C', clone, 'add', 'bridge')
	git('-C', clone, 'commit', '-q', '-m', 'extra')
	const fresh = join(root, 'fresh')
	mkdirSync(join(fresh, '.claude', 'skills'), { recursive: true })
	writeFileSync(join(fresh, '.claude', 'skills', 'real-skill'), 'a file where the skill folder belongs')
	const r = run('config', 'restore', '--home', fresh)
	assert.equal(r.status, 0, r.err)
	assert.ok(!existsSync(join(fresh, '.claude', 'settings.json')))
	assert.equal(readFileSync(join(fresh, '.claude', 'skills', 'real-skill'), 'utf8'), 'a file where the skill folder belongs')
	assert.match(r.out, /kept \(already there\): skills\/real-skill\/ \(a file is there\)/)
	assert.ok(existsSync(join(fresh, '.claude', 'CLAUDE.md')))
})

test('config uses the Claude folder setup uses (CLAUDE_CONFIG_DIR) when --home is not given', () => {
	const dir = mkdtempSync(join(tmpdir(), 'wp-cfgdir-'))
	const { run, root, remote, git } = brainSandbox({ config: { library: true }, env: { CLAUDE_HOME: '', CLAUDE_CONFIG_DIR: join(dir, 'dot-claude') } })
	mkdirSync(join(dir, 'dot-claude'))
	writeFileSync(join(dir, 'dot-claude', 'CLAUDE.md'), '# rules\n')
	const r = run('config', 'backup')
	assert.equal(r.status, 0, r.err)
	assert.ok(onMain(git, remote).includes('bridge/config/cli-test/CLAUDE.md'))
	const back = join(root, 'again')
	assert.equal(run('config', 'restore', '--home', back).status, 0)
})

test('nothing is backed up to a public repository; an unknown one only warns', () => {
	const pub = brainSandbox({ config: { library: true }, env: { WP_BRAIN_REPO_VISIBILITY: 'public' } })
	const home = claudeHome(pub.root)
	const head = pub.git('-C', pub.remote, 'rev-parse', 'main')
	const r = pub.run('config', 'backup', '--home', home)
	assert.notEqual(r.status, 0)
	assert.match(r.err, /public repository/)
	assert.notEqual(pub.run('library', 'add', learnedFolder(pub.root, 'v', { 'notes.md': 'n' }), '--type', 'site').status, 0)
	assert.equal(pub.git('-C', pub.remote, 'rev-parse', 'main'), head)
	for (const [v, warns] of [['private', false], ['unknown', true]]) {
		const b = brainSandbox({ config: { library: true }, env: { WP_BRAIN_REPO_VISIBILITY: v } })
		const ok = b.run('config', 'backup', '--home', claudeHome(b.root))
		assert.equal(ok.status, 0, ok.err)
		assert.equal(/could not tell whether/.test(ok.err), warns, v)
	}
})

// ── fix round 2 ────────────────────────────────────────────────────────────

test('the credential word list applies to every folder below a skill, but not to the skill folder token-economy-setup', () => {
	const { run, root, remote, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	const skills = join(home, '.claude', 'skills')
	const bad = ['tokens/google.txt', 'token/x.txt', 'auth-token/x.txt', 'api-keys/prod.md', 'service-account/x.txt', 'my-secrets/x.md', 'prod_credentials/x.md', 'passwords/x.txt']
	for (const f of bad) {
		mkdirSync(join(skills, 'a', f.split('/')[0]), { recursive: true })
		writeFileSync(join(skills, 'a', f), 'plain\n')
	}
	writeFileSync(join(skills, 'a', 'SKILL.md'), 'x')
	mkdirSync(join(skills, 'token-economy-setup'))
	writeFileSync(join(skills, 'token-economy-setup', 'SKILL.md'), 'kept')
	const r = run('config', 'backup', '--home', home)
	assert.equal(r.status, 0, r.err)
	const files = onMain(git, remote).filter((f) => f.includes('/skills/'))
	for (const f of bad) assert.ok(!files.some((p) => p.endsWith(f)), f)
	assert.ok(files.includes('bridge/config/cli-test/skills/token-economy-setup/SKILL.md'))
})

test('password and re_ rules fire on real literals, not on code or names', () => {
	for (const ok of ['password: process.env.DB_PASS', 'password: req.body.pw', 'const password = getPass(input)', 'password: hashedPw1', 're_generate_all_the_things', 'password = "short"'])
		assert.deepEqual(fileSecretsIn(ok), [], ok)
	assert.deepEqual(fileSecretsIn('password: "hunter22"'), ['password'])
	assert.deepEqual(fileSecretsIn("const password = 'abc123'"), ['password'])
})

test('with no upstream yet, an unpushed backup is pushed by the next run, or reported when the push fails', () => {
	const { run, root, remote, clone, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	git('-C', clone, 'branch', '--unset-upstream')
	git('-C', clone, 'update-ref', '-d', 'refs/remotes/origin/main')
	assert.equal(run('config', 'backup', '--home', home, '--no-push').status, 0)
	const rej = join(remote, 'hooks', 'pre-receive')
	writeFileSync(rej, '#!/bin/sh\nexit 1\n')
	chmodSync(rej, 0o755)
	const failed = run('config', 'backup', '--home', home)
	assert.notEqual(failed.status, 0)
	assert.doesNotMatch(failed.out, /nothing changed/)
	assert.match(failed.err, /only on this machine/)
	rmSync(rej)
	const ok = run('config', 'backup', '--home', home)
	assert.equal(ok.status, 0, ok.err)
	assert.ok(onMain(git, remote).includes('bridge/config/cli-test/CLAUDE.md'))
})

test('a backup never touches another device folder that only looks like its stage', () => {
	const { run, root, remote, clone, git } = brainSandbox({ config: { library: true, device: 'a' } })
	mkdirSync(join(clone, 'bridge', 'config', 'a.new'), { recursive: true })
	writeFileSync(join(clone, 'bridge', 'config', 'a.new', 'CLAUDE.md'), 'theirs')
	git('-C', clone, 'add', 'bridge')
	git('-C', clone, 'commit', '-q', '-m', 'other device')
	git('-C', clone, 'push', '-q', 'origin', 'HEAD')
	const r = run('config', 'backup', '--home', claudeHome(root))
	assert.equal(r.status, 0, r.err)
	assert.equal(readFileSync(join(clone, 'bridge', 'config', 'a.new', 'CLAUDE.md'), 'utf8'), 'theirs')
	assert.equal(git('-C', clone, 'status', '--porcelain'), '')
	assert.ok(onMain(git, remote).includes('bridge/config/a.new/CLAUDE.md'))
	assert.ok(onMain(git, remote).includes('bridge/config/a/CLAUDE.md'))
})

test('a folder named foo* is rolled back literally and a library add builds nothing partial', () => {
	const { run, root, clone, git } = brainSandbox({ config: { library: true } })
	mkdirSync(join(clone, 'bridge', 'library', 'site', 'foobar'), { recursive: true })
	writeFileSync(join(clone, 'bridge', 'library', 'site', 'foobar', 'notes.md'), 'someone else, uncommitted')
	const hook = join(clone, '.git', 'hooks', 'pre-commit')
	writeFileSync(hook, '#!/bin/sh\nexit 1\n')
	chmodSync(hook, 0o755)
	const r = run('library', 'add', learnedFolder(root, 'foo*', { 'notes.md': 'n' }), '--type', 'site')
	assert.notEqual(r.status, 0)
	assert.ok(!existsSync(join(clone, 'bridge', 'library', 'site', 'foo*')))
	assert.equal(readFileSync(join(clone, 'bridge', 'library', 'site', 'foobar', 'notes.md'), 'utf8'), 'someone else, uncommitted')
	assert.deepEqual(readdirSync(join(clone, '.git')).filter((f) => f.startsWith('wp-brain-stage')), [])
})

test('restore prints the --force hint when it keeps files; list ignores a symlinked library folder', () => {
	const { run, root, clone, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	assert.equal(run('config', 'backup', '--home', home).status, 0)
	assert.match(run('config', 'restore', '--home', home).out, /use --force/)
	rmSync(join(clone, 'bridge', 'library'), { recursive: true, force: true })
	symlinkSync(join(root, 'elsewhere-skill'), join(clone, 'bridge', 'library'))
	git('-C', clone, 'add', 'bridge')
	git('-C', clone, 'commit', '-q', '-m', 'link')
	const l = run('library', 'list')
	assert.equal(l.status, 0, l.err)
	assert.match(l.out, /Library empty/)
})

test('sync after a rejected push says the commits are local and is not "in step"', () => {
	const { run, root, remote } = brainSandbox({ config: { library: true } })
	assert.equal(run('config', 'backup', '--home', claudeHome(root), '--no-push').status, 0)
	const rej = join(remote, 'hooks', 'pre-receive')
	writeFileSync(rej, '#!/bin/sh\nexit 1\n')
	chmodSync(rej, 0o755)
	const r = run('sync')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /only on this machine/)
	assert.doesNotMatch(r.out, /In step/)
	rmSync(rej)
	assert.match(run('sync').out, /In step/)
})

// ── fix round 3 ────────────────────────────────────────────────────────────

/** Commits a symlink at `rel` in the clone pointing outside it, with a file the test must find afterwards. */
function linkInto(box, rel, outsideName) {
	const outside = join(box.root, outsideName)
	mkdirSync(outside, { recursive: true })
	mkdirSync(dirname(join(box.clone, rel)), { recursive: true })
	symlinkSync(outside, join(box.clone, rel))
	box.git('-C', box.clone, 'add', '-f', rel)
	box.git('-C', box.clone, 'commit', '-q', '-m', 'link')
	return outside
}

test('a symlinked parent is refused for library add, config backup, listing and restore; the file outside survives', () => {
	// bridge/library/site -> outside, with outside/vid/precious.md
	const a = brainSandbox({ config: { library: true } })
	const outA = linkInto(a, 'bridge/library/site', 'outside-a')
	mkdirSync(join(outA, 'vid'))
	writeFileSync(join(outA, 'vid', 'precious.md'), 'keep me')
	const r = a.run('library', 'add', learnedFolder(a.root, 'vid', { 'notes.md': 'n' }), '--type', 'site')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /symlink/)
	assert.equal(readFileSync(join(outA, 'vid', 'precious.md'), 'utf8'), 'keep me')
	assert.match(a.run('library', 'list').out, /Library empty/)

	// bridge/config -> outside, with outside/cli-test/precious.md
	const b = brainSandbox({ config: { library: true } })
	const outB = linkInto(b, 'bridge/config', 'outside-b')
	mkdirSync(join(outB, 'cli-test'))
	writeFileSync(join(outB, 'cli-test', 'precious.md'), 'keep me')
	const r2 = b.run('config', 'backup', '--home', claudeHome(b.root))
	assert.notEqual(r2.status, 0)
	assert.match(r2.err, /symlink/)
	assert.equal(readFileSync(join(outB, 'cli-test', 'precious.md'), 'utf8'), 'keep me')
	assert.notEqual(b.run('config', 'restore', '--home', join(b.root, 'x')).status, 0)

	// bridge itself -> outside
	const c = brainSandbox({ config: { library: true } })
	const outC = linkInto(c, 'bridge', 'outside-c')
	mkdirSync(join(outC, 'library', 'site', 'vid'), { recursive: true })
	writeFileSync(join(outC, 'library', 'site', 'vid', 'precious.md'), 'keep me')
	assert.notEqual(c.run('library', 'add', learnedFolder(c.root, 'vid', { 'notes.md': 'n' }), '--type', 'site').status, 0)
	assert.match(c.run('library', 'list').out, /Library empty/)
	assert.equal(readFileSync(join(outC, 'library', 'site', 'vid', 'precious.md'), 'utf8'), 'keep me')
})

test('templates and placeholders are not passwords; quoted keys, passwd and env-style values are', () => {
	for (const ok of ['password: "${DB_PASS}"', 'POSTGRES_PASSWORD: "${PGPASS}"', 'password: "{{ vault_pw }}"', 'password: "$DB_PASS"', 'password: "<your password>"', 'password: hunter2hunter2', 'DB_PASSWORD=${PGPASS}', 'DB_PASSWORD=getenv("X")', 're_generate_all_the_things_v2'])
		assert.deepEqual(fileSecretsIn(ok), [], ok)
	for (const bad of ['"password": "hunter22"', "{'password': 'hunter22'}", 'passwd: "hunter22"', 'DB_PASSWORD=hunter2hunter2'])
		assert.deepEqual(fileSecretsIn(bad), ['password'], bad)
})

test('library add re-runs keep what is already backed up, and refuse a folder with no owner', () => {
	const { run, root, clone } = brainSandbox({ config: { library: true } })
	const dir = learnedFolder(root, 'vid', { 'notes.md': 'n', 'transcript.md': 't' })
	assert.equal(run('library', 'add', dir, '--type', 'site').status, 0)
	const dest = join(clone, 'bridge/library/site/vid')
	writeFileSync(join(dest, 'extra.md'), 'untracked in the clone')
	rmSync(join(dir, 'transcript.md'))
	writeFileSync(join(dir, 'notes.md'), 'changed')
	const again = run('library', 'add', dir, '--type', 'site')
	assert.equal(again.status, 0, again.err)
	assert.match(again.out, /kept in the backup.*transcript\.md/)
	assert.equal(readFileSync(join(dest, 'transcript.md'), 'utf8'), 't')
	assert.equal(readFileSync(join(dest, 'extra.md'), 'utf8'), 'untracked in the clone')
	assert.equal(readFileSync(join(dest, 'notes.md'), 'utf8'), 'changed')
	// over the cap now: the earlier copy stays
	writeFileSync(join(dir, 'transcript.md'), Buffer.alloc(3 * 1024 * 1024, 97))
	run('library', 'add', dir, '--type', 'site')
	assert.equal(readFileSync(join(dest, 'transcript.md'), 'utf8'), 't')

	const other = learnedFolder(root, 'noowner', { 'notes.md': 'n' })
	mkdirSync(join(clone, 'bridge/library/site/noowner'), { recursive: true })
	writeFileSync(join(clone, 'bridge/library/site/noowner/notes.md'), 'theirs')
	const r = run('library', 'add', other, '--type', 'site')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /no \.owner file/)
	assert.equal(readFileSync(join(clone, 'bridge/library/site/noowner/notes.md'), 'utf8'), 'theirs')
})

test('names with spaces and keys/auth folders are skipped, and config backup lists the skipped sensitive names', () => {
	const { run, root, remote, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	const sk = join(home, '.claude', 'skills', 'a')
	for (const d of ['API Keys', 'service account', 'keys', 'auth', 'tokens']) {
		mkdirSync(join(sk, d), { recursive: true })
		writeFileSync(join(sk, d, 'x.md'), 'plain')
	}
	writeFileSync(join(sk, 'SKILL.md'), 'x')
	mkdirSync(join(home, '.claude', 'skills', 'tokens'))
	writeFileSync(join(home, '.claude', 'skills', 'tokens', 'SKILL.md'), 'a skill called tokens is kept')
	const r = run('config', 'backup', '--home', home)
	assert.equal(r.status, 0, r.err)
	const files = onMain(git, remote).filter((f) => f.includes('/skills/'))
	assert.ok(!files.some((f) => f.includes('/skills/a/') && !f.endsWith('SKILL.md')), files.join())
	assert.ok(files.includes('bridge/config/cli-test/skills/tokens/SKILL.md'))
	for (const d of ['API Keys', 'service account', 'keys', 'auth']) assert.match(r.out, new RegExp(`skipped \\(sensitive name\\): skills/a/${d}`))
})

test('each run stages in its own folder, and only a stage older than an hour is cleaned up', () => {
	const { run, root, clone } = brainSandbox({ config: { library: true } })
	const gitDir = join(clone, '.git')
	const young = join(gitDir, 'wp-brain-stage-young')
	const old = join(gitDir, 'wp-brain-stage-old')
	for (const d of [young, old]) {
		mkdirSync(d)
		writeFileSync(join(d, 'f'), 'x')
	}
	const past = new Date(Date.now() - 2 * 3600 * 1000)
	utimesSync(old, past, past)
	assert.equal(run('config', 'backup', '--home', claudeHome(root)).status, 0)
	assert.ok(existsSync(young) && !existsSync(old))
})

test('a rejected first push with no upstream says the commit is local, not a raw git error', () => {
	const { run, root, remote, clone, git } = brainSandbox({ config: { library: true } })
	git('-C', clone, 'branch', '--unset-upstream')
	git('-C', clone, 'update-ref', '-d', 'refs/remotes/origin/main')
	const rej = join(remote, 'hooks', 'pre-receive')
	writeFileSync(rej, '#!/bin/sh\nexit 1\n')
	chmodSync(rej, 0o755)
	const r = run('config', 'backup', '--home', claudeHome(root))
	assert.notEqual(r.status, 0)
	assert.match(r.err, /Committed locally/)
	assert.doesNotMatch(r.err, /fatal|Command failed/)
})

// ── fix round 4: library add writes only what it scanned ───────────────────

/** A real second machine: its own clone of the same remote, which can push what the CLI's pull then brings in. */
function otherClone(box) {
	const dir = join(box.root, 'other-clone')
	box.git('clone', '-q', box.remote, dir)
	box.git('-C', dir, 'config', 'user.email', 'other@example.com')
	box.git('-C', dir, 'config', 'user.name', 'Other')
	return dir
}

/** Pushes a symlink at `rel` from the second clone. */
function pushLink(box, other, rel, target) {
	box.git('-C', other, 'pull', '-q', '--rebase')
	rmSync(join(other, rel), { recursive: true, force: true })
	mkdirSync(dirname(join(other, rel)), { recursive: true })
	symlinkSync(target, join(other, rel))
	box.git('-C', other, 'add', '--', rel)
	box.git('-C', other, 'commit', '-q', '-m', 'a link')
	box.git('-C', other, 'push', '-q', 'origin', 'HEAD:main')
}

const treeMode = (box, path) => box.git('-C', box.remote, 'ls-tree', 'main', '--', path).split(/\s/)[0]
const VICTIM_LINK = '../../../../../victim.md' // from bridge/library/site/vid/<file> to the sandbox root

for (const name of ['notes.md', '.owner', 'unrelated.md']) {
	test(`library add refuses a tracked symlink (${name}) that a pull brought in, names it, and the file outside is untouched`, () => {
		const box = brainSandbox({ config: { library: true } })
		const { run, root, clone, remote, git } = box
		const victim = join(root, 'victim.md')
		writeFileSync(victim, 'cli-test\n') // same text as a real .owner: the link must not pass as ownership either
		const dir = learnedFolder(root, 'vid', { 'notes.md': 'first' })
		assert.equal(run('library', 'add', dir, '--type', 'site').status, 0)
		pushLink(box, otherClone(box), `bridge/library/site/vid/${name}`, VICTIM_LINK)
		const head = git('-C', remote, 'rev-parse', 'main')
		writeFileSync(join(dir, 'notes.md'), 'second')
		const r = run('library', 'add', dir, '--type', 'site')
		assert.notEqual(r.status, 0)
		assert.match(r.err, new RegExp(`symlink.*bridge/library/site/vid/${name.replace('.', '\\.')}`))
		assert.equal(readFileSync(victim, 'utf8'), 'cli-test\n')
		assert.equal(git('-C', remote, 'rev-parse', 'main'), head)
		assert.equal(git('-C', clone, 'status', '--porcelain'), '')
	})
}

test('library add replaces an untracked symlink at a target, never writing through it', () => {
	const { run, root, clone, git, remote } = brainSandbox({ config: { library: true } })
	const victim = join(root, 'victim.md')
	writeFileSync(victim, 'untouched')
	const dir = learnedFolder(root, 'vid', { 'notes.md': 'first' })
	assert.equal(run('library', 'add', dir, '--type', 'site').status, 0)
	symlinkSync(VICTIM_LINK, join(clone, 'bridge/library/site/vid/meta.json'))
	writeFileSync(join(dir, 'meta.json'), '{"real":true}')
	const r = run('library', 'add', dir, '--type', 'site')
	assert.equal(r.status, 0, r.err)
	assert.equal(readFileSync(victim, 'utf8'), 'untouched')
	assert.equal(git('-C', remote, 'show', 'main:bridge/library/site/vid/meta.json'), '{"real":true}')
	assert.equal(treeMode({ git, remote }, 'bridge/library/site/vid/meta.json'), '100644')
})

test('library add publishes neither untracked nor already staged files found in the clone folder', () => {
	const { run, root, clone, remote, git } = brainSandbox({ config: { library: true } })
	const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2'
	const dir = learnedFolder(root, 'vid', { 'notes.md': 'first' })
	assert.equal(run('library', 'add', dir, '--type', 'site').status, 0)
	const dest = join(clone, 'bridge/library/site/vid')
	writeFileSync(join(dest, '.env'), `TOKEN=${token}\n`)
	writeFileSync(join(dest, 'extra.md'), `token ${token}\n`)
	writeFileSync(join(dest, 'staged.md'), `token ${token}\n`)
	git('-C', clone, 'add', '--', 'bridge/library/site/vid/staged.md')
	writeFileSync(join(dir, 'notes.md'), 'second')
	const r = run('library', 'add', dir, '--type', 'site')
	assert.equal(r.status, 0, r.err)
	assert.ok(!(r.out + r.err).includes(token))
	assert.match(r.out, /not backed up.*extra\.md/)
	assert.doesNotMatch(r.out, /kept in the backup.*extra\.md/)
	assert.match(r.out, /not backed up.*staged\.md/, 'staged but never committed is not in the backup')
	assert.doesNotMatch(r.out, /kept in the backup.*staged\.md/)
	const files = onMain(git, remote)
	for (const f of ['.env', 'extra.md', 'staged.md']) assert.ok(!files.includes(`bridge/library/site/vid/${f}`), f)
	assert.equal(git('-C', remote, 'show', 'main:bridge/library/site/vid/notes.md'), 'second')
	assert.equal(readFileSync(join(dest, '.env'), 'utf8'), `TOKEN=${token}\n`, 'left where it was')
	assert.match(git('-C', clone, 'status', '--porcelain', '--', 'bridge/library/site/vid/extra.md'), /^\?\?/)
})

test('a tracked file that is gone from the clone folder stays in the backup', () => {
	const { run, root, clone, remote, git } = brainSandbox({ config: { library: true } })
	const dir = learnedFolder(root, 'vid', { 'notes.md': 'first', 'transcript.md': 't' })
	assert.equal(run('library', 'add', dir, '--type', 'site').status, 0)
	rmSync(join(clone, 'bridge/library/site/vid/transcript.md'))
	rmSync(join(dir, 'transcript.md'))
	writeFileSync(join(dir, 'notes.md'), 'second')
	const r = run('library', 'add', dir, '--type', 'site')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /kept in the backup.*transcript\.md/)
	assert.ok(onMain(git, remote).includes('bridge/library/site/vid/transcript.md'))
})

test('a failed commit rolls back only the written paths, byte for byte, and leaves the rest of the folder', () => {
	const { run, root, clone, remote, git } = brainSandbox({ config: { library: true } })
	const dir = learnedFolder(root, 'vid', { 'notes.md': 'first' })
	assert.equal(run('library', 'add', dir, '--type', 'site').status, 0)
	const dest = join(clone, 'bridge/library/site/vid')
	writeFileSync(join(dest, 'extra.md'), 'mine, untracked')
	writeFileSync(join(dest, 'description.md'), 'mine too, untracked')
	const head = git('-C', remote, 'rev-parse', 'main')
	const statusBefore = git('-C', clone, 'status', '--porcelain')
	const hook = join(clone, '.git', 'hooks', 'pre-commit')
	writeFileSync(hook, '#!/bin/sh\nexit 1\n')
	chmodSync(hook, 0o755)
	writeFileSync(join(dir, 'notes.md'), 'second')
	writeFileSync(join(dir, 'meta.json'), '{}')
	writeFileSync(join(dir, 'description.md'), 'from the source')
	const r = run('library', 'add', dir, '--type', 'site')
	assert.notEqual(r.status, 0)
	assert.equal(readFileSync(join(dest, 'notes.md'), 'utf8'), 'first')
	assert.equal(readFileSync(join(dest, 'extra.md'), 'utf8'), 'mine, untracked')
	assert.equal(readFileSync(join(dest, 'description.md'), 'utf8'), 'mine too, untracked')
	assert.ok(!existsSync(join(dest, 'meta.json')))
	assert.equal(git('-C', clone, 'status', '--porcelain'), statusBefore)
	assert.equal(git('-C', remote, 'rev-parse', 'main'), head)
	assert.deepEqual(readdirSync(join(clone, '.git')).filter((f) => f.startsWith('wp-brain-stage')), [])
})

test('a folder where an allowed file belongs is refused before anything is written', () => {
	const { run, root, clone, git } = brainSandbox({ config: { library: true } })
	const dir = learnedFolder(root, 'vid', { 'notes.md': 'first' })
	assert.equal(run('library', 'add', dir, '--type', 'site').status, 0)
	const dest = join(clone, 'bridge/library/site/vid')
	mkdirSync(join(dest, 'meta.json'))
	writeFileSync(join(dest, 'meta.json', 'inside.md'), 'x')
	writeFileSync(join(dir, 'notes.md'), 'second')
	writeFileSync(join(dir, 'meta.json'), '{}')
	const r = run('library', 'add', dir, '--type', 'site')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /meta\.json/)
	assert.equal(readFileSync(join(dest, 'notes.md'), 'utf8'), 'first')
	assert.equal(readFileSync(join(dest, 'meta.json', 'inside.md'), 'utf8'), 'x')
	assert.deepEqual(git('-C', clone, 'diff', '--name-only'), '')
})

test('library list does not read through a linked .owner', () => {
	const { run, root, clone } = brainSandbox({ config: { library: true } })
	const secretFile = join(root, 'victim.md')
	writeFileSync(secretFile, 'private words')
	mkdirSync(join(clone, 'bridge/library/site/vid'), { recursive: true })
	symlinkSync(VICTIM_LINK, join(clone, 'bridge/library/site/vid/.owner'))
	assert.doesNotMatch(run('library', 'list').out, /private words/)
})

test('config backup stays safe against a tracked link and against untracked files in its folder', () => {
	const box = brainSandbox({ config: { library: true } })
	const { run, root, clone, remote, git } = box
	const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2'
	const home = claudeHome(root)
	assert.equal(run('config', 'backup', '--home', home).status, 0)
	const victim = join(root, 'victim.md')
	writeFileSync(victim, 'untouched')
	// from bridge/config/cli-test/<file> to the sandbox root
	pushLink(box, otherClone(box), 'bridge/config/cli-test/CLAUDE.md', '../../../../victim.md')
	pushLink(box, join(root, 'other-clone'), 'bridge/config/cli-test/skills/real-skill/SKILL.md', '../../../../../../victim.md')
	git('-C', clone, 'pull', '-q', '--rebase')
	const dest = join(clone, 'bridge/config/cli-test')
	writeFileSync(join(dest, '.env'), `TOKEN=${token}\n`)
	writeFileSync(join(dest, 'extra.md'), `token ${token}\n`)
	const r = run('config', 'backup', '--home', home)
	assert.equal(r.status, 0, r.err)
	assert.equal(readFileSync(victim, 'utf8'), 'untouched')
	const files = onMain(git, remote)
	assert.ok(!files.includes('bridge/config/cli-test/.env') && !files.includes('bridge/config/cli-test/extra.md'))
	assert.equal(treeMode(box, 'bridge/config/cli-test/CLAUDE.md'), '100644')
	assert.equal(git('-C', remote, 'show', 'main:bridge/config/cli-test/CLAUDE.md'), '# my rules\n')
	assert.equal(treeMode(box, 'bridge/config/cli-test/skills/real-skill/SKILL.md'), '100644')
})

// ── rebase conflicts ───────────────────────────────────────────────────────

const rebasing = (clone) => ['rebase-merge', 'rebase-apply'].some((d) => existsSync(join(clone, '.git', d)))

/** A local commit and a pushed commit that change the same line of README.md. */
function divergedReadme(box) {
	const other = otherClone(box)
	writeFileSync(join(other, 'README.md'), 'theirs\n')
	box.git('-C', other, 'commit', '-q', '-am', 'theirs')
	box.git('-C', other, 'push', '-q', 'origin', 'HEAD:main')
	writeFileSync(join(box.clone, 'README.md'), 'mine\n')
	box.git('-C', box.clone, 'commit', '-q', '-am', 'mine')
}

test('a rebase conflict is undone: the clone is never left mid-rebase and the backup says it is only local', () => {
	const box = brainSandbox({ config: { library: true } })
	const { run, root, clone, remote, git } = box
	divergedReadme(box)
	const head = git('-C', remote, 'rev-parse', 'main')
	const dir = learnedFolder(root, 'vid', { 'notes.md': 'n' })
	const r = run('library', 'add', dir, '--type', 'site')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /pull failed/)
	assert.match(r.err, /Committed locally/)
	assert.match(r.err, /conflict/)
	assert.ok(!rebasing(clone))
	assert.equal(git('-C', clone, 'status', '--porcelain'), '')
	assert.equal(readFileSync(join(clone, 'README.md'), 'utf8'), 'mine\n')
	assert.equal(git('-C', clone, 'show', 'HEAD:bridge/library/site/vid/notes.md'), 'n')
	assert.equal(git('-C', remote, 'rev-parse', 'main'), head)

	const local = run('add', 'learning', 'While diverged', '--no-push')
	assert.equal(local.status, 0, local.err)
	assert.ok(!rebasing(clone))
})

test('a clone already mid-rebase stops every write command, leaves the rebase alone, and reading still works', () => {
	const box = brainSandbox({ config: { library: true } })
	const { run, root, clone, git } = box
	divergedReadme(box)
	const started = spawnSync('git', ['-C', clone, 'pull', '--rebase', '--quiet'], { encoding: 'utf8' })
	assert.notEqual(started.status, 0)
	assert.ok(rebasing(clone))
	const home = claudeHome(root)
	const dir = learnedFolder(root, 'vid', { 'notes.md': 'n' })
	for (const args of [['library', 'add', dir, '--type', 'site'], ['config', 'backup', '--home', home], ['library', 'restore', '--root', join(root, 'r')], ['config', 'restore', '--home', join(root, 'h2')], ['add', 'learning', 'Should not be written'], ['sync']]) {
		const r = run(...args)
		assert.notEqual(r.status, 0, args.join(' '))
		assert.match(r.err, /middle of a rebase/, args.join(' '))
		assert.match(r.err, /rebase --abort/, args.join(' '))
	}
	assert.ok(rebasing(clone), 'the rebase is left for its owner')
	assert.ok(!existsSync(join(clone, 'bridge')))
	assert.ok(!existsSync(join(root, 'r')))
	const list = run('list')
	assert.equal(list.status, 0, list.err)
	assert.match(run('library', 'list').out, /Library empty/)
	assert.match(run('backfill-source').out, /would get a source/)
	assert.notEqual(run('backfill-source', '--yes').status, 0)
	assert.ok(rebasing(clone))
})

// ── password rule, round 4 ─────────────────────────────────────────────────

test('redactions and framework placeholders are not passwords; a value that only starts with $ or / is', () => {
	for (const ok of ['password: "********"', 'password: "[REDACTED]"', 'password: "%(db)s"', 'password: "#{db_pw}"', 'DB_PASSWORD=********', 'PASSWORD=process.env.DB_PW', 'password: "${DB_PASS}"', 'password: "$DB_PASS"', 'password: "{{ vault_pw }}"', 'password: "{db_pw}"', 'password: "<db pw>"', 'pwd = "/home/me/work"', 'pwd = "./here-now"', 'pwd = "~/work-dir"'])
		assert.deepEqual(fileSecretsIn(ok), [], ok)
	for (const bad of ['password: "$ecretP4ss"', 'password: "/Tr0ub4dor"', 'password: "~Tr0ub4dor"', 'password: ".Tr0ub4dor"', 'password: "{abc}def1"', 'password: "$DB_pass1"', 'pwd = "$ecretP4ss"', 'passwd: "/Tr0ub4dor"', 'DB_PASSWORD=/Tr0ub4dor'])
		assert.deepEqual(fileSecretsIn(bad), ['password'], bad)
})

// ── fix round 5: someone else's rebase, and commits from a temporary index ─

test('init on a clone mid-rebase leaves a hand-resolved conflict alone and makes no false claim', () => {
	const box = brainSandbox()
	const { run, clone, configPath, git } = box
	divergedReadme(box)
	assert.notEqual(spawnSync('git', ['-C', clone, 'pull', '--rebase', '--quiet'], { encoding: 'utf8' }).status, 0)
	writeFileSync(join(clone, 'README.md'), 'resolved by hand\n')
	git('-C', clone, 'add', 'README.md')
	const before = readFileSync(configPath, 'utf8')
	const r = run('init', 't/b', '--clone', clone, '--device', 'dev')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /middle of a rebase/)
	assert.doesNotMatch(r.err + r.out, /Committed locally/)
	assert.ok(existsSync(join(clone, '.git', 'rebase-merge')))
	assert.equal(readFileSync(join(clone, 'README.md'), 'utf8'), 'resolved by hand\n')
	assert.match(git('-C', clone, 'status', '--porcelain', '--', 'README.md'), /^M /)
	assert.ok(!existsSync(join(clone, 'bridge')))
	assert.equal(readFileSync(configPath, 'utf8'), before)
})

const noRawGit = (r) => assert.doesNotMatch(r.err + r.out, /fatal|Command failed|pathspec|error:/)

for (const rel of ['skills', 'skills/real-skill']) {
	test(`config backup replaces a link another clone pushed at ${rel}, where its folder belongs`, () => {
		const box = brainSandbox({ config: { library: true } })
		const { run, root, clone, remote, git } = box
		const home = claudeHome(root)
		assert.equal(run('config', 'backup', '--home', home).status, 0)
		const victim = join(root, 'victim.md')
		writeFileSync(victim, 'untouched')
		pushLink(box, otherClone(box), `bridge/config/cli-test/${rel}`, '/nowhere/at/all')
		const r = run('config', 'backup', '--home', home)
		assert.equal(r.status, 0, r.err)
		noRawGit(r)
		assert.equal(treeMode(box, `bridge/config/cli-test/${rel}`), '040000')
		assert.equal(git('-C', remote, 'show', 'main:bridge/config/cli-test/skills/real-skill/SKILL.md'), '# real skill\n')
		assert.equal(git('-C', clone, 'status', '--porcelain'), '')
		assert.equal(readFileSync(victim, 'utf8'), 'untouched')
	})
}

test('config backup follows a file that becomes a folder, and a folder that becomes a file', () => {
	const { run, root, clone, remote, git } = brainSandbox({ config: { library: true } })
	const home = claudeHome(root)
	const ref = join(home, '.claude', 'skills', 'real-skill', 'ref.md')
	writeFileSync(ref, 'a file\n')
	assert.equal(run('config', 'backup', '--home', home).status, 0)

	rmSync(ref)
	mkdirSync(ref)
	writeFileSync(join(ref, 'inner.md'), 'in a folder\n')
	const toFolder = run('config', 'backup', '--home', home)
	assert.equal(toFolder.status, 0, toFolder.err)
	noRawGit(toFolder)
	const inRemote = 'main:bridge/config/cli-test/skills/real-skill/ref.md'
	assert.equal(git('-C', remote, 'show', `${inRemote}/inner.md`), 'in a folder\n')
	assert.equal(git('-C', clone, 'status', '--porcelain'), '')

	rmSync(ref, { recursive: true })
	writeFileSync(ref, 'a file again\n')
	const toFile = run('config', 'backup', '--home', home)
	assert.equal(toFile.status, 0, toFile.err)
	noRawGit(toFile)
	assert.equal(git('-C', remote, 'show', inRemote), 'a file again\n')
	assert.equal(git('-C', clone, 'status', '--porcelain'), '')
})

test('a staged unrelated file stays staged and off the remote, for a backup and for an entry', () => {
	const { run, root, clone, remote, git } = brainSandbox({ config: { library: true } })
	writeFileSync(join(clone, 'unrelated.md'), 'staged by hand\n')
	git('-C', clone, 'add', 'unrelated.md')
	assert.equal(run('config', 'backup', '--home', claudeHome(root)).status, 0)
	const added = run('add', 'learning', 'An entry beside a staged file')
	assert.equal(added.status, 0, added.err)
	assert.equal(run('library', 'add', learnedFolder(root, 'vid', { 'notes.md': 'n' }), '--type', 'site').status, 0)
	const files = onMain(git, remote)
	assert.ok(!files.includes('unrelated.md'))
	assert.ok(files.includes('bridge/config/cli-test/CLAUDE.md') && files.includes('bridge/library/site/vid/notes.md'))
	assert.equal(git('-C', clone, 'status', '--porcelain').trim(), 'A  unrelated.md')
})

test('rm --purge still takes the line and the record off the remote', () => {
	const { run, clone, remote, git } = brainSandbox()
	const added = run('add', 'learning', 'Purge this lesson')
	assert.equal(added.status, 0, added.err)
	const id = run('list').out.match(/\[(\w+)\]/)[1]
	assert.equal(run('index').status, 0)
	const records = () => onMain(git, remote).filter((f) => f.startsWith('bridge/records/'))
	assert.equal(records().length, 1)
	const r = run('rm', id, '--purge')
	assert.equal(r.status, 0, r.err)
	assert.deepEqual(records(), [])
	assert.equal(spawnSync('git', ['-C', remote, 'grep', '-q', 'Purge this lesson', 'main', '--', 'bridge']).status, 1, 'no line left')
	assert.equal(git('-C', clone, 'status', '--porcelain'), '')
})

test('the first commit on an unborn branch works, and a staged file stays off it', () => {
	const box = brainSandbox()
	const { run, root, configPath, git } = box
	const bare = join(root, 'empty.git')
	const clone = join(root, 'empty-clone')
	git('init', '-q', '--bare', '-b', 'main', bare)
	git('clone', '-q', bare, clone)
	git('-C', clone, 'config', 'user.email', 'test@example.com')
	git('-C', clone, 'config', 'user.name', 'Test')
	writeFileSync(configPath, JSON.stringify({ repo: 'test/brain', clone, device: 'cli-test' }))
	writeFileSync(join(clone, 'unrelated.md'), 'staged by hand\n')
	git('-C', clone, 'add', 'unrelated.md')
	const r = run('add', 'learning', 'First ever entry')
	assert.equal(r.status, 0, r.err)
	const files = git('-C', bare, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')
	assert.ok(files.some((f) => f.startsWith('bridge/entries/')))
	assert.ok(!files.includes('unrelated.md'))
	assert.equal(git('-C', clone, 'status', '--porcelain').trim(), 'A  unrelated.md')
})

// ── an operation someone left unfinished: merge, cherry-pick, revert ───────

/** Sets up a stopped git operation in the clone, conflict left or resolved and staged, and names its state file. */
const unfinishedOps = {
	merge: (box) => {
		divergedReadme(box)
		box.git('-C', box.clone, 'fetch', '-q', 'origin')
		assert.notEqual(spawnSync('git', ['-C', box.clone, 'merge', 'origin/main'], { encoding: 'utf8' }).status, 0)
		return 'MERGE_HEAD'
	},
	'cherry-pick': (box) => {
		divergedReadme(box)
		box.git('-C', box.clone, 'fetch', '-q', 'origin')
		assert.notEqual(spawnSync('git', ['-C', box.clone, 'cherry-pick', 'origin/main'], { encoding: 'utf8' }).status, 0)
		return 'CHERRY_PICK_HEAD'
	},
	revert: (box) => {
		for (const text of ['one\n', 'two\n']) {
			writeFileSync(join(box.clone, 'README.md'), text)
			box.git('-C', box.clone, 'commit', '-q', '-am', text.trim())
		}
		assert.notEqual(spawnSync('git', ['-C', box.clone, 'revert', '--no-edit', 'HEAD~1'], { encoding: 'utf8' }).status, 0)
		return 'REVERT_HEAD'
	},
}

for (const [op, start] of Object.entries(unfinishedOps)) {
	for (const resolved of [true, false]) {
		test(`a ${resolved ? 'resolved' : 'conflicted'} ${op} stops every write, is left as it was, and reading still works`, () => {
			const box = brainSandbox({ config: { library: true } })
			const { run, root, clone, remote, git } = box
			const state = start(box)
			if (resolved) {
				writeFileSync(join(clone, 'README.md'), 'resolved by hand\n')
				git('-C', clone, 'add', 'README.md')
			}
			const tip = git('-C', remote, 'rev-parse', 'main')
			const head = git('-C', clone, 'rev-parse', 'HEAD')
			const tree = git('-C', clone, 'status', '--porcelain')
			const home = claudeHome(root)
			const dir = learnedFolder(root, 'vid', { 'notes.md': 'n' })
			for (const args of [['add', 'learning', 'During an unfinished operation'], ['config', 'backup', '--home', home], ['library', 'add', dir, '--type', 'site'], ['index'], ['sync'], ['init', 't/b', '--clone', clone, '--device', 'dev']]) {
				const r = run(...args)
				assert.notEqual(r.status, 0, args.join(' '))
				assert.match(r.err, new RegExp(`middle of a ${op}`), args.join(' '))
				assert.match(r.err, new RegExp(`${op} --abort`), args.join(' '))
				assert.doesNotMatch(r.out, /Pushed/, args.join(' '))
			}
			assert.ok(existsSync(join(clone, '.git', state)), `${state} is left for its owner`)
			assert.equal(git('-C', clone, 'rev-parse', 'HEAD'), head, 'no commit was made')
			assert.equal(git('-C', remote, 'rev-parse', 'main'), tip, 'the remote tip is unchanged')
			assert.equal(git('-C', clone, 'status', '--porcelain'), tree, 'the working tree is unchanged')
			assert.ok(!existsSync(join(clone, 'bridge')))
			const list = run('list')
			assert.equal(list.status, 0, list.err)
			assert.match(list.err, new RegExp(`middle of a ${op}`))
		})
	}
}

// ── final review: a new machine's CLAUDE.md ─────────────────────────────────

/** A second machine on the same remote: its own HOME, clone and config, so `claudeDir()` is the temp HOME's .claude. */
function secondMachine(box) {
	const home = mkdtempSync(join(tmpdir(), 'wp-new-home-'))
	const clone = join(home, 'brain')
	box.git('clone', '-q', box.remote, clone)
	box.git('-C', clone, 'config', 'user.email', 'test@example.com')
	box.git('-C', clone, 'config', 'user.name', 'Test')
	const configPath = join(home, 'brain.json')
	const claude = join(home, '.claude')
	const run = (...args) => box.runWith({ HOME: home, CLAUDE_HOME: '', CLAUDE_CONFIG_DIR: '', WP_BRAIN_CONFIG: configPath }, ...args)
	const setup = () => run('setup', '--repo', 'test/brain', '--branch', 'main', '--device', 'cli-new', '--clone', clone, '--rule', 'y', '--library', 'y', '--brief', 'n', '--record', 'n', '--skill', 'n', '--no-push')
	return { home, claude, clone, run, setup, md: () => readFileSync(join(claude, 'CLAUDE.md'), 'utf8') }
}

function backedUp(claudeMd) {
	const box = brainSandbox({ config: { library: true } })
	const home = join(box.root, 'old-home')
	mkdirSync(join(home, '.claude', 'skills', 'real-skill'), { recursive: true })
	writeFileSync(join(home, '.claude', 'CLAUDE.md'), claudeMd)
	writeFileSync(join(home, '.claude', 'skills', 'real-skill', 'SKILL.md'), '# skill\n')
	const r = box.run('config', 'backup', '--home', home)
	assert.equal(r.status, 0, r.err)
	return box
}

const count = (text, what) => text.split(what).length - 1
const BLOCK = 'workpulse-brain:start'

test('a new machine: the starter CLAUDE.md from setup gives way to the backup, and the Brain rule stays', () => {
	const m = secondMachine(backedUp('# My real rules\n\nkeep me\n'))
	const s = m.setup()
	assert.equal(s.status, 0, s.err)
	assert.match(m.md(), new RegExp(BLOCK), 'setup wrote the rule')
	assert.doesNotMatch(m.md(), /keep me/)

	const r = m.run('config', 'restore')
	assert.equal(r.status, 0, r.err)
	const md = m.md()
	assert.match(md, /^# My real rules\n\nkeep me\n/, 'the backup is what is there now')
	assert.equal(count(md, BLOCK), 1, 'the rule went back in, once')
	assert.ok(existsSync(join(m.claude, 'skills', 'real-skill', 'SKILL.md')))
	assert.doesNotMatch(r.out, /kept \(already there\): CLAUDE\.md/)
	assert.doesNotMatch(md, /Global Claude Code Rules/, 'the starter heading is gone')
})

test('a new machine: a backup that already holds the rule, or a hand-written section of it, is not given a second one', () => {
	for (const [claudeMd, what] of [
		['# Mine\n\n<!-- workpulse-brain:start -->\nold rule\n<!-- workpulse-brain:end -->\n', /old rule/],
		['# Mine\n\n## WorkPulse Brain — by hand\nmine\n', /## WorkPulse Brain — by hand\nmine/],
	]) {
		const m = secondMachine(backedUp(claudeMd))
		assert.equal(m.setup().status, 0)
		const r = m.run('config', 'restore')
		assert.equal(r.status, 0, r.err)
		assert.equal(m.md(), claudeMd, 'exactly what was backed up')
		assert.match(m.md(), what)
	}
})

test('a CLAUDE.md with anything of the owner in it is kept without --force, and --force keeps the Brain rule', () => {
	const m = secondMachine(backedUp('# My real rules\n\nkeep me\n'))
	assert.equal(m.setup().status, 0)
	const mine = m.md().replace('# Global Claude Code Rules', '# Global Claude Code Rules\n\nwritten on this machine')
	writeFileSync(join(m.claude, 'CLAUDE.md'), mine)

	const r = m.run('config', 'restore')
	assert.equal(r.status, 0, r.err)
	assert.equal(m.md(), mine, 'not a starter file: it stays')
	assert.match(r.out, /kept \(already there\): CLAUDE\.md/)

	const f = m.run('config', 'restore', '--force')
	assert.equal(f.status, 0, f.err)
	assert.match(m.md(), /keep me/)
	assert.doesNotMatch(m.md(), /written on this machine/)
	assert.equal(count(m.md(), BLOCK), 1, '--force does not take the Brain rule away')
})

test('a CLAUDE.md that is a link is not read for the starter check and not written through', () => {
	const m = secondMachine(backedUp('# My real rules\n\nkeep me\n'))
	assert.equal(m.setup().status, 0)
	const elsewhere = join(m.home, 'elsewhere.md')
	writeFileSync(elsewhere, m.md())
	const before = m.md()
	rmSync(join(m.claude, 'CLAUDE.md'))
	symlinkSync(elsewhere, join(m.claude, 'CLAUDE.md'))
	const r = m.run('config', 'restore')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /kept \(already there\): CLAUDE\.md/)
	assert.equal(readFileSync(elsewhere, 'utf8'), before)
})

// ── final review: the key shapes the owner uses ─────────────────────────────

test('fileSecretsIn names the key shapes in use, bare and as assignments', () => {
	const fill = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5'
	for (const [text, name] of [
		[`sk_${fill}`, 'Secret key (sk_)'],
		[`ELEVENLABS_API_KEY=sk_${fill}`, 'Secret key (sk_)'],
		['rzp_live_AbCdEfGhIj12', 'Razorpay key'],
		['rzp_test_AbCdEfGhIj12', 'Razorpay key'],
		[`dop_v1_${'ab12'.repeat(10)}`, 'DigitalOcean token'],
		['CASHFREE_CLIENT_SECRET=cfsk_ma_prod_abc123-def', 'Cashfree key'],
		['API_KEY=abcd1234efgh5678ijkl', 'env secret'],
		['MY_SECRET="abcd1234efgh5678ijkl"', 'env secret'],
		["export GH_TOKEN = 'abcd1234efgh5678ijkl'", 'env secret'],
		['postgres://u:pass@host/db', 'URL with a password'],
		['mongodb+srv://me:s3cr3tvalue@cluster0.mongodb.net', 'URL with a password'],
		['redis://:s3cr3tvalue@host:6379', 'URL with a password'],
	]) assert.ok(fileSecretsIn(text).includes(name), `${text} → ${fileSecretsIn(text)}`)
})

test('fileSecretsIn leaves prose, placeholders and code references alone', () => {
	for (const ok of [
		'API_KEY=your_api_key_here',
		'TOKEN=$TOKEN',
		'TOKEN=${TOKEN}',
		'TOKEN=${GITHUB_PERSONAL_TOKEN}',
		'SECRET=<your secret>',
		'API_KEY=<your-api-key-goes-here>',
		'API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx',
		'API_KEY=short',
		'API_KEY=process.env.ANOTHER_API_KEY',
		'const API_KEY = getApiKeyFromEnvironment()',
		'TOKEN = settings.GITHUB_TOKEN_VALUE',
		'SECRET=/run/secrets/my_secret_file',
		'if [ "$TOKEN" == "abcd1234efgh5678ijkl" ]',
		'TOKEN=\nthe_next_line_is_not_its_value_at_all',
		'SECRET_KEY_NAME is abcd1234efgh5678ijkl',
		'postgres://user:password@host/db',
		'postgres://USER:PASSWORD@HOST:5432/DB',
		'postgres://user:your_password@host',
		'postgres://user:${DB_PASSWORD}@host',
		'postgres://${USER}:${PASS}@host',
		'postgres://$user:$pass@host',
		'postgres://<user>:<pass>@host',
		'postgres://%s:%s@%s/%s',
		'http://localhost:3000/@scope/package',
		'ssh://git@github.com:22/me/repo.git',
		'git@github.com:me/repo.git',
		'sk_short',
		'risk_assessmentframeworkforthewholeproject',
		'mask_abcdefghijklmnopqrstuvwxyz123456',
		'rzp_live_',
		'dop_v1_nothex',
		'cfsk_x',
	]) assert.deepEqual(fileSecretsIn(ok), [], ok)
})

test('config backup stops on the new shapes and never prints the value', () => {
	const { run, root } = brainSandbox({ config: { library: true } })
	const home = join(root, 'home')
	mkdirSync(join(home, '.claude'), { recursive: true })
	writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'DB=postgres://me:hunter2value@host/db\n')
	const r = run('config', 'backup', '--home', home)
	assert.notEqual(r.status, 0)
	assert.match(r.err, /CLAUDE\.md \(URL with a password\)/)
	assert.doesNotMatch(r.err + r.out, /hunter2value/)
})

// ── final review: an ignored file is not silently left out ──────────────────

test('config backup keeps a file a global gitignore matches: every path is explicit, and the count is the truth', () => {
	const box = brainSandbox({ config: { library: true } })
	const ignore = join(box.root, 'global-ignore')
	writeFileSync(ignore, 'build/\ndist/\n*.jsonl\ntranscript.md\n')
	const globalConfig = join(box.root, 'global-gitconfig')
	writeFileSync(globalConfig, `[core]\n\texcludesFile = ${ignore}\n`)
	const env = { GIT_CONFIG_GLOBAL: globalConfig }
	const home = join(box.root, 'home')
	const skill = join(home, '.claude', 'skills', 'real-skill')
	mkdirSync(join(skill, 'build'), { recursive: true })
	mkdirSync(join(skill, 'dist'), { recursive: true })
	writeFileSync(join(skill, 'SKILL.md'), '# skill\n')
	writeFileSync(join(skill, 'build', 'a.md'), 'a\n')
	writeFileSync(join(skill, 'dist', 'b.md'), 'b\n')

	const r = box.runWith(env, 'config', 'backup', '--home', home)
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /kept 3 files/)
	const onRemote = (ref = 'main') => box.git('-C', box.remote, 'ls-tree', '-r', '--name-only', ref).split('\n').filter((p) => p.startsWith('bridge/'))
	assert.deepEqual(onRemote().filter((p) => p.startsWith('bridge/config/')).sort(), ['bridge/config/cli-test/skills/real-skill/SKILL.md', 'bridge/config/cli-test/skills/real-skill/build/a.md', 'bridge/config/cli-test/skills/real-skill/dist/b.md'])

	const lib = box.runWith(env, 'library', 'add', learnedFolder(box.root, 'vid', { 'notes.md': 'n', 'transcript.md': 't' }), '--type', 'site')
	assert.equal(lib.status, 0, lib.err)
	assert.ok(onRemote().includes('bridge/library/site/vid/transcript.md'))

	const add = box.runWith(env, 'add', 'learning', 'An ignored file name is still written')
	assert.equal(add.status, 0, add.err)
	assert.ok(onRemote().some((p) => p.startsWith('bridge/entries/') && p.endsWith('.jsonl')))
})

// ── final review: small things ──────────────────────────────────────────────

test('init brings an older SCHEMA.md up to date, only that file', () => {
	const { run, clone, git, root } = brainSandbox()
	const doc = join(clone, 'bridge', 'SCHEMA.md')
	mkdirSync(dirname(doc), { recursive: true })
	writeFileSync(doc, '# bridge/\n\nold text\n')
	writeFileSync(join(clone, 'bridge', 'other.txt'), 'not ours\n')
	git('-C', clone, 'add', 'bridge/SCHEMA.md')
	git('-C', clone, 'commit', '-q', '-m', 'old schema')
	const r = run('init', 'test/brain', '--clone', clone, '--device', 'cli-test', '--no-push')
	assert.equal(r.status, 0, r.err)
	const text = readFileSync(doc, 'utf8')
	assert.match(text, /library\/<type>\/<folder>/)
	assert.match(text, /config\/<device>/)
	assert.match(text, /source \{ type/)
	assert.match(text, /hidden folders/)
	assert.match(text, /`rules\/` and `rule-files\/`/, 'the schema names the rule folders the backup keeps')
	assert.match(run('help').out + run('help').err, /RTK\.md, rules\/, rule-files\/ and the text of your skills/)
	assert.equal(git('-C', clone, 'show', '--name-only', '--format=', 'HEAD').trim(), 'bridge/SCHEMA.md')
	assert.equal(git('-C', clone, 'status', '--porcelain', '--', 'bridge/other.txt').trim(), '?? bridge/other.txt')
	const head = git('-C', clone, 'rev-parse', 'HEAD')
	assert.equal(run('init', 'test/brain', '--clone', clone, '--device', 'cli-test', '--no-push').status, 0)
	assert.equal(git('-C', clone, 'rev-parse', 'HEAD'), head, 'the same text makes no commit')
	assert.ok(root)
})

test('a folder owned by another device says how to go on: the old name, with the branch kept', () => {
	const box = brainSandbox({ config: { library: true, branch: 'main' } })
	const dir = learnedFolder(box.root, 'vid', { 'notes.md': 'n' })
	assert.equal(box.run('library', 'add', dir, '--type', 'site').status, 0)
	const cfg = JSON.parse(readFileSync(box.configPath, 'utf8'))
	writeFileSync(box.configPath, JSON.stringify({ ...cfg, device: 'cli-renamed' }))
	const r = box.run('library', 'add', dir, '--type', 'site')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /owned by cli-test/)
	assert.match(r.err, /wp-brain init test\/brain --branch main --device cli-test --clone /)
	assert.equal(box.run('init', 'test/brain', '--branch', 'main', '--device', 'cli-test', '--clone', box.clone).status, 0)
	const after = box.run('library', 'add', dir, '--type', 'site')
	assert.equal(after.status, 0, 'the way forward it names works: ' + after.err)
})

test('library add a second time carries the changed notes, and a third changes nothing', () => {
	const box = brainSandbox({ config: { library: true } })
	const dir = learnedFolder(box.root, 'vid', { 'notes.md': 'first' })
	assert.equal(box.run('library', 'add', dir, '--type', 'site').status, 0)
	writeFileSync(join(dir, 'notes.md'), 'first\n\n## Recorded in the Brain\n- [abcd1234]\n')
	assert.equal(box.run('library', 'add', dir, '--type', 'site').status, 0)
	assert.match(box.git('-C', box.remote, 'show', 'main:bridge/library/site/vid/notes.md'), /\[abcd1234\]/)
	const tip = box.git('-C', box.remote, 'rev-parse', 'main')
	assert.equal(box.run('library', 'add', dir, '--type', 'site').status, 0)
	assert.equal(box.git('-C', box.remote, 'rev-parse', 'main'), tip)
})

test('help lists the opt-in folders, what setup asks, and that edit takes a source', () => {
	const { run } = brainSandbox()
	const { out } = run('help')
	assert.match(out, /bridge\/library\/<type>\/<folder>\//)
	assert.match(out, /bridge\/config\/<device>\//)
	assert.match(out, /setup\s+asks .*text backup/)
	assert.match(out, /wp-brain edit ID [^\n]*\n\s*\[--source-type/)
})

// ── last fixes: configSkip, config scan, X placeholders, URL passwords, init pulls first ──

import { configFilesIn } from './library.mjs'

function skipHome(root) {
	const home = claudeHome(root)
	const claude = join(home, '.claude')
	mkdirSync(join(claude, 'skills', 'scaffold', 'template', 'deep'), { recursive: true })
	mkdirSync(join(claude, 'skills', 'scaffoldish'), { recursive: true })
	writeFileSync(join(claude, 'skills', 'scaffold', 'SKILL.md'), '# scaffold\n')
	writeFileSync(join(claude, 'skills', 'scaffold', 'template', 'a.md'), `key sk_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5'}\n`)
	writeFileSync(join(claude, 'skills', 'scaffold', 'template', 'deep', 'b.md'), 'fine\n')
	writeFileSync(join(claude, 'skills', 'scaffoldish', 'SKILL.md'), '# a neighbour\n')
	return home
}

test('configSkip matches whole path segments only and reports what it left out', () => {
	const { root } = brainSandbox()
	const claude = join(skipHome(root), '.claude')
	const { keep, skipped } = configFilesIn(claude, ['skills/scaffold/template'])
	const rels = keep.map((k) => k.rel)
	assert.ok(rels.includes('skills/scaffold/SKILL.md') && rels.includes('skills/scaffoldish/SKILL.md'))
	assert.ok(!rels.some((r) => r.startsWith('skills/scaffold/template')))
	assert.deepEqual(skipped.filter((s) => s.why === 'left out by configSkip').map((s) => s.rel).sort(), ['skills/scaffold/template/a.md', 'skills/scaffold/template/deep/b.md'])
	const near = configFilesIn(claude, ['skills/scaffold'])
	assert.ok(near.keep.some((k) => k.rel === 'skills/scaffoldish/SKILL.md'), 'skills/scaffold must not match skills/scaffoldish')
	assert.ok(!near.keep.some((k) => k.rel === 'skills/scaffold/SKILL.md'))
	// nothing widens: an empty, non-string or slash-only prefix matches nothing
	assert.equal(configFilesIn(claude, ['', '/', '.', 7, null]).keep.length, configFilesIn(claude).keep.length)
})

test('config backup leaves configSkip paths out without scanning them, and says so', () => {
	const { run, root, clone, git } = brainSandbox({ config: { library: true, configSkip: ['skills/scaffold/template'] } })
	const home = skipHome(root)
	const r = run('config', 'backup', '--home', home, '--no-push')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /left out by configSkip: skills\/scaffold\/template\/a\.md/)
	assert.match(r.out, /2 left out by configSkip/)
	assert.equal(existsSync(join(clone, 'bridge', 'config', 'cli-test', 'skills', 'scaffold', 'template')), false)
	assert.ok(existsSync(join(clone, 'bridge', 'config', 'cli-test', 'skills', 'scaffoldish', 'SKILL.md')))
	assert.ok(git('-C', clone, 'log', '--oneline').includes('config backup'))
})

test('config backup names up to 20 left-out files, then counts the rest', () => {
	const { run, root } = brainSandbox({ config: { library: true, configSkip: ['skills/bulk'] } })
	const home = claudeHome(root)
	mkdirSync(join(home, '.claude', 'skills', 'bulk'), { recursive: true })
	for (let i = 0; i < 25; i++) writeFileSync(join(home, '.claude', 'skills', 'bulk', `f${String(i).padStart(2, '0')}.md`), 'x')
	const r = run('config', 'backup', '--home', home, '--no-push')
	assert.equal(r.status, 0, r.err)
	assert.equal(r.out.split('\n').filter((l) => l.startsWith('left out by configSkip: skills/bulk/')).length, 20)
	assert.match(r.out, /left out by configSkip: …and 5 more/)
})

test('init keeps configSkip on a re-run, as it does library', () => {
	const { run, clone, configPath } = brainSandbox({ config: { library: true, configSkip: ['skills/x'] } })
	assert.equal(run('init', 'test/brain', '--clone', clone, '--device', 'cli-test', '--no-push').status, 0)
	const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
	assert.deepEqual(cfg.configSkip, ['skills/x'])
	assert.equal(cfg.library, true)
})

test('config scan reports hits as file and shape, writes nothing, needs no library, exits 1', () => {
	const { run, root, clone, remote, git } = brainSandbox({ config: { configSkip: ['skills/scaffold/template'] } })
	const home = skipHome(root)
	writeFileSync(join(home, '.claude', 'skills', 'real-skill', 'SKILL.md'), `token ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2'}\n`)
	const headC = git('-C', clone, 'rev-parse', 'HEAD')
	const headR = git('-C', remote, 'rev-parse', 'main')
	const r = run('config', 'scan', '--home', home)
	assert.equal(r.status, 1, r.err)
	assert.match(r.out, /skills\/real-skill\/SKILL\.md \(GitHub token\)/)
	assert.doesNotMatch(r.out + r.err, /ghp_a1B2/)
	assert.doesNotMatch(r.out, /template\/a\.md \(/, 'a configSkip file is never scanned')
	assert.equal(git('-C', clone, 'rev-parse', 'HEAD'), headC)
	assert.equal(git('-C', remote, 'rev-parse', 'main'), headR)
	assert.equal(existsSync(join(clone, 'bridge', 'config')), false)
	writeFileSync(join(home, '.claude', 'skills', 'real-skill', 'SKILL.md'), '# clean\n')
	const clean = run('config', 'scan', '--home', home)
	assert.equal(clean.status, 0, clean.err)
	assert.match(clean.out, /no secrets/i)
})

test('an X-only variable part is a placeholder, whichever shape matched', () => {
	const xs = 'X'.repeat(24)
	for (const ok of [`sk_${xs}`, `REVENUECAT_API_KEY=sk_${xs}`, `sk_live_${'x'.repeat(24)}`, `sk_test_${xs}`, `key: sk_${xs} here`]) assert.deepEqual(fileSecretsIn(ok), [], ok)
	const real = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5'
	assert.deepEqual(fileSecretsIn(`sk_${real}`), ['Secret key (sk_)'])
	assert.ok(fileSecretsIn(`REVENUECAT_API_KEY=sk_${real}`).includes('Secret key (sk_)'))
	assert.ok(fileSecretsIn(`sk_${real}XXXXXXXXXXXX`).includes('Secret key (sk_)'), 'X inside a real value does not hide it')
})

test('URL passwords: the password is judged as a whole value, not the user, not a substring', () => {
	for (const bad of ['postgres://admin:MyPassword123@host', 'postgres://example_app:r3alS3cretValue@host', 'postgres://u:pass@host/db'])
		assert.ok(fileSecretsIn(bad).includes('URL with a password'), bad)
	for (const ok of ['postgres://USER:PASS@HOST/db', 'postgres://[user]:[pass]@host', 'postgres://user:password@host', `docker://alpine:3.19@sha256:${'ab12'.repeat(16)}`])
		assert.deepEqual(fileSecretsIn(ok), [], ok)
})

test('env secrets: a config path or a variable name is not a secret, lowercase api_key and YAML are', () => {
	for (const ok of ['SECRET=config/secrets/app.json', 'GH_TOKEN=GITHUB_PERSONAL_ACCESS_TOKEN']) assert.deepEqual(fileSecretsIn(ok), [], ok)
	for (const bad of ['api_key=abcd1234efgh5678ijkl', 'API_KEY: abcd1234efgh5678ijkl', 'api_key: "abcd1234efgh5678ijkl"']) assert.ok(fileSecretsIn(bad).includes('env secret'), bad)
})

test('init pulls before it reads SCHEMA.md: a stale clone has no conflict (three different texts)', () => {
	const { run, clone, remote, git, root } = brainSandbox()
	const doc = join(clone, 'bridge', 'SCHEMA.md')
	mkdirSync(dirname(doc), { recursive: true })
	writeFileSync(doc, '# bridge/\n\nfirst text\n')
	git('-C', clone, 'add', 'bridge/SCHEMA.md')
	git('-C', clone, 'commit', '-q', '-m', 'first')
	git('-C', clone, 'push', '-q', 'origin', 'HEAD:main')
	const other = join(root, 'other')
	git('clone', '-q', remote, other)
	git('-C', other, 'config', 'user.email', 'o@example.com')
	git('-C', other, 'config', 'user.name', 'O')
	writeFileSync(join(other, 'bridge', 'SCHEMA.md'), '# bridge/\n\nsecond text\n')
	git('-C', other, 'commit', '-q', '-am', 'second')
	git('-C', other, 'push', '-q', 'origin', 'HEAD:main')
	const r = run('init', 'test/brain', '--clone', clone, '--device', 'cli-test')
	assert.equal(r.status, 0, r.err)
	const onRemote = git('-C', remote, 'show', 'main:bridge/SCHEMA.md')
	assert.match(onRemote, /library\/<type>\/<folder>/, 'the third text, the CLI\'s own, is on the remote')
	assert.doesNotMatch(onRemote, /first text|second text/)
	assert.equal(git('-C', clone, 'status', '--porcelain').trim(), '')
})

test('init skips a SCHEMA.md that is a folder instead of crashing', () => {
	const { run, clone, git } = brainSandbox()
	mkdirSync(join(clone, 'bridge', 'SCHEMA.md'), { recursive: true })
	writeFileSync(join(clone, 'bridge', 'SCHEMA.md', 'keep.txt'), 'mine\n')
	const head = git('-C', clone, 'rev-parse', 'HEAD')
	const r = run('init', 'test/brain', '--clone', clone, '--device', 'cli-test', '--no-push')
	assert.equal(r.status, 0, r.err)
	assert.equal(readFileSync(join(clone, 'bridge', 'SCHEMA.md', 'keep.txt'), 'utf8'), 'mine\n')
	assert.equal(git('-C', clone, 'rev-parse', 'HEAD'), head)
})

test('config scan on a folder that is not there says so and exits non-zero', () => {
	const { run, root } = brainSandbox()
	const missing = join(root, 'no-such-home')
	const r = run('config', 'scan', '--home', missing)
	assert.notEqual(r.status, 0)
	assert.match(r.err + r.out, /doesn't exist/)
	assert.ok((r.err + r.out).includes(join(missing, '.claude')))
	assert.doesNotMatch(r.out, /no secrets found/)
})
