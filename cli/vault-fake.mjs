// A folder-backed Storage for tests: one folder per release, assets inside. No network, no gh.
// Same contract as githubStorage in vault-storage.mjs (see the Storage description there).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** GitHub refuses an asset at or over 2 GiB. */
export const MAX_ASSET_BYTES = 2 * 1024 ** 3

const bare = (s, what) => {
	if (typeof s !== 'string' || !s || s === '.' || s === '..' || /[\\/\0]/.test(s)) throw new Error(`${what} must be a bare name`)
	return s
}

export function fakeStorage(dir, { failPuts = 0, failPutsAfter = null, corruptAsset = null, maxAssetBytes = MAX_ASSET_BYTES } = {}) {
	mkdirSync(dir, { recursive: true })
	let puts = 0
	let failuresLeft = failPuts
	const rel = tag => join(dir, bare(tag, 'tag'))
	const metaOf = tag => {
		const p = join(rel(tag), 'release.json')
		if (!existsSync(p)) throw new Error(`release ${tag} not found`)
		return { path: p, ...JSON.parse(readFileSync(p, 'utf8')) }
	}
	return {
		async createRelease(tag, { draft = true } = {}) {
			if (existsSync(rel(tag))) return
			mkdirSync(join(rel(tag), 'assets'), { recursive: true })
			writeFileSync(join(rel(tag), 'release.json'), JSON.stringify({ draft: !!draft, createdAt: new Date().toISOString() }))
		},
		async publishRelease(tag) {
			const m = metaOf(tag)
			writeFileSync(m.path, JSON.stringify({ draft: false, createdAt: m.createdAt }))
		},
		async deleteRelease(tag) {
			rmSync(rel(tag), { recursive: true, force: true })
		},
		async listReleases() {
			return readdirSync(dir, { withFileTypes: true })
				.filter(e => e.isDirectory() && existsSync(join(dir, e.name, 'release.json')))
				.map(e => {
					const m = JSON.parse(readFileSync(join(dir, e.name, 'release.json'), 'utf8'))
					return { tag: e.name, draft: m.draft, createdAt: m.createdAt }
				})
		},
		async listAssets(tag) {
			metaOf(tag)
			return readdirSync(join(rel(tag), 'assets')).map(name => ({ name, size: statSync(join(rel(tag), 'assets', name)).size }))
		},
		async putAsset(tag, localPath, name) {
			metaOf(tag)
			bare(name, 'asset name')
			puts++
			if (failuresLeft > 0) {
				failuresLeft--
				throw new Error(`HTTP 503: fake upload of ${name} failed`)
			}
			if (failPutsAfter !== null && puts > failPutsAfter) throw new Error(`HTTP 503: fake upload of ${name} failed`)
			if (statSync(localPath).size >= maxAssetBytes) throw new Error(`asset ${name} is too large: a release asset must be under ${maxAssetBytes} bytes`)
			const dest = join(rel(tag), 'assets', name)
			copyFileSync(localPath, `${dest}.partial`)
			renameSync(`${dest}.partial`, dest)
		},
		async getAsset(tag, name, destDir) {
			metaOf(tag)
			bare(name, 'asset name')
			const src = join(rel(tag), 'assets', name)
			if (!existsSync(src)) throw new Error(`asset ${name} not found in release ${tag}`)
			mkdirSync(destDir, { recursive: true })
			const dest = join(destDir, name)
			const bytes = readFileSync(src)
			if (name === corruptAsset && bytes.length) bytes[Math.floor(bytes.length / 2)] ^= 0xff
			writeFileSync(dest, bytes)
			return dest
		},
	}
}
