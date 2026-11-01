// GitHub played by a local process, and the browser that talks to it. Shared by
// the Brain demo and the One Learning Place checks.
//
// Nothing leaves the machine: api.github.com is answered inside the browser
// (ctx.route), from an in-memory copy of a bridge/ folder. The built extension
// then really syncs it (conditional tree read, blob fetch) and really writes
// (git data API commit). Each run uses a throwaway profile, deleted at the end.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { chromium } from 'playwright'

export const EXT = resolve('.output/chrome-mv3')

/** Real GitHub instead of the stand-in, when WP_GH_REPO and WP_GH_TOKEN are set. */
export const REAL = process.env.WP_GH_REPO && process.env.WP_GH_TOKEN ? { repo: process.env.WP_GH_REPO, branch: process.env.WP_GH_BRANCH ?? '', token: process.env.WP_GH_TOKEN } : null
// Look, do not touch: for checking a real brain without adding to it.
export const READ_ONLY = !!REAL && process.env.WP_READ_ONLY === '1'
/**
 * Proves the real mode without real GitHub: everything REAL does (its settings, its guard, its checks), but with
 * api.github.com answered by the stand-in, seeded from this folder. Nothing leaves the machine.
 */
export const LOCAL_CLONE = (REAL && process.env.WP_STAND_IN_CLONE) || ''

const sha = (s) => {
	let h = 0
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
	return (h >>> 0).toString(16).padStart(8, '0')
}

/** The stand-in repository, seeded with `<clone>/bridge/` (skipped when REAL). */
export function standIn(clone) {
	const files = {}
	const walk = (dir, rel) => {
		for (const f of readdirSync(dir, { withFileTypes: true })) {
			const r = rel ? `${rel}/${f.name}` : f.name
			if (f.isDirectory()) walk(join(dir, f.name), r)
			else files[r] = readFileSync(join(dir, f.name), 'utf8')
		}
	}
	if ((!REAL || LOCAL_CLONE) && existsSync(join(clone, 'bridge'))) walk(join(clone, 'bridge'), 'bridge')
	const seeded = new Set(Object.keys(files))
	let version = 1
	const log = []
	// Switches a check can flip: answer the tree as truncated, late, or with an error status.
	const mode = { truncated: false, treeDelayMs: 0, treeFail: 0 }

	async function github(route) {
		const req = route.request()
		const url = new URL(req.url())
		const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '')
		const json = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })
		log.push(`${req.method()} ${url.pathname}${url.search}`)
		if (req.method() === 'GET' && path === '') return json({ full_name: 'you/workpulse-notes', private: true, permissions: { push: true }, default_branch: 'main' })
		if (req.method() === 'GET' && path.startsWith('/git/trees/')) {
			if (mode.treeDelayMs) await new Promise((r) => setTimeout(r, mode.treeDelayMs))
			if (mode.treeFail) return json({ message: 'stand-in: failing the tree on purpose' }, mode.treeFail)
			const etag = `"v${version}"`
			if (req.headers()['if-none-match'] === etag) return route.fulfill({ status: 304, headers: { ETag: etag } })
			return json({ tree: Object.entries(files).map(([p, t]) => ({ path: p, sha: sha(t), type: 'blob' })), ...(mode.truncated ? { truncated: true } : {}) }, 200, { ETag: etag, 'Access-Control-Expose-Headers': 'ETag' })
		}
		if (req.method() === 'GET' && path.startsWith('/git/blobs/')) {
			const want = path.slice('/git/blobs/'.length)
			const hit = Object.values(files).find((t) => sha(t) === want)
			if (hit === undefined) return json({ message: 'Not Found' }, 404)
			return json({ content: Buffer.from(hit).toString('base64'), encoding: 'base64', sha: want })
		}
		if (req.method() === 'GET' && path.startsWith('/contents/')) {
			const p = decodeURIComponent(path.slice('/contents/'.length))
			if (!(p in files)) return json({ message: 'Not Found' }, 404)
			// As real GitHub does: over 1 MB the Contents API gives the sha and no content.
			if (Buffer.byteLength(files[p]) > 1_000_000) return json({ content: '', encoding: 'none', sha: sha(files[p]) })
			return json({ content: Buffer.from(files[p]).toString('base64'), encoding: 'base64', sha: sha(files[p]) })
		}
		if (req.method() === 'GET' && path.startsWith('/git/ref/heads/')) return json({ object: { sha: `c${version}` } })
		if (req.method() === 'GET' && path.startsWith('/git/commits/')) return json({ tree: { sha: `t${version}` } })
		if (req.method() === 'POST' && path === '/git/trees') {
			for (const e of JSON.parse(req.postData()).tree) files[e.path] = e.content
			return json({ sha: `t${version + 1}` })
		}
		if (req.method() === 'POST' && path === '/git/commits') return json({ sha: `c${version + 1}` })
		if (req.method() === 'PATCH' && path.startsWith('/git/refs/heads/')) {
			version++
			return json({})
		}
		return json({ message: `stand-in does not answer ${req.method()} ${path}` }, 501)
	}
	return { files, seeded, log, github, mode }
}

/**
 * A throwaway Chromium profile with the built extension loaded, GitHub routed to `github` unless REAL.
 * `guard`, when given, sees every request to GitHub first, real or stand-in: it is set up before the token exists,
 * so nothing can get past it. The service worker's requests pass through these routes: the stand-in depends on that.
 */
export async function launch({ github, guard, jira = true, profilePrefix = 'workpulse-brain-' } = {}) {
	const profile = mkdtempSync(join(tmpdir(), profilePrefix))
	const ctx = await chromium.launchPersistentContext(profile, {
		headless: true,
		channel: 'chromium',
		viewport: { width: 1280, height: 900 },
		serviceWorkers: 'allow',
		args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
	})
	if ((!REAL || LOCAL_CLONE) && github) await ctx.route('https://api.github.com/**', github)
	// The last route added runs first.
	if (guard) await ctx.route(/^https:\/\/(api|uploads)\.github\.com\//, guard)
	// A Jira issue page, for the Brain's related context.
	if (!REAL && jira) await ctx.route('https://acme.atlassian.net/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>[PAY-2433] Webhook retry - Jira</title><h1>PAY-2433 Webhook retry</h1>' }))
	let [sw] = ctx.serviceWorkers()
	if (!sw) sw = await ctx.waitForEvent('serviceworker')
	const extId = new URL(sw.url()).host
	const ext = (p) => `chrome-extension://${extId}/${p}`
	// A backup target and a token: the extension only needs them to exist.
	await sw.evaluate(
		async (t) => {
			const { settings = {} } = await chrome.storage.local.get('settings')
			// The daily backup is off: this throwaway profile has nothing worth backing up.
			await chrome.storage.local.set({ settings: { ...settings, syncRepo: t.repo, syncBranch: t.branch, syncDaily: false }, syncToken: t.token })
		},
		REAL ?? { repo: 'you/workpulse-notes', branch: '', token: 'stand-in-token' },
	)
	/** Closes the browser and deletes the profile, which held the token. */
	const close = async () => {
		try {
			await ctx.close()
		} finally {
			rmSync(profile, { recursive: true, force: true })
		}
	}
	return { ctx, sw, ext, close }
}
