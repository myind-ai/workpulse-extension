// Shows Tick and the Brain working end to end, with nothing leaving the machine.
//
// GitHub is played by a stand-in answered inside the browser (ctx.route), seeded
// with a bridge/ folder from a local clone. The built extension then really
// syncs it (conditional tree read, blob fetch), really writes an entry from the
// Brain page (git data API commit), and that written file is handed back so the
// CLI can read it. Screenshots go to the out folder.
//
//   npm run build && node scripts/brain-demo.mjs <clone-with-bridge> [outDir]

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

import { chromium } from 'playwright'

const EXT = resolve('.output/chrome-mv3')
const CLONE = resolve(process.argv[2] ?? '.')
const OUT = resolve(process.argv[3] ?? '../docs/screenshots/brain')
mkdirSync(OUT, { recursive: true })

// ── the stand-in repository ────────────────────────────────────────────────
const files = {}
const walk = (dir, rel) => {
	for (const f of readdirSync(dir, { withFileTypes: true })) {
		const r = rel ? `${rel}/${f.name}` : f.name
		if (f.isDirectory()) walk(join(dir, f.name), r)
		else files[r] = readFileSync(join(dir, f.name), 'utf8')
	}
}
if (existsSync(join(CLONE, 'bridge'))) walk(join(CLONE, 'bridge'), 'bridge')
const sha = (s) => {
	let h = 0
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
	return (h >>> 0).toString(16).padStart(8, '0')
}
let version = 1
const log = []

async function github(route) {
	const req = route.request()
	const url = new URL(req.url())
	const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '')
	const json = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })
	log.push(`${req.method()} ${url.pathname}${url.search}`)
	if (req.method() === 'GET' && path === '') return json({ full_name: 'you/workpulse-notes', private: true, permissions: { push: true }, default_branch: 'main' })
	if (req.method() === 'GET' && path.startsWith('/git/trees/')) {
		const etag = `"v${version}"`
		if (req.headers()['if-none-match'] === etag) return route.fulfill({ status: 304, headers: { ETag: etag } })
		return json({ tree: Object.entries(files).map(([p, t]) => ({ path: p, sha: sha(t), type: 'blob' })) }, 200, { ETag: etag, 'Access-Control-Expose-Headers': 'ETag' })
	}
	if (req.method() === 'GET' && path.startsWith('/contents/')) {
		const p = decodeURIComponent(path.slice('/contents/'.length))
		if (!(p in files)) return json({ message: 'Not Found' }, 404)
		return json({ content: Buffer.from(files[p]).toString('base64'), sha: sha(files[p]) })
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

// ── the browser ────────────────────────────────────────────────────────────
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'workpulse-brain-')), {
	headless: true,
	channel: 'chromium',
	viewport: { width: 1280, height: 900 },
	serviceWorkers: 'allow',
	args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
})
await ctx.route('https://api.github.com/**', github)
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker')
const extId = new URL(sw.url()).host
const ext = (p) => `chrome-extension://${extId}/${p}`

// A backup target and a stand-in token: the extension only needs them to exist.
await sw.evaluate(async () => {
	const { settings = {} } = await chrome.storage.local.get('settings')
	await chrome.storage.local.set({ settings: { ...settings, syncRepo: 'you/workpulse-notes' }, syncToken: 'stand-in-token' })
})

const page = await ctx.newPage()
const shot = async (name) => {
	await page.waitForTimeout(900)
	await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false })
	console.log(`shot ${name}.png`)
}

// Empty states first, before anything is logged: Tick on each.
for (const [view, name] of [
	['today', '01-today-empty'],
	['tasks', '02-tasks-empty'],
	['journal', '03-learnings-empty'],
	['links', '04-tickets-empty'],
]) {
	await page.goto(ext(`dashboard.html#/${view}`))
	await shot(name)
}

// The Brain: the page polls on open; then Sync now, explicitly.
await page.goto(ext('dashboard.html#/brain'))
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'Sync now' }).click()
await page.waitForTimeout(1500)
await shot('05-brain-synced')

// Open the ticket entry's detail.
const more = page.getByRole('button', { name: 'more' }).first()
if (await more.count()) await more.click()
await shot('06-brain-ticket-detail')

// Write one entry from the extension.
await page.getByRole('button', { name: '+ Add' }).click()
await page.getByPlaceholder(/One line/).fill('Tick clips need one backdrop, or they look like stickers #design')
await page.getByPlaceholder('Project or repo').fill('workpulse')
await shot('07-brain-add')
await page.getByRole('button', { name: 'Save', exact: true }).click()
await page.waitForTimeout(1500)
await shot('08-brain-after-add')

// Personal only.
await page.getByRole('button', { name: 'Personal', exact: true }).click()
await shot('09-brain-personal')

// Hand what the extension wrote back to the clone, as GitHub would.
const written = Object.keys(files).filter((p) => /^bridge\/entries\/.+\/ext-[a-z0-9]+\.jsonl$/.test(p))
for (const p of written) {
	mkdirSync(dirname(join(CLONE, p)), { recursive: true })
	writeFileSync(join(CLONE, p), files[p])
}
console.log(`extension wrote: ${written.join(', ') || 'nothing'}`)
console.log(`requests: ${log.length} (${log.filter((l) => l.includes('/git/trees/')).length} tree reads)`)
const errors = await page.locator('.wp-banner').allTextContents()
if (errors.length) console.log(`banners: ${errors.join(' | ')}`)
await ctx.close()
