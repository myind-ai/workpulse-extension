// node --test cli/vault-manifest.test.mjs
// Vault config, manifest and prune planning. Temp dirs only; no network, no real vault.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findOrphans, parseVaultConfig, readManifest, selectPrune, writeManifest } from './vault-manifest.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'vault-manifest-'))
const db = (release, date, extra = {}) => ({ id: `id-${release}`, kind: 'database', name: 'brain.db', size: 10, sha256: 'a'.repeat(64), date, release, encrypted: true, parts: [], verifiedAt: date, ...extra })
const NOW = Date.parse('2026-10-31T12:00:00Z')

test('parseVaultConfig: session memory brings its database, whichever was turned on first, and only while on', (t) => {
	const before = process.env.WP_MEMORY_DB
	process.env.WP_MEMORY_DB = '/tmp/fixture/memory.db'
	t.after(() => {
		if (before === undefined) delete process.env.WP_MEMORY_DB
		else process.env.WP_MEMORY_DB = before
	})
	const PACK = '/tmp/fixture/session-files.db'
	const vault = { repo: 'me/vault', databases: ['/d.db'] }
	assert.deepEqual(parseVaultConfig({ device: 'mac', memory: true, vault }).databases, ['/d.db', '/tmp/fixture/memory.db', PACK])
	assert.deepEqual(parseVaultConfig({ device: 'mac', memory: true, vault: { repo: 'me/vault' } }).databases, ['/tmp/fixture/memory.db', PACK])
	assert.deepEqual(parseVaultConfig({ device: 'mac', memory: true, vault: { repo: 'me/vault', databases: ['/tmp/fixture/memory.db', '/d.db'] } }).databases, ['/tmp/fixture/memory.db', '/d.db', PACK], 'listed by hand too: once')
	assert.deepEqual(parseVaultConfig({ device: 'mac', memory: true, vault: { repo: 'me/vault', databases: ['/tmp/fixture/memory.db', '/d.db'] } }).defaultDatabases, [PACK], 'only what the switch added can be missing quietly')
	assert.deepEqual(parseVaultConfig({ device: 'mac', backup: { claudeDocs: true, projectMemory: true }, vault: { repo: 'me/vault' } }).databases, ['/tmp/fixture/claude-docs.db', '/tmp/fixture/project-memory.db'], 'the owner\'s two switches')
	assert.deepEqual(parseVaultConfig({ device: 'mac', backup: { claudeDocs: 'yes' }, vault: { repo: 'me/vault' } }).databases, [], 'only true is on')
	assert.deepEqual(parseVaultConfig({ device: 'mac', vault }).databases, ['/d.db'], 'memory off')
	assert.deepEqual(parseVaultConfig({ device: 'mac', memory: 'true', vault }).databases, ['/d.db'], 'only true is on')
	assert.equal(parseVaultConfig({ device: 'mac', memory: true }), null, 'no vault stays no vault')
})

test('parseVaultConfig: absent, defaults, and bad values', () => {
	assert.equal(parseVaultConfig({}), null)
	const ok = parseVaultConfig({ device: 'mac', vault: { repo: 'me/vault', videos: ['/v'], databases: ['/d.db'] } })
	assert.deepEqual(ok, { repo: 'me/vault', device: 'mac', videos: ['/v'], databases: ['/d.db'], defaultDatabases: [], keep: { recent: 5, months: 3 }, keyBackedUpAt: null, keyBackedUpFp: null })
	assert.equal(parseVaultConfig({ device: 'a', vault: { repo: 'me/v', device: 'b', keyBackedUpAt: '2026-10-31' } }).device, 'b')
	assert.equal(parseVaultConfig({ device: 'a', vault: { repo: 'me/v', keyBackedUpAt: '2026-10-31' } }).keyBackedUpAt, '2026-10-31')
	assert.throws(() => parseVaultConfig({ device: 'a', vault: { repo: 'novault' } }), /repo/)
	assert.throws(() => parseVaultConfig({ vault: { repo: 'me/v', device: '../x' } }), /device/)
	assert.throws(() => parseVaultConfig({ device: 'a', vault: { repo: 'me/v', videos: ['rel/path'] } }), /absolute/)
	assert.throws(() => parseVaultConfig({ device: 'a', vault: { repo: 'me/v', databases: ['x.db'] } }), /absolute/)
})

test('parseVaultConfig: a device that could not be part of a git tag is refused before any upload', () => {
	for (const device of ['x.lock', 'a..b', '.mac', 'mac.']) {
		assert.throws(() => parseVaultConfig({ vault: { repo: 'me/v', device } }), /git tag/, device)
		assert.throws(() => parseVaultConfig({ device, vault: { repo: 'me/v' } }), /git tag/, device)
	}
	for (const device of ['mac', 'my.mac', 'mac-2_b', 'locks', 'a.locked']) assert.equal(parseVaultConfig({ device, vault: { repo: 'me/v' } }).device, device)
})

test('selectPrune: newest 5 plus newest of each of the last 3 months', () => {
	const dates = ['2026-06-10', '2026-07-05', '2026-08-02', '2026-08-20', '2026-09-03', '2026-09-25', '2026-10-10', '2026-10-20', '2026-10-30']
	const items = dates.map((d, i) => db(`snap-${i}`, `${d}T10:00:00Z`))
	const pruned = selectPrune(items, NOW, { recent: 5, months: 3 }).sort()
	// kept: newest 5 (idx 4..8) + newest Aug (idx 3) ; Sep and Oct are inside the newest 5
	assert.deepEqual(pruned, ['id-snap-0', 'id-snap-1', 'id-snap-2'])
})

