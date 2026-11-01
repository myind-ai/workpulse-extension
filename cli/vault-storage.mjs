// The vault's storage adapter. Everything else in the vault takes a Storage and never mentions GitHub:
//   createRelease(tag, { draft }) idempotent · publishRelease(tag) · deleteRelease(tag) · listReleases() -> { tag, draft, createdAt }[]
//   listAssets(tag) -> { name, size }[] · putAsset(tag, localPath, name) replaces a same-name asset · getAsset(tag, name, destDir) -> path
// githubStorage is the only place that knows `gh`. The runner is injected (tests always pass a stub) and the real one loads lazily.
import { existsSync, linkSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export { fakeStorage } from './vault-fake.mjs'

/** The real runner, loaded on first use so that importing this module does nothing. */
async function execGh(cmd, args) {
	const { execFile } = await import('node:child_process')
	const { promisify } = await import('node:util')
	const { stdout } = await promisify(execFile)(cmd, args, { maxBuffer: 64 * 1024 * 1024 })
	return { stdout }
}

/** Timeouts, resets, 5xx and rate limits are worth another try; not found and permission are not. The words are Node's and gh's (Go's net package): the Go ones are from memory, not seen on a real failure. */
export function isNetworkFailure(err) {
	const text = `${err?.message ?? ''} ${err?.stderr ?? ''}`
	if (/\b(404|403|401|422)\b|not found|permission|forbidden|unauthorized|bad credentials|already exists/i.test(text) && !/rate limit/i.test(text)) return false
	return /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|HTTP 5\d\d|\b50[0-4]\b|rate limit|temporarily unavailable|TLS handshake|connection reset|no such host|\bEOF\b/i.test(text)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const said = err => `${err?.stderr || err?.message || err}`.trim()

export function githubStorage(repo, { run = execGh, retries = 3, backoffMs = 2000 } = {}) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('repo must look like owner/name')
	const gh = args => run('gh', args)
	const R = ['-R', repo]
	// gh would read a leading dash as a flag; -p is a glob, so asset names to match must have no glob characters.
	const arg = (v, what) => {
		if (typeof v !== 'string' || !v || v.startsWith('-')) throw new Error(`${what} must not be empty or start with "-"`)
		return v
	}
	const plainName = name => {
		arg(name, 'asset name')
		if (/[*?[\]{}]/.test(name)) throw new Error('asset name must not contain glob characters (*?[]{})')
		return name
	}

	async function attempt(label, fn) {
		let last
		for (let i = 1; i <= retries; i++) {
			try {
				return await fn()
			} catch (err) {
				last = err
				if (!isNetworkFailure(err)) throw new Error(`${label}: ${said(err)}`)
				if (i < retries) await sleep(backoffMs * i)
			}
		}
		throw new Error(`${label}: failed after ${retries} attempts: ${said(last)}`)
	}

	async function viewRelease(tag, label) {
		const { stdout } = await attempt(label, () => gh(['release', 'view', tag, ...R, '--json', 'assets,isDraft']))
		return JSON.parse(stdout)
	}

	return {
		async createRelease(tag, { draft = true } = {}) {
			arg(tag, 'tag')
			// A draft holds no git tag, so GitHub does not reject a second draft with the same tag: look first.
			if ((await this.listReleases()).some(r => r.tag === tag)) return
			try {
				await attempt(`create release ${tag}`, () =>
					gh(['release', 'create', tag, ...R, ...(draft ? ['--draft'] : []), '--title', tag, '--notes', 'WorkPulse vault']))
			} catch (err) {
				if (!/already exists/i.test(err.message)) throw err
			}
		},
		async publishRelease(tag) {
			arg(tag, 'tag')
			await attempt(`publish release ${tag}`, () => gh(['release', 'edit', tag, ...R, '--draft=false']))
		},
		async deleteRelease(tag) {
			arg(tag, 'tag')
			try {
				await attempt(`delete release ${tag}`, () => gh(['release', 'delete', tag, ...R, '--yes', '--cleanup-tag']))
			} catch (err) {
				if (!/not found/i.test(err.message)) throw err
			}
		},
		async listReleases() {
			const { stdout } = await attempt('list releases', () =>
				gh(['release', 'list', ...R, '--limit', '1000', '--json', 'tagName,isDraft,createdAt']))
			return JSON.parse(stdout).map(r => ({ tag: r.tagName, draft: !!r.isDraft, createdAt: r.createdAt }))
		},
		async listAssets(tag) {
			arg(tag, 'tag')
			let j
			try {
				j = await viewRelease(tag, `list assets of ${tag}`)
			} catch (err) {
				throw new Error(/not found/i.test(err.message) ? `release ${tag} not found` : err.message)
			}
			return (j.assets ?? []).map(a => ({ name: a.name, size: a.size }))
		},
		async putAsset(tag, localPath, name) {
			arg(tag, 'tag')
			arg(localPath, 'local path')
			plainName(name)
			if (!name || /[\\/\0#]/.test(name) || name === '.' || name === '..') throw new Error('asset name must be a bare filename without #')
			// gh names the asset after the file's basename and reads `#` as a label separator.
			let tmp = null
			let file = localPath
			if (basename(localPath) !== name || localPath.includes('#')) {
				tmp = mkdtempSync(join(tmpdir(), 'vault-up-'))
				file = join(tmp, name)
				try { linkSync(localPath, file) } catch { symlinkSync(localPath, file) }
			}
			try {
				await attempt(`upload ${name} to ${tag}`, () => gh(['release', 'upload', tag, file, ...R, '--clobber']))
			} finally {
				if (tmp) rmSync(tmp, { recursive: true, force: true })
			}
		},
		async getAsset(tag, name, destDir) {
			arg(tag, 'tag')
			plainName(name)
			arg(destDir, 'destination')
			await attempt(`download ${name} from ${tag}`, () =>
				gh(['release', 'download', tag, ...R, '-p', name, '-D', destDir, '--clobber']))
			const dest = join(destDir, name)
			if (!existsSync(dest)) throw new Error(`download ${name} from ${tag}: no such asset`)
			return dest
		},
	}
}
