// Shows Tick and the Brain working end to end.
//
// By default nothing leaves the machine: GitHub is played by a stand-in answered
// inside the browser (ctx.route), seeded with a bridge/ folder from a local
// clone. The built extension then really syncs it (conditional tree read, blob
// fetch), really writes an entry from the Brain page (git data API commit), and
// that written file is handed back to the clone so the CLI can read it.
//
//   npm run build && node scripts/brain-demo.mjs <clone-with-bridge> [outDir]
//
// Against real GitHub instead (nothing stubbed; the token only ever lives in a
// throwaway browser profile that is deleted at the end):
//
//   WP_GH_REPO=owner/repo WP_GH_BRANCH=branch WP_GH_TOKEN=$(gh auth token) \
//     node scripts/brain-demo.mjs - [outDir]

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { chromium } from 'playwright'

const EXT = resolve('.output/chrome-mv3')
const CLONE = resolve(process.argv[2] ?? '.')
const OUT = resolve(process.argv[3] ?? '../docs/screenshots/brain')
const REAL = process.env.WP_GH_REPO && process.env.WP_GH_TOKEN ? { repo: process.env.WP_GH_REPO, branch: process.env.WP_GH_BRANCH ?? '', token: process.env.WP_GH_TOKEN } : null
// Look, do not touch: for checking a real brain without adding to it.
const READ_ONLY = !!REAL && process.env.WP_READ_ONLY === '1'
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
if (!REAL && existsSync(join(CLONE, 'bridge'))) walk(join(CLONE, 'bridge'), 'bridge')
const seeded = new Set(Object.keys(files))
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
const profile = mkdtempSync(join(tmpdir(), 'workpulse-brain-'))
const ctx = await chromium.launchPersistentContext(profile, {
	headless: true,
	channel: 'chromium',
	viewport: { width: 1280, height: 900 },
	serviceWorkers: 'allow',
	args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
})
if (!REAL) await ctx.route('https://api.github.com/**', github)
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

const page = await ctx.newPage()
const shot = async (name) => {
	await page.waitForTimeout(900)
	await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false })
	console.log(`shot ${name}.png`)
}
const bridgeState = () => sw.evaluate(async () => (await chrome.storage.local.get('runtime')).runtime?.bridge ?? {})