test('selectPrune: one verified snapshot returns nothing; unverified is never the last good one', () => {
	assert.deepEqual(selectPrune([db('snap-1', '2026-10-01T00:00:00Z')], NOW, { recent: 0, months: 0 }), [])
	const old = db('snap-old', '2026-01-01T00:00:00Z')
	const bad = db('snap-bad', '2026-10-30T00:00:00Z', { verifiedAt: undefined })
	// the old verified snapshot is the only good one: kept even though outside every rule
	assert.deepEqual(selectPrune([old, bad], NOW, { recent: 0, months: 0 }), [])
	// an unverified snapshot older than the newest good one is pruned
	const stale = db('snap-stale', '2026-01-02T00:00:00Z', { verifiedAt: undefined })
	const good = db('snap-good', '2026-10-30T00:00:00Z')
	assert.deepEqual(selectPrune([stale, good], NOW, { recent: 1, months: 0 }), ['id-snap-stale'])
})

test('selectPrune: items of one release are one snapshot, kept or pruned whole', () => {
	const mk = (r, d, n) => db(r, d, { id: `${r}-${n}`, name: `${n}.db` })
	const items = [mk('snap-a', '2026-01-01T00:00:00Z', 1), mk('snap-a', '2026-01-01T00:00:00Z', 2), mk('snap-b', '2026-10-01T00:00:00Z', 1), mk('snap-b', '2026-10-01T00:00:00Z', 2)]
	assert.deepEqual(selectPrune(items, NOW, { recent: 1, months: 0 }).sort(), ['snap-a-1', 'snap-a-2'])
	// one unverified member makes the whole snapshot unverified
	const half = [mk('snap-b', '2026-01-01T00:00:00Z', 1), { ...mk('snap-b', '2026-01-01T00:00:00Z', 2), verifiedAt: undefined }, mk('snap-a', '2026-10-01T00:00:00Z', 1)]
	assert.deepEqual(selectPrune(half, NOW, { recent: 0, months: 0 }).sort(), ['snap-b-1', 'snap-b-2'])
})

test('selectPrune: videos are never returned', () => {
	const v = { id: 'v1', kind: 'video', name: 'a.mp4', size: 1, sha256: 'b'.repeat(64), date: '2020-01-01T00:00:00Z', release: 'videos-0001', encrypted: false, parts: [], verifiedAt: '2020-01-01T00:00:00Z' }
	assert.deepEqual(selectPrune([v, db('snap-1', '2026-10-01T00:00:00Z')], NOW, { recent: 0, months: 0 }), [])
})

test('findOrphans: snap- release in no manifest and older than 24h', () => {
	const old = new Date(NOW - 25 * 3600e3).toISOString()
	const young = new Date(NOW - 3600e3).toISOString()
	const releases = [
		{ tagName: 'snap-known', createdAt: old },
		{ tagName: 'snap-orphan', createdAt: old },
		{ tagName: 'snap-young', createdAt: young },
		{ tagName: 'videos-0001', createdAt: old },
	]
	const manifests = [{ version: 1, device: 'a', items: [db('snap-known', old)] }, { version: 1, device: 'b', items: [] }]
	assert.deepEqual(findOrphans(releases, manifests, NOW), ['snap-orphan'])
})

test('manifest: round trip, stable key order, no stray temp file', () => {
	const dir = tmp()
	const p = join(dir, 'm.json')
	const item = { verifiedAt: 'v', parts: [{ sha256: 'h', size: 1, asset: 'x' }], release: 'snap-1', encrypted: false, date: 'd', sha256: 's', size: 3, name: 'n.mp4', kind: 'video', id: 'i1' }
	writeManifest(p, { items: [item], device: 'mac', version: 1 })
	const text = readFileSync(p, 'utf8')
	assert.deepEqual(Object.keys(JSON.parse(text)), ['version', 'device', 'items'])
	assert.deepEqual(Object.keys(JSON.parse(text).items[0]).slice(0, 4), ['id', 'kind', 'name', 'size'])
	assert.deepEqual(readManifest(p).items[0].parts[0], { asset: 'x', size: 1, sha256: 'h' })
	assert.deepEqual(readdirSync(dir), ['m.json'])
	assert.equal(readManifest(join(dir, 'missing.json')), null)
})

test('manifest: a secret-shaped name throws naming id and kind, never the value', () => {
	const dir = tmp()
	const p = join(dir, 'm.json')
	const token = 'ghp_' + 'a1B2c3D4e5'.repeat(4).slice(0, 36)
	const m = { version: 1, device: 'mac', items: [db('snap-1', '2026-10-01T00:00:00Z', { id: 'item-77', name: token })] }
	assert.throws(() => writeManifest(p, m), (e) => /item-77/.test(e.message) && /database/.test(e.message) && !e.message.includes(token) && !e.message.includes('ghp_'))
	assert.equal(existsSync(p), false)
	assert.deepEqual(readdirSync(dir), [])
})

test('manifest: names must be bare filenames (write and read)', () => {
	const dir = tmp()
	const p = join(dir, 'm.json')
	for (const name of ['a/b.mp4', 'a\\b.mp4', '.', '..', 'a\0b', '']) {
		assert.throws(() => writeManifest(p, { version: 1, device: 'mac', items: [db('snap-1', '2026-10-01T00:00:00Z', { name })] }), /bare filename/)
	}
	writeManifest(p, { version: 1, device: 'mac', items: [db('snap-1', '2026-10-01T00:00:00Z', { name: 'मेरा वीडियो é.mp4' })] })
	assert.equal(readManifest(p).items[0].name, 'मेरा वीडियो é.mp4')
	const bad = { version: 1, device: 'mac', items: [db('snap-1', '2026-10-01T00:00:00Z', { name: '../etc/passwd' })] }
	writeFileSync(p, JSON.stringify(bad))
	assert.throws(() => readManifest(p), /bare filename/)
})
