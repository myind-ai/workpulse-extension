import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { MAX_ASSET_BYTES } from './vault-fake.mjs'
import { fakeStorage, githubStorage, isNetworkFailure } from './vault-storage.mjs'

const root = mkdtempSync(join(tmpdir(), 'vault-storage-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const tmp = () => mkdtempSync(join(root, `t${n++}-`))
const file = (name, bytes) => {
	const p = join(tmp(), name)
	writeFileSync(p, bytes)
	return p
}

/** A recording stub: never gh. Replies come from `reply(args)` (value, or throws). */
function stub(reply = () => ({ stdout: '' })) {
	const calls = []
	const run = async (cmd, args) => {
		calls.push([cmd, ...args])
		return reply(args, calls)
	}
	return { run, calls }
}

/** A stateful stub gh that keeps releases in a folder, to run the shared contract against githubStorage. */
function ghFolder() {
	const dir = tmp()
	const calls = []
	const need = tag => {
		if (!existsSync(join(dir, tag))) throw new Error('release not found')
		return JSON.parse(readFileSync(join(dir, tag, 'meta.json'), 'utf8'))
	}
	const flag = (a, f) => a[a.indexOf(f) + 1]
	const run = async (cmd, a) => {
		calls.push([cmd, ...a])
		assert.equal(cmd, 'gh')
		assert.equal(a[0], 'release')
		const tag = a[2]
		switch (a[1]) {
			case 'create':
				// Like GitHub: a published tag is refused, but a second draft with the same tag is silently allowed.
				if (existsSync(join(dir, tag))) {
					const m = need(tag)
					if (!m.draft) throw new Error('release already exists')
					writeFileSync(join(dir, tag, 'meta.json'), JSON.stringify({ ...m, copies: (m.copies ?? 1) + 1 }))
					return { stdout: '' }
				}
				mkdirSync(join(dir, tag, 'assets'), { recursive: true })
				writeFileSync(join(dir, tag, 'meta.json'), JSON.stringify({ draft: a.includes('--draft'), createdAt: '2026-10-31T00:00:00Z', copies: 1 }))
				return { stdout: '' }
			case 'edit': {
				const m = need(tag)
				writeFileSync(join(dir, tag, 'meta.json'), JSON.stringify({ ...m, draft: false }))
				return { stdout: '' }
			}
			case 'delete':
				need(tag)
				rmSync(join(dir, tag), { recursive: true })
				return { stdout: '' }
			case 'list':
				return {
					stdout: JSON.stringify(
						readdirSync(dir).flatMap(t =>
							Array.from({ length: need(t).copies ?? 1 }, () => ({ tagName: t, isDraft: need(t).draft, createdAt: need(t).createdAt })),
						),
					),
				}
			case 'view': {
				const m = need(tag)
				const assets = readdirSync(join(dir, tag, 'assets')).map(name => ({ name, size: statSync(join(dir, tag, 'assets', name)).size }))
				return { stdout: JSON.stringify({ isDraft: m.draft, assets }) }
			}
			case 'upload': {
				need(tag)
				assert.ok(a.includes('--clobber'))
				copyFileSync(a[3], join(dir, tag, 'assets', a[3].split('/').pop()))
				return { stdout: '' }
			}
			case 'download': {
				need(tag)
				const src = join(dir, tag, 'assets', flag(a, '-p'))
				if (!existsSync(src)) throw new Error('no assets match the file pattern')
				copyFileSync(src, join(flag(a, '-D'), flag(a, '-p')))
				return { stdout: '' }
			}
		}
		throw new Error(`unexpected ${a.join(' ')}`)
	}
	return { run, calls }
}

describe('githubStorage argument lists', () => {
	const repo = 'me/vault'
	const LIST = ['gh', 'release', 'list', '-R', repo, '--limit', '1000', '--json', 'tagName,isDraft,createdAt']
	test('release verbs', async () => {
		const s = stub(() => ({ stdout: JSON.stringify([{ tagName: 'v1', isDraft: true, createdAt: 'x' }]) }))
		const g = githubStorage(repo, { run: s.run, backoffMs: 0 })
		await g.createRelease('v3', { draft: true })
		await g.createRelease('v2', { draft: false })
		await g.publishRelease('v1')
		await g.deleteRelease('v1')
		assert.deepEqual(await g.listReleases(), [{ tag: 'v1', draft: true, createdAt: 'x' }])
		assert.deepEqual(s.calls, [
			LIST,
			['gh', 'release', 'create', 'v3', '-R', repo, '--draft', '--title', 'v3', '--notes', 'WorkPulse vault'],
			LIST,
			['gh', 'release', 'create', 'v2', '-R', repo, '--title', 'v2', '--notes', 'WorkPulse vault'],
			['gh', 'release', 'edit', 'v1', '-R', repo, '--draft=false'],
			['gh', 'release', 'delete', 'v1', '-R', repo, '--yes', '--cleanup-tag'],
			LIST,
		])
	})
	test('assets: view, upload with clobber, download', async () => {
		const s = stub(a => (a[1] === 'view' ? { stdout: JSON.stringify({ isDraft: true, assets: [{ name: 'a', size: 3, url: 'u' }] }) } : { stdout: '' }))
		const g = githubStorage(repo, { run: s.run, backoffMs: 0 })
		assert.deepEqual(await g.listAssets('v1'), [{ name: 'a', size: 3 }])
		const f = file('a', 'abc')
		await g.putAsset('v1', f, 'a')
		const dest = tmp()
		writeFileSync(join(dest, 'a'), 'x')
		assert.equal(await g.getAsset('v1', 'a', dest), join(dest, 'a'))
		assert.deepEqual(s.calls, [
			['gh', 'release', 'view', 'v1', '-R', repo, '--json', 'assets,isDraft'],
			['gh', 'release', 'upload', 'v1', f, '-R', repo, '--clobber'],
			['gh', 'release', 'download', 'v1', '-R', repo, '-p', 'a', '-D', dest, '--clobber'],
		])
	})
	test('an upload whose basename differs from the name, or whose path has #, goes through a temp link that is cleaned up', async () => {
		const seen = []
		const s = stub(a => {
			seen.push([a[3], readFileSync(a[3], 'utf8')])
			return { stdout: '' }
		})
		const g = githubStorage('me/vault', { run: s.run })
		await g.putAsset('v1', file('local.bin', 'one'), 'part-001')
		const hashDir = join(tmp(), 'a#b')
		mkdirSync(hashDir)
		writeFileSync(join(hashDir, 'p'), 'two')
		await g.putAsset('v1', join(hashDir, 'p'), 'p')
		for (const [p] of seen) {
			assert.ok(!p.includes('#'))
			assert.ok(!existsSync(p))
		}
		assert.deepEqual(seen.map(x => [x[0].split('/').pop(), x[1]]), [['part-001', 'one'], ['p', 'two']])
		await assert.rejects(g.putAsset('v1', file('x', '1'), 'a#b'), /bare filename/)
	})
	test('listAssets on a missing release is a clear error; delete of a missing release is fine', async () => {
		const g = githubStorage('me/vault', {
			run: stub(() => {
				throw new Error('release not found')
			}).run,
			backoffMs: 0,
		})
		await assert.rejects(g.listAssets('nope'), /release nope not found/)
		await g.deleteRelease('nope')
	})
	test('createRelease is idempotent when a published release already exists', async () => {
		const g = githubStorage('me/vault', {
			run: stub(a => {
				if (a[1] === 'list') return { stdout: '[]' }
				throw new Error('HTTP 422: Validation Failed: tag_name already_exists / release already exists')
			}).run,
		})
		await g.createRelease('v1')
	})
	test('createRelease does not create when the tag is already listed (a draft has no git tag)', async () => {
		const s = stub(() => ({ stdout: JSON.stringify([{ tagName: 'v1', isDraft: true, createdAt: 'x' }]) }))
		await githubStorage('me/vault', { run: s.run }).createRelease('v1', { draft: true })
		assert.deepEqual(s.calls.map(c => c[2]), ['list'])
	})
	test('a tag, local path, destination or name starting with "-" is refused; glob characters in a name too', async () => {
		const s = stub()
		const g = githubStorage('me/vault', { run: s.run })
		const f = file('a', '1')
		await assert.rejects(g.createRelease('--web'), /must not/)
		await assert.rejects(g.publishRelease('-x'), /must not/)
		await assert.rejects(g.deleteRelease('-x'), /must not/)
		await assert.rejects(g.listAssets('-x'), /must not/)
		await assert.rejects(g.putAsset('-x', f, 'a'), /must not/)
		await assert.rejects(g.putAsset('v1', '-file', 'a'), /must not/)
		await assert.rejects(g.putAsset('v1', f, '-a'), /must not/)
		await assert.rejects(g.getAsset('v1', '-a', tmp()), /must not/)
		await assert.rejects(g.getAsset('v1', 'a', '-d'), /must not/)
		for (const bad of ['a*', 'a?', 'a[1]', 'a{b}', 'a]']) {
			await assert.rejects(g.putAsset('v1', f, bad), /glob/, bad)
			await assert.rejects(g.getAsset('v1', bad, tmp()), /glob/, bad)
		}
		assert.equal(s.calls.length, 0)
	})
	test('a bad repo name is refused and importing runs nothing', () => {
		assert.throws(() => githubStorage('nope'), /owner\/name/)
	})
})

describe('githubStorage retries', () => {
	test('two timeouts then success: retried and succeeds', async () => {
		let k = 0
		const s = stub(() => {
			if (++k <= 2) throw new Error('Post "https://uploads.github.com": context deadline exceeded: i/o timeout')
			return { stdout: '' }
		})
		await githubStorage('me/vault', { run: s.run, backoffMs: 0 }).putAsset('v1', file('a', '1'), 'a')
		assert.equal(s.calls.length, 3)
	})
	test('5xx and rate limits are retried', async () => {
		for (const msg of ['HTTP 502: Bad Gateway', 'API rate limit exceeded', 'HTTP 403: secondary rate limit']) {
			let k = 0
			const s = stub(() => {
				if (++k === 1) throw new Error(msg)
				return { stdout: '' }
			})
			await githubStorage('me/vault', { run: s.run, backoffMs: 0 }).publishRelease('v1')
			assert.equal(s.calls.length, 2, msg)
		}
	})
	test('HTTP 404 and permission errors are not retried', async () => {
		for (const msg of ['HTTP 404: Not Found', 'HTTP 403: Resource not accessible (permission denied)']) {
			const s = stub(() => {
				throw new Error(msg)
			})
			await assert.rejects(githubStorage('me/vault', { run: s.run, backoffMs: 0 }).putAsset('v1', file('a', '1'), 'a'), /upload a to v1/)
			assert.equal(s.calls.length, 1, msg)
		}
	})
	test("gh is written in Go, and its words for a network failure count, in the message or in stderr", async () => {
		const said = ['connection reset by peer', 'EOF', 'no such host', 'i/o timeout', 'TLS handshake timeout', 'unexpected EOF']
		const full = {
			'connection reset by peer': 'Post "https://uploads.github.com/x": read tcp 192.168.1.2:50000->140.82.113.5:443: read: connection reset by peer',
			EOF: 'Get "https://api.github.com/x": EOF',
			'no such host': 'dial tcp: lookup api.github.com: no such host',
			'i/o timeout': 'dial tcp 140.82.113.5:443: i/o timeout',
			'TLS handshake timeout': 'Post "https://uploads.github.com/x": net/http: TLS handshake timeout',
			'unexpected EOF': 'Post "https://uploads.github.com/x": unexpected EOF',
		}
		for (const text of said) {
			assert.equal(isNetworkFailure(new Error(full[text])), true, text)
			assert.equal(isNetworkFailure(Object.assign(new Error('Command failed: gh'), { stderr: full[text] })), true, `${text} in stderr`)
			let k = 0
			const s = stub(() => {
				if (++k === 1) throw Object.assign(new Error('Command failed: gh'), { stderr: full[text] })
				return { stdout: '' }
			})
			await githubStorage('me/vault', { run: s.run, backoffMs: 0 }).publishRelease('v1')
			assert.equal(s.calls.length, 2, text)
		}
	})
	test('EOF counts only as a word, and a refusal that mentions one stays a refusal', () => {
		for (const text of ['GEOFENCE rule', 'EOFX', 'no eofs here', 'HTTP 404: Not Found: EOF', 'HTTP 403: permission denied: unexpected EOF']) assert.equal(isNetworkFailure(new Error(text)), false, text)
	})
	test('after 3 failures the error says which asset and how many attempts', async () => {
		const s = stub(() => {
			throw new Error('connection reset: ECONNRESET')
		})
		await assert.rejects(
			githubStorage('me/vault', { run: s.run, backoffMs: 0 }).putAsset('v1', file('part-002', '1'), 'part-002'),
			/upload part-002 to v1: failed after 3 attempts/,
		)
		assert.equal(s.calls.length, 3)
	})
})

describe('fakeStorage', () => {
	test('rejects an asset at or over the cap, accepts one under it', async () => {
		const f = fakeStorage(tmp(), { maxAssetBytes: 10 })
		await f.createRelease('v1')
		await assert.rejects(f.putAsset('v1', file('a', Buffer.alloc(10)), 'a'), /too large/)
		await f.putAsset('v1', file('b', Buffer.alloc(9)), 'b')
		assert.deepEqual(await f.listAssets('v1'), [{ name: 'b', size: 9 }])
		assert.equal(MAX_ASSET_BYTES, 2 * 1024 ** 3)
	})
	test('failPuts: 2 fails the first two puts only', async () => {
		const f = fakeStorage(tmp(), { failPuts: 2 })
		await f.createRelease('v1')
		const p = file('a', '1')
		await assert.rejects(f.putAsset('v1', p, 'a'))
		await assert.rejects(f.putAsset('v1', p, 'a'))
		await f.putAsset('v1', p, 'a')
		await f.putAsset('v1', p, 'b')
		assert.equal((await f.listAssets('v1')).length, 2)
	})
	test('failPutsAfter: 1 lets the first put through and fails the rest', async () => {
		const f = fakeStorage(tmp(), { failPutsAfter: 1 })
		await f.createRelease('v1')
		const p = file('a', '1')
		await f.putAsset('v1', p, 'a')
		await assert.rejects(f.putAsset('v1', p, 'b'))
		await assert.rejects(f.putAsset('v1', p, 'c'))
		assert.deepEqual((await f.listAssets('v1')).map(a => a.name), ['a'])
	})
	test('corruptAsset makes getAsset return different bytes', async () => {
		const f = fakeStorage(tmp(), { corruptAsset: 'bad' })
		await f.createRelease('v1')
		const p = file('x', 'hello world')
		await f.putAsset('v1', p, 'bad')
		await f.putAsset('v1', p, 'good')
		const out = tmp()
		assert.notEqual(readFileSync(await f.getAsset('v1', 'bad', out), 'utf8'), 'hello world')
		assert.equal(readFileSync(await f.getAsset('v1', 'good', out), 'utf8'), 'hello world')
	})
	test('bare names only; missing release is a clear error', async () => {
		const f = fakeStorage(tmp())
		await assert.rejects(f.createRelease('../x'), /bare name/)
		await assert.rejects(f.listAssets('nope'), /not found/)
	})
})

const makers = {
	fakeStorage: () => ({ s: fakeStorage(tmp()) }),
	'githubStorage (stub gh)': () => {
		const g = ghFolder()
		return { s: githubStorage('me/vault', { run: g.run, backoffMs: 0 }), calls: g.calls }
	},
}
for (const [label, make] of Object.entries(makers)) {
	describe(`Storage contract: ${label}`, () => {
		test('create, put, list, replace, get, publish, delete behave the same', async () => {
			const { s } = make()
			await s.createRelease('videos-0001', { draft: true })
			await s.createRelease('videos-0001', { draft: true }) // idempotent, also while still a draft
			await s.createRelease('videos-0001', { draft: true })
			assert.deepEqual((await s.listReleases()).map(r => [r.tag, r.draft]), [['videos-0001', true]])
			assert.equal(typeof (await s.listReleases())[0].createdAt, 'string')
			assert.deepEqual(await s.listAssets('videos-0001'), [])

			await s.putAsset('videos-0001', file('one.bin', 'first'), 'part-001')
			await s.putAsset('videos-0001', file('two.bin', 'x'), 'part-002')
			const sorted = a => [...a].sort((x, y) => x.name.localeCompare(y.name))
			assert.deepEqual(sorted(await s.listAssets('videos-0001')), [{ name: 'part-001', size: 5 }, { name: 'part-002', size: 1 }])

			await s.putAsset('videos-0001', file('again.bin', 'replaced!'), 'part-001') // replaces the same name
			assert.deepEqual(sorted(await s.listAssets('videos-0001')), [{ name: 'part-001', size: 9 }, { name: 'part-002', size: 1 }])

			const out = tmp()
			const got = await s.getAsset('videos-0001', 'part-001', out)
			assert.equal(got, join(out, 'part-001'))
			assert.equal(readFileSync(got, 'utf8'), 'replaced!')

			await s.publishRelease('videos-0001')
			assert.equal((await s.listReleases())[0].draft, false)

			await s.deleteRelease('videos-0001')
			assert.deepEqual(await s.listReleases(), [])
			await assert.rejects(s.listAssets('videos-0001'), /not found/)
			await s.deleteRelease('videos-0001') // already gone is fine
		})
		test('a missing asset is an error', async () => {
			const { s } = make()
			await s.createRelease('t')
			await assert.rejects(s.getAsset('t', 'nope', tmp()))
		})
	})
}