// The run, as a function so the read-only check can stop early.
const main = async () => {
	if (!REAL) {
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
		// Dark mode: the clips are cut out, so they sit on a dark card too.
		await page.emulateMedia({ colorScheme: 'dark' })
		await page.goto(ext('dashboard.html#/today'))
		await shot('01b-today-empty-dark')
		await page.emulateMedia({ colorScheme: 'light' })
	}

	// The Brain: the page polls on open; then Sync now, explicitly.
	await page.goto(ext('dashboard.html#/brain'))
	await page.waitForTimeout(2500)
	await page.getByRole('button', { name: 'Sync now' }).click()
	await page.waitForTimeout(2500)
	await shot(REAL ? 'real-05-brain-synced' : '05-brain-synced')
	if (REAL) {
		const first = await bridgeState()
		console.log(`first sync: ${Object.keys(first.files ?? {}).length} entry file(s), etag ${first.etag ? 'set' : 'none'}, error ${first.error ?? 'none'}`)
		// A second poll with the ETag must be a 304: the cache stays, nothing is refetched.
		const second = await page.evaluate(() => chrome.runtime.sendMessage({ wp: 'call', method: 'pollBridge', args: [] }))
		console.log(`second poll (ETag): ${JSON.stringify(second)}`)
	}

	if (!REAL) {
		const more = page.getByRole('button', { name: 'more' }).first()
		if (await more.count()) await more.click()
		await shot('06-brain-ticket-detail')
	}

	if (READ_ONLY) {
		const got = await page.evaluate(() => chrome.runtime.sendMessage({ wp: 'call', method: 'bridge', args: [] }))
		console.log(`read-only: ${got.result.entries.length} entries, ${got.result.summary.projects.map((p) => p.name).join(', ')}`)
		await page.getByRole('button', { name: 'Personal', exact: true }).click()
		await shot('real-brain-personal')
		return
	}

	// Write one entry from the extension.
	await page.getByRole('button', { name: '+ Add' }).click()
	await page.getByPlaceholder(/One line/).fill(REAL ? 'Real GitHub round trip from the extension #bridge' : 'Tick clips need one backdrop, or they look like stickers #design')
	await page.getByPlaceholder('Project or repo').fill('workpulse')
	if (!REAL) await shot('07-brain-add')
	await page.getByRole('button', { name: 'Save', exact: true }).click()
	// The form closes when the commit is done; a real one can queue behind the
	// daily backup, which runs the first time a repository is set after 19:00.
	await page.getByPlaceholder(/One line/).waitFor({ state: 'detached', timeout: 60_000 })
	await page.waitForTimeout(800)
	await shot(REAL ? 'real-08-brain-after-add' : '08-brain-after-add')

	if (!REAL) {
		await page.getByRole('button', { name: 'Personal', exact: true }).click()
		await shot('09-brain-personal')

		// Learnings: Claude Code's lines alongside your own, counted together.
		await page.goto(ext('dashboard.html#/journal'))
		await page.waitForTimeout(1500)
		await shot('10-learnings-with-claude-code')

		// A learning written here reaches the Brain at once, not after tonight's backup.
		const saved = await page.evaluate(() => chrome.runtime.sendMessage({ wp: 'call', method: 'saveLearning', args: [{ text: 'Mirror check: a learning from the Learnings page #bridge', kind: 'learning' }] }))
		await page.waitForTimeout(2500)
		const mirrored = Object.values(files).some((t) => String(t).includes(`"id":"journal:${saved.result.id}"`))
		console.log(`learning copied to the Brain: ${mirrored ? 'yes' : 'NO'}`)

		// A Brain entry whose ticket is not saved yet: start it, land on its page.
		await page.goto(ext('dashboard.html#/brain'))
		await page.waitForTimeout(1500)
		const start = page.getByRole('button', { name: '+ new ticket' }).first()
		if (await start.count()) {
			await start.click()
			await page.waitForURL(/#\/links\//, { timeout: 10_000 })
			await page.waitForTimeout(1500)
			await shot('11-ticket-started-from-brain')
			console.log(`new ticket opened at ${new URL(page.url()).hash}`)
		} else console.log('no "+ new ticket" button found')

		// Save context from the palette (+), then Today's Resume card and the one search.
		await page.goto(ext('dashboard.html#/today'))
		await page.waitForTimeout(1000)
		await page.getByText('Quick actions').click()
		const box = page.locator('.wp-pal-input').first()
		await box.fill('+PAY-2433 retry fix half done, staging still fails')
		await page.getByRole('button', { name: 'Debugging', exact: true }).click()
		await page.getByLabel('Next action').fill('Run the two-retry test on staging')
		await shot('13-palette-save-context')
		await page.getByLabel('Next action').press('Enter')
		await page.waitForTimeout(2500)
		await page.goto(ext('dashboard.html#/today'))
		await page.waitForTimeout(1500)
		const resume = page.locator('section', { hasText: 'Pick up where you left off' })
		console.log(`resume card shows the new next action: ${(await resume.textContent())?.includes('Run the two-retry test on staging') ? 'yes' : 'NO'}`)
		await resume.screenshot({ path: join(OUT, '14-today-resume.png') })
		await page.getByText('Quick actions').click()
		await page.locator('.wp-pal-input').first().fill('staging still fails')
		await page.waitForTimeout(1200)
		console.log(`palette search finds the Brain entry: ${(await page.locator('.wp-pal-list').textContent())?.includes('Brain') ? 'yes' : 'NO'}`)
		await shot('15-palette-finds-brain')
		await page.keyboard.press('Escape')

		// Settings → Claude Code & the Brain: the link, step by step, and the commands.
		await page.goto(ext('dashboard.html#/settings/claude'))
		await page.waitForTimeout(1200)
		const panel = page.locator('details.wp-panel', { hasText: 'Claude Code & the Brain' })
		if (!(await panel.evaluate((d) => d.open))) await panel.locator('summary').click()
		await panel.scrollIntoViewIfNeeded()
		await page.waitForTimeout(600)
		await panel.screenshot({ path: join(OUT, '12-settings-claude-code.png') })
		console.log('shot 12-settings-claude-code.png')
		const useBrain = panel.getByRole('button', { name: /Use a brain branch/ })
		if (await useBrain.count()) {
			await useBrain.click()
			await page.waitForTimeout(1000)
			const branch = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.syncBranch)
			console.log(`"Use a brain branch" set syncBranch to: ${branch}`)
		}
	}

	const errors = await page.locator('.wp-banner').allTextContents()
	if (errors.length) console.log(`banners: ${errors.join(' | ')}`)

	if (REAL) {
		const after = await bridgeState()
		console.log(`after write: ${Object.keys(after.files ?? {}).join(', ')}`)
		// Two more writes inside GitHub's max-age=60: with a cached read the
		// second would overwrite the first. All three lines must be in the file.
		const add = (title) => page.evaluate((t) => chrome.runtime.sendMessage({ wp: 'call', method: 'bridgeAdd', args: [{ kind: 'note', scope: 'work', title: t }] }), title)
		console.log(`quick write 1: ${(await add('Quick write one #bridge')).ok}`)
		console.log(`quick write 2: ${(await add('Quick write two #bridge')).ok}`)
		const state = await page.evaluate(() => chrome.runtime.sendMessage({ wp: 'call', method: 'bridge', args: [] }))
		console.log(`this browser's lines: ${state.result.entries.filter((e) => e.device.startsWith('ext-')).length}`)
	} else {
		// Hand what the extension wrote back to the clone, as GitHub would.
		const written = Object.keys(files).filter((p) => /^bridge\/entries\/.+\/ext-[a-z0-9]+\.jsonl$/.test(p))
		for (const p of written) {
			mkdirSync(dirname(join(CLONE, p)), { recursive: true })
			writeFileSync(join(CLONE, p), files[p])
		}
		console.log(`extension wrote: ${written.join(', ') || 'nothing'}`)
		const outside = Object.keys(files).filter((p) => !p.startsWith('bridge/') && !seeded.has(p))
		console.log(`records written: ${Object.keys(files).filter((p) => p.startsWith('bridge/records/ext-')).length}; files written outside bridge/: ${outside.length ? outside.join(', ') : 'none'}`)
		console.log(`requests: ${log.length} (${log.filter((l) => l.includes('/git/trees/')).length} tree reads)`)
	}
}
try {
	await main()
} finally {
	await ctx.close()
	// The profile held the token: it does not outlive the run.
	rmSync(profile, { recursive: true, force: true })
}
