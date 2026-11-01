// Browser checks for One Learning Place, in the built extension, against the
// local GitHub stand-in (nothing leaves the machine; throwaway browser profile).
//
//   npm run build && node scripts/one-learning-check.mjs scripts/fixtures/one-learning [shotsDir]
//
// Exits non-zero on the first failed check. Later tasks add their checks below.
// ONLY=graph runs the graph page's checks and nothing else. ONLY=big-file, failed-poll or all-archived runs that one; ONLY=real-mode proves the real mode.
// The third argument, or WP_SHOTS, says where screenshots go; by default a folder in the system's temp directory.
//
// Read-only, on a real Brain (no fixture, no write; the token lives only in the throwaway profile):
//
//   WP_GH_REPO=owner/repo WP_GH_BRANCH=brain WP_GH_TOKEN=... WP_READ_ONLY=1 node scripts/one-learning-check.mjs -
//
// It refuses to run on a real repository without WP_READ_ONLY=1. Any request to GitHub that is not a GET is stopped,
// and fails the run. WP_STAND_IN_CLONE=<folder> runs that same path with GitHub answered by the stand-in: that is how
// this mode is tested (`realModeChecks`). Its screenshots hold real content: they stay on this machine.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { brainGraph } from '../src/core/brain-index.ts'
import { neighbourhood } from '../src/core/brain-graph.ts'
import { entriesPath, SOURCE_LABEL, sourceOf } from '../src/core/bridge.ts'
import { launch, LOCAL_CLONE, READ_ONLY, REAL, standIn } from './github-stand-in.mjs'

const refuse = (why) => {
	console.error(why)
	process.exit(2)
}
if (REAL && !READ_ONLY) refuse('Refusing to run on a real repository without WP_READ_ONLY=1: this check must never write to it.')
if (!REAL && (process.env.WP_GH_REPO || process.env.WP_GH_TOKEN || process.env.WP_READ_ONLY)) refuse('The real mode needs all of WP_GH_REPO, WP_GH_TOKEN and WP_READ_ONLY=1.')
if (REAL && process.argv[2] !== '-') refuse('The real mode uses no fixture: pass - as the first argument.')

const CLONE = resolve(LOCAL_CLONE || (process.argv[2] ?? 'scripts/fixtures/one-learning'))
const SHOTS = resolve(process.argv[3] ?? process.env.WP_SHOTS ?? join(tmpdir(), 'workpulse-shots'))
mkdirSync(SHOTS, { recursive: true })

const { files, seeded, log, github, mode } = standIn(CLONE)
// A 1.5 MB transcript, made here rather than committed. The marker sits past the 200 KB cut.
const VIDEO = 'bridge/library/youtube/2026-10-29_Payments-done-right_abc123'
if (!REAL) files[`${VIDEO}/transcript.md`] = `# Transcript\n\n${'the quick brown fox jumps over the lazy dog. '.repeat(33_000)}\ntail-marker-qzx`
// Read-only: whatever is not a GET is stopped here and fails the run.
const stopped = []
const guard = READ_ONLY
	? (route) => {
			const req = route.request()
			if (req.method() === 'GET') return route.fallback()
			stopped.push(`${req.method()} ${new URL(req.url()).pathname}`)
			return route.abort()
		}
	: undefined
const { ctx, sw, ext, close } = await launch({ github, guard })
const page = await ctx.newPage()
const problems = []
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))

let n = 0
class Failed extends Error {}
const check = (name, ok, detail = '') => {
	if (!ok) throw new Failed(`${name}${detail ? ` — ${detail}` : ''}`)
	n++
	console.log(`ok ${n}  ${name}`)
}
const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) })
const cards = () => page.locator('article.wp-card')
const card = (text) => cards().filter({ hasText: text }).first()
const settle = (ms = 700) => page.waitForTimeout(ms)
/** Waits until fn() is true, or fails the check with what it saw. */
const until = async (name, fn, ms = 10_000) => {
	const end = Date.now() + ms
	let last
	while (Date.now() < end) {
		last = await fn()
		if (last === true) return check(name, true)
		await page.waitForTimeout(150)
	}
	check(name, false, `last: ${JSON.stringify(last)}`)
}
const written = () => Object.entries(files).filter(([p]) => /^bridge\/entries\/.+\/ext-[a-z0-9]+\.jsonl$/.test(p)).flatMap(([, t]) => t.split('\n').filter(Boolean).map((l) => JSON.parse(l)))

// ── Save to Brain, from the toolbar popup with a real page open ──────────────
// The page is served here (nothing outside); it holds a secret-looking string and
// a login in its address, none of which may reach the inbox.
const popupChecks = async () => {
	const server = createServer((req, res) => {
		res.setHeader('content-type', 'text/html')
		res.end('<!doctype html><title>Retry budgets explained</title><h1>Retry budgets</h1><p id="body">body-marker-zq91 ghp_abcdefghijklmnopqrstuvwxyz0123456789</p>')
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const origin = `http://127.0.0.1:${server.address().port}`
	const inbox = () => Object.entries(files).filter(([p]) => p.startsWith('bridge/inbox/to-cli/'))
	try {
		const real = await ctx.newPage()
		await real.goto(`${origin}/post?id=7&token=s3cret#part`)
		await real.bringToFront()
		// The popup, opened in a tab behind the page, so "the tab you are on" is the page.
		const popup = await ctx.newPage()
		await real.bringToFront()
		await popup.goto(ext('popup.html'))
		await real.bringToFront()
		await popup.getByRole('button', { name: 'Save something' }).click()
		const btn = popup.getByRole('button', { name: 'Save to Brain' })
		await btn.waitFor({ timeout: 10_000 })
		check('the popup offers Save to Brain for the open page', (await popup.getByText(`${origin}/post?id=7&token=s3cret#part`).count()) === 1)
		await popup.screenshot({ path: join(SHOTS, 'popup-save-to-brain.png') })
		const before = inbox().length
		await btn.click()
		await popup.getByText(/Saved\. Say "process my queue" to Claude/).waitFor({ timeout: 10_000 })
		check('it says what to do next', true)
		check('exactly one inbox file arrived', inbox().length === before + 1, `${inbox().length - before}`)
		const msg = JSON.parse(inbox().at(-1)[1])
		check('it holds the address (without the secret value) and the title', msg.type === 'save-url' && msg.url === `${origin}/post?id=7#part` && msg.title === 'Retry budgets explained' && msg.text === `Save to Brain: ${msg.url}`, JSON.stringify(msg))
		check('and nothing else from the page', Object.keys(msg).sort().join() === 'at,from,id,schema,text,title,type,url' && !JSON.stringify(inbox()).includes('body-marker-zq91') && !JSON.stringify(inbox()).includes('ghp_') && !JSON.stringify(inbox()).includes('s3cret'))
		await btn.click()
		await popup.getByText('Already saved and waiting to be read.').waitFor({ timeout: 10_000 })
		check('a second press reports the duplicate and sends nothing', inbox().length === before + 1)
		await popup.screenshot({ path: join(SHOTS, 'popup-save-to-brain-duplicate.png') })
		await popup.close()
		await real.close()
		// A screenshot of a tab behind another one never answers.
		await page.bringToFront()

		// The Library page lists it, and a failed ack shows its reason.
		await page.goto(ext('dashboard.html#/library'))
		await until('the Library page lists the saved page as waiting', async () => (await page.getByTestId('saved-row').filter({ hasText: 'Retry budgets explained' }).filter({ hasText: 'Waiting to be read' }).count()) === 1)
		files[`bridge/inbox/acks/cli-a/${msg.id}.json`] = JSON.stringify({ id: msg.id, at: Date.now(), by: 'cli-a', state: 'claimed' })
		await page.getByRole('button', { name: 'Sync now' }).click()
		await until('a claimed ack moves the row', async () => (await page.getByTestId('saved-row').filter({ hasText: 'Being read' }).count()) === 1)
		files[`bridge/inbox/acks/cli-a/${msg.id}.json`] = JSON.stringify({ id: msg.id, at: Date.now(), by: 'cli-a', state: 'failed', why: 'The page needs a login.' })
		await page.getByRole('button', { name: 'Sync now' }).click()
		await until('a failed ack shows its reason, never silent', async () => (await page.getByTestId('saved-row').filter({ hasText: 'The page needs a login.' }).count()) === 1)
		await shot('library-saved-to-read-failed')
	} finally {
		// Keep-alive connections from the closed page would hold close() open.
		server.closeAllConnections()
		await new Promise((r) => server.close(r))
	}
}

const libraryChecks = async () => {
	// ── the Library page ──────────────────────────────────────────────────────
	await page.goto(ext('dashboard.html#/library'))
	await until('the library lists both saved items, with their titles', async () => (await cards().count()) === 2 && (await page.locator('article.wp-card strong').allTextContents()).sort().join('|') === 'Backoff and jitter|Payments done right', 15_000)
	await shot('library-list')
	const video = card('Payments done right')
	const article = card('Backoff and jitter')
	check('the newest is first', (await cards().first().textContent()).includes('Backoff and jitter'))
	check('a row says its lessons and which texts it has', /2 lessons/.test(await video.textContent()) && /notes\.md, transcript\.md, description\.md/.test(await video.textContent()) && /1 lesson ·/.test(await article.textContent()) && /article\.md/.test(await article.textContent()))
	check('and who made it and how long', /A Channel/.test(await video.textContent()) && /4,200 words/.test(await video.textContent()))
	check('the search says it covers titles only', (await page.getByText(/Searches titles\. To search inside notes/).count()) === 1)
	const sources = page.getByRole('group', { name: 'Source' })
	await sources.getByRole('button', { name: /^YouTube/ }).click()
	await settle(300)
	check('the source filter narrows the list', (await cards().count()) === 1 && (await cards().first().textContent()).includes('Payments done right'))
	await sources.getByRole('button', { name: /^Any source/ }).click()
	await page.getByLabel('Search titles').fill('jitter')
	await settle(300)
	check('a title search narrows it', (await cards().count()) === 1 && (await cards().first().textContent()).includes('Backoff and jitter'))
	await page.getByLabel('Search titles').fill('zebrafinch')
	await settle(300)
	check('a word only inside notes.md finds nothing here', (await cards().count()) === 0)
	await page.getByLabel('Search titles').fill('')

	// ── open the video: notes first ───────────────────────────────────────────
	await card('Payments done right').getByRole('link', { name: 'Payments done right' }).click()
	await until('the notes render as Markdown', async () => (await page.getByTestId('library-text').locator('strong', { hasText: 'idempotency key' }).count()) === 1)
	check('the text tabs are notes first', (await page.getByRole('group', { name: 'Text' }).getByRole('button').allTextContents()).join() === 'notes.md,transcript.md,description.md')
	await shot('library-notes')
	const src = page.locator('aside .wp-card a.wp-chip-source').first()
	check('the source link goes to the video, in a new tab', (await src.getAttribute('href')) === 'https://www.youtube.com/watch?v=abc123' && (await src.getAttribute('target')) === '_blank')
	await until('the two lessons from this video are on the right', async () => (await page.locator('aside article.wp-card').count()) === 2)
	check('no edit or delete for the library file itself, only for lessons', (await page.getByRole('button', { name: 'Edit', exact: true }).count()) === 2)

	// ── the large transcript, through the blob ───────────────────────────────
	const t0 = Date.now()
	await page.getByRole('button', { name: 'transcript.md' }).click()
	await until('the 1.5 MB transcript opens as preformatted text', async () => (await page.getByTestId('library-pre').count()) === 1, 20_000)
	const pre = await page.getByTestId('library-pre').textContent()
	check('only the first 200 KB is in the page', pre.length === 200_000 && !pre.includes('tail-marker-qzx'), `${pre.length}`)
	check('and it says so, with a link to GitHub', (await page.getByText(/The first 200 KB is shown as plain text/).count()) === 1 && (await page.getByRole('link', { name: 'Open on GitHub' }).getAttribute('href')) === `https://github.com/you/workpulse-notes/blob/HEAD/${VIDEO}/transcript.md`)
	const lag = await page.evaluate(() => new Promise((r) => { const t = performance.now(); setTimeout(() => r(performance.now() - t), 0) }))
	check('the page stays responsive', lag < 500, `${Math.round(lag)} ms, opened in ${Date.now() - t0} ms`)
	await shot('library-transcript-large')
	await page.getByRole('button', { name: 'notes.md' }).click()
	await until('back to the notes without a refetch error', async () => (await page.getByTestId('library-text').count()) === 1)

	// ── lessons on the right are managed in place ─────────────────────────────
	await page.locator('aside article.wp-card').filter({ hasText: 'Never retry a 4xx' }).getByRole('button', { name: 'Archive', exact: true }).click()
	await until('archiving one leaves one on the right', async () => (await page.locator('aside article.wp-card').count()) === 1)
	await shot('library-after-archive')

	// ── sidebar search: titles yes, inside notes no ───────────────────────────
	const box = page.getByLabel('Go to a section, or search everything you have written')
	await box.fill('payments done')
	await until('the sidebar search finds the library title', async () => (await page.locator('.wp-search-out').getByText(/Library · A Channel/).count()) >= 1)
	await shot('library-search')
	await page.locator('.wp-search-out').getByRole('button', { name: /Payments done right/ }).first().click()
	await until('and opens that folder', async () => (await page.evaluate(() => location.hash)).startsWith('#/library/'))
	await box.fill('zebrafinch')
	await settle(700)
	check('a word only inside notes.md is not found by the sidebar search', (await page.locator('.wp-search-out').getByText(/Nothing matches/).count()) === 1)
	await box.fill('')

	// ── a truncated tree: the banner shows and the list still works ───────────
	mode.truncated = true
	await page.goto(ext('dashboard.html#/library'))
	await page.getByRole('button', { name: 'Sync now' }).click()
	await until('a truncated tree shows its banner', async () => (await page.getByText('The repository’s file tree is too large for GitHub to list in full, so some library folders may be missing from this page.').count()) === 1)
	check('and the list is still there and usable', (await cards().count()) === 2 && (await page.getByLabel('Search titles').count()) === 1)
	await shot('library-truncated')
	mode.truncated = false
	await page.getByRole('button', { name: 'Sync now' }).click()
	await until('the banner goes when the tree is whole again', async () => (await page.getByText(/too large for GitHub to list in full/).count()) === 0)

	// ── a failed poll, with a list already here: it says so, and the list stays ─
	mode.treeFail = 503
	await page.goto(ext('dashboard.html#/today'))
	await page.goto(ext('dashboard.html#/library'))
	await until('a failed poll shows its reason over the list', async () => (await page.locator('.wp-banner', { hasText: FAILED_WORDS }).count()) === 1)
	check('and the list is still there', (await cards().count()) === 2 && (await page.getByTestId('library-failed').count()) === 0)
	await shot('library-poll-failed-with-list')
	mode.treeFail = 0
	await page.getByRole('button', { name: 'Sync now' }).click()
	await until('the reason goes when the poll works again', async () => (await page.locator('.wp-banner', { hasText: FAILED_WORDS }).count()) === 0)

	// ── no library: how to turn it on ─────────────────────────────────────────
	const saved = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith('bridge/library/')))
	for (const p of Object.keys(saved)) delete files[p]
	await page.getByRole('button', { name: 'Sync now' }).click()
	await until('with no library the empty state shows', async () => (await page.getByTestId('library-empty').count()) === 1)
	const empty = page.locator('.wp-card', { has: page.getByTestId('library-empty') })
	const emptyText = await empty.textContent()
	check('it says how to turn the library on', emptyText.includes('Nothing saved yet.') && emptyText.includes('"library": true') && emptyText.includes('brain.json') && emptyText.includes('off by default'))
	check('and draws its picture', (await empty.innerHTML()).includes('art/empty-notes.'))
	await shot('library-empty')
	// While the first look is in flight an empty list is not "nothing saved".
	mode.treeDelayMs = 2500
	await page.goto(ext('dashboard.html#/today'))
	await page.goto(ext('dashboard.html#/library'))
	await page.reload()
	await settle(600)
	check('before the first poll answers it says it is looking, not "nothing saved"', (await page.getByTestId('library-loading').count()) === 1 && (await page.getByTestId('library-empty').count()) === 0)
	await shot('library-loading')
	await until('then the empty state appears', async () => (await page.getByTestId('library-empty').count()) === 1, 15_000)
	mode.treeDelayMs = 0
	for (const [p, t] of Object.entries(saved)) files[p] = t

	// ── not connected: points at Settings → Backup ────────────────────────────
	await sw.evaluate(async () => {
		const { settings = {} } = await chrome.storage.local.get('settings')
		await chrome.storage.local.set({ settings: { ...settings, syncRepo: '' } })
		await chrome.storage.local.remove('syncToken')
	})
	await page.goto(ext('dashboard.html#/today'))
	await page.goto(ext('dashboard.html#/library'))
	await until('without a repository it asks to connect one', async () => (await page.getByText('Connect a repository first.').count()) === 1)
	const conn = page.locator('.wp-card', { hasText: 'Connect a repository first.' })
	check('with a link to Settings → Backup', (await conn.getByRole('link', { name: 'Settings → Backup' }).getAttribute('href')) === '#/settings/backup')
	check('and its picture', (await conn.innerHTML()).includes('art/empty-journal.'))
	await shot('library-not-connected')
}

// ── the graph page ───────────────────────────────────────────────────────────
const nodesOf = (p) => p.locator('.wp-graph-svg [data-node]')
const edgesOf = (p) => p.locator('.wp-graph-svg line')
const viewOf = (p) => p.evaluate(() => chrome.runtime.sendMessage({ wp: 'call', method: 'bridge', args: [] }).then((r) => r.result))
/** What should be drawn with nothing chosen: everything minus the tags used once. */
const expectedOf = (entries) => {
	const g = brainGraph(entries)
	const lone = new Set(g.nodes.filter((x) => x.type === 'tag' && x.degree === 1).map((x) => x.id))
	return { g, lone, nodes: g.nodes.length - lone.size, edges: g.edges.filter((e) => !lone.has(e.target)).length }
}
/** Pairs of visible hub labels whose boxes touch, as the browser measures them. */
const labelOverlaps = (p) =>
	p.evaluate(() => {
		const boxes = [...document.querySelectorAll('.wp-graph-svg .is-hub .wp-g-label')].filter((t) => getComputedStyle(t).display !== 'none').map((t) => ({ text: t.textContent, b: t.getBoundingClientRect() }))
		const out = []
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) {
				const [a, c] = [boxes[i].b, boxes[j].b]
				if (a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top) out.push([boxes[i].text, boxes[j].text])
			}
		return out
	})
const arranged = (p) => p.getByTestId('graph-busy').waitFor({ state: 'detached', timeout: 60_000 })
const worldOf = (p) => p.getByTestId('graph-world').getAttribute('transform')
const placesOf = (p) => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.wp-graph-svg [data-node]')].map((n) => [n.dataset.node, n.getAttribute('transform')])))
/** A real click at the middle of a node, as a person's mouse would land. */
const clickNode = async (p, id) => {
	const box = await p.locator(`.wp-graph-svg [data-node="${id}"] .wp-g-hit`).boundingBox()
	await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

const graphChecks = async () => {
	await page.goto(ext('dashboard.html#/brain'))
	await page.getByRole('button', { name: 'Sync now' }).click()
	await until('the Brain has synced before the graph opens', async () => (await cards().count()) === 10, 15_000)
	check('Graph is in the sidebar', (await page.locator('.wp-subnav-item', { hasText: /^Graph$/ }).count()) === 1)
	await page.locator('.wp-subnav-item', { hasText: /^Graph$/ }).click()
	const view = await viewOf(page)
	const want = expectedOf(view.entries)
	await until('#/graph draws what brainGraph gives, minus the tags used once', async () => (await nodesOf(page).count()) === want.nodes, 15_000)
	await arranged(page)
	check('and every connection', (await edgesOf(page).count()) === want.edges, `${await edgesOf(page).count()} vs ${want.edges}`)
	const counts = await page.getByTestId('graph-counts').textContent()
	check('the counts on screen are what is drawn', counts.includes(`${want.nodes} nodes`) && counts.includes(`${want.edges} connections`), counts)
	await shot('graph-fixture-overview-light')

	// ── how it is drawn ─────────────────────────────────────────────────────
	const paths = await page.evaluate(() => Object.fromEntries(['lesson', 'source', 'project', 'ticket', 'tag'].map((t) => [t, document.querySelector(`.wp-graph-svg [data-type="${t}"] .wp-g-mark`)?.getAttribute('d')?.replace(/-?[\d.]+/g, (x) => (Number(x) > 0 ? '+' : Number(x) < 0 ? '-' : '0'))])))
	check('each type has its own shape', new Set(Object.values(paths)).size === 5 && Object.values(paths).every(Boolean), JSON.stringify(paths))
	const size = async (id) => (await page.locator(`.wp-graph-svg [data-node="${id}"] .wp-g-mark`).boundingBox()).width
	check('a node grows with its connections', (await size('tag:retries')) > (await size('fx-plain')) * 0.99 && (await size('tag:retries')) > (await size('ticket:PAY-9')))
	check('every node carries its full label as a title', (await page.locator('.wp-graph-svg [data-node="fx-yt"] > title').textContent()) === 'Idempotency keys stop double charges #payments')
	check('a related edge is dashed and the others are not', await page.evaluate(() => getComputedStyle(document.querySelector('.wp-graph-svg line[data-kind="related"]')).strokeDasharray !== 'none' && getComputedStyle(document.querySelector('.wp-graph-svg line[data-kind="tag"]')).strokeDasharray === 'none'))
	const shows = (id) => page.evaluate((x) => getComputedStyle(document.querySelector(`.wp-graph-svg [data-node="${x}"] .wp-g-label`)).display !== 'none', id)
	check('hubs are labelled, lessons are not until asked', (await shows('tag:retries')) && !(await shows('fx-yt')))

	// ── the legend, and tags used once ──────────────────────────────────────
	const legend = page.getByRole('group', { name: 'Node types' })
	const typed = (t) => page.locator(`.wp-graph-svg [data-type="${t}"]`).count()
	for (const [name, t] of [['Lessons', 'lesson'], ['Sources', 'source'], ['Projects', 'project'], ['Tickets', 'ticket'], ['Tags', 'tag']]) {
		const btn = legend.getByRole('button', { name: new RegExp(`^${name}`) })
		const before = await typed(t)
		check(`${name}: the legend counts it and is pressed`, before > 0 && (await btn.getAttribute('aria-pressed')) === 'true' && (await btn.textContent()).includes(String(want.g.nodes.filter((x) => x.type === t && !want.lone.has(x.id)).length)), await btn.textContent())
		await btn.click()
		await until(`${name}: pressing it removes that type`, async () => (await typed(t)) === 0 && (await btn.getAttribute('aria-pressed')) === 'false')
		await btn.click()
		await until(`${name}: pressing it again brings them back`, async () => (await typed(t)) === before)
	}
	await arranged(page)
	const loneBtn = page.getByRole('button', { name: /^Tags used once \d+/ })
	check('Tags used once shows its count, off by default', (await loneBtn.textContent()).includes(String(want.lone.size)) && want.lone.size > 0 && (await loneBtn.getAttribute('aria-pressed')) === 'false', await loneBtn.textContent())
	await loneBtn.click()
	await until('one click draws them', async () => (await nodesOf(page).count()) === want.g.nodes.length)
	await loneBtn.click()
	await until('another hides them', async () => (await nodesOf(page).count()) === want.nodes)

	// ── filters ─────────────────────────────────────────────────────────────
	const box = page.getByPlaceholder(/Search, or filter/)
	const youtube = view.entries.filter((e) => sourceOf(e)?.type === 'youtube')
	await box.fill('source:youtube')
	await until('source:youtube in the box narrows the lessons', async () => (await typed('lesson')) === youtube.length)
	check('and only the hubs they touch', (await typed('ticket')) === 0, `${await typed('ticket')} tickets`)
	check('the filter shows as a chip', (await page.locator('.wp-chip-accent', { hasText: 'source youtube' }).count()) === 1)
	await box.fill('zebrafinch')
	await until('a filter to nothing says so', async () => (await page.getByText('Nothing matches that').count()) === 1)
	await shot('graph-nothing-matches')
	await page.getByRole('button', { name: 'Clear filters' }).click()
	await until('and clear brings it back', async () => (await nodesOf(page).count()) === want.nodes)
	check('the box is empty again', (await box.inputValue()) === '')
	const sources = page.getByRole('group', { name: 'Source', exact: true })
	await sources.getByRole('button', { name: /^YouTube/ }).click()
	await until('the source buttons narrow it the same way', async () => (await typed('lesson')) === youtube.length)
	await sources.getByRole('button', { name: /^Any source/ }).click()
	const kinds = page.getByRole('group', { name: 'Connection kinds' })
	await kinds.getByRole('button', { name: /^Tag/ }).click()
	await until('an edge kind turned off takes its edges and hubs', async () => (await page.locator('.wp-graph-svg line[data-kind="tag"]').count()) === 0 && (await typed('tag')) === 0)
	check('lessons stay, even with no connection left', (await typed('lesson')) === view.entries.length)
	await kinds.getByRole('button', { name: /^Tag/ }).click()
	await until('and back', async () => (await nodesOf(page).count()) === want.nodes)
	await arranged(page)

	// ── pan and zoom ────────────────────────────────────────────────────────
	const count0 = await nodesOf(page).count()
	const t0 = await worldOf(page)
	await page.getByRole('button', { name: 'Zoom in' }).click()
	const t1 = await worldOf(page)
	check('+ changes the transform', t1 !== t0, `${t0} -> ${t1}`)
	const scale = async () => Number((await worldOf(page)).match(/scale\(([\d.]+)\)/)[1])
	for (let i = 0; i < 12 && (await scale()) <= 1.2; i++) {
		check('not past 1.2: no lesson label yet', !(await shows('fx-yt')))
		await page.getByRole('button', { name: 'Zoom in' }).click()
	}
	check('past 1.2 the lessons get labels', (await scale()) > 1.2 && (await shows('fx-yt')), String(await scale()))
	await page.getByRole('button', { name: 'Zoom out' }).click()
	await page.getByRole('button', { name: 'Fit' }).click()
	const svgBox = await page.locator('.wp-graph-svg').boundingBox()
	const fitted = await worldOf(page)
	await page.mouse.move(svgBox.x + svgBox.width / 2, svgBox.y + svgBox.height / 2)
	await page.mouse.wheel(0, -240)
	await settle(150)
	check('the wheel zooms', (await worldOf(page)) !== fitted)
	await page.getByRole('button', { name: 'Fit' }).click()
	await page.mouse.move(svgBox.x + 4, svgBox.y + 4)
	await page.mouse.down()
	await page.mouse.move(svgBox.x + 44, svgBox.y + 34, { steps: 4 })
	await page.mouse.up()
	check('a drag pans', (await worldOf(page)) !== fitted)
	check('and neither changes what is drawn', (await nodesOf(page).count()) === count0)
	await page.getByRole('button', { name: 'Fit' }).click()
	check('Fit returns', (await worldOf(page)) === fitted, `${await worldOf(page)} vs ${fitted}`)
	const panel = page.getByTestId('graph-panel')
	const hub = await page.locator('.wp-graph-svg [data-node="tag:retries"] .wp-g-hit').boundingBox()
	await page.mouse.move(hub.x + hub.width / 2, hub.y + hub.height / 2)
	await page.mouse.down()
	await page.mouse.move(hub.x + hub.width / 2 + 2, hub.y + hub.height / 2 + 1)
	await page.mouse.up()
	await until('a drag under 4 px counts as a click', async () => (await panel.getByRole('heading', { name: /retries/ }).count()) === 1)

	// ── the side panel ──────────────────────────────────────────────────────
	check('a tag lists its lessons', (await panel.getByRole('button', { name: /Reels can teach retry budgets/ }).count()) === 1)
	check('and says Open in Brain with its query', (await panel.getByRole('link', { name: 'Open in Brain' }).getAttribute('href')) === '#/brain/q=%23retries')
	check('the node is marked on the canvas', await page.locator('.wp-graph-svg [data-node="tag:retries"].is-sel').count() === 1)
	await panel.getByRole('button', { name: /Reels can teach retry budgets/ }).click()
	await until('a lesson there opens as an EntryCard', async () => (await panel.locator('article.wp-card strong', { hasText: 'Reels can teach retry budgets' }).count()) === 1)
	await shot('graph-fixture-lesson-selected')
	await panel.locator('article.wp-card').getByRole('button', { name: 'Archive', exact: true }).click()
	await until('archiving there takes it off the graph', async () => (await page.locator('.wp-graph-svg [data-node="fx-ig"]').count()) === 0, 15_000)
	await page.getByRole('button', { name: 'Sync now' }).click()
	await settle(800)
	check('and it stays off after a sync', (await page.locator('.wp-graph-svg [data-node="fx-ig"]').count()) === 0)
	const archivedBtn = page.getByRole('button', { name: /^Archived \d+/ })
	check('Archived counts it', /Archived 2/.test(await archivedBtn.textContent()), await archivedBtn.textContent())
	await archivedBtn.click()
	await until('Archived draws them, hollow', async () => (await page.locator('.wp-graph-svg [data-node="fx-ig"].is-archived').count()) === 1)
	await archivedBtn.click()
	await until('and hides them again', async () => (await page.locator('.wp-graph-svg [data-node="fx-ig"]').count()) === 0)
	await arranged(page)

	const find = page.getByLabel('Find a node')
	await find.fill('PAY-2433')
	await panel.getByRole('button', { name: /PAY-2433/ }).first().click()
	await until('a ticket hub shows its label', async () => (await panel.getByRole('heading', { name: 'PAY-2433' }).count()) === 1)
	check('and links to its Brain page', (await panel.getByRole('link', { name: 'Open in Brain' }).getAttribute('href')) === '#/brain/PAY-2433')
	await find.fill('youtube-learning')
	await panel.getByRole('button', { name: /youtube-learning/ }).first().click()
	await until('a project hub links to its Brain page', async () => (await panel.getByRole('link', { name: 'Open in Brain' }).getAttribute('href').catch(() => '')) === '#/brain/project=youtube-learning')
	await find.fill('Payments done right')
	await panel.getByRole('button', { name: /Payments done right/ }).first().click()
	await until('a source hub shows its chip', async () => (await panel.locator('a.wp-chip-source').count()) === 1)
	const lib = panel.getByRole('link', { name: 'Open in Library' })
	check('and a link to its Library folder', (await lib.getAttribute('href')) === `#/library/${encodeURIComponent(VIDEO)}`, await lib.getAttribute('href'))
	await lib.click()
	await until('which opens that folder', async () => (await page.getByTestId('library-text').count()) === 1, 15_000)
	await page.goBack()
	await arranged(page)

	// Keyboard only: type, tab to the result, enter.
	await find.focus()
	await page.keyboard.type('Webhook retries')
	await page.keyboard.press('Tab')
	await page.keyboard.press('Enter')
	await until('the find box reaches a node with the keyboard alone', async () => (await panel.locator('article.wp-card strong', { hasText: 'Webhook retries on PAY-2433' }).count()) === 1)
	await panel.getByRole('link', { name: 'Open in Brain' }).click()
	await until('Open in Brain lands on that entry, opened', async () => (await page.evaluate(() => location.hash)) === '#/brain/entry=fx-ticket' && (await cards().count()) === 1 && (await cards().first().getByText('Make webhook retries safe').count()) === 1)
	await page.goBack()
	await arranged(page)

	// ── focus ───────────────────────────────────────────────────────────────
	const now = await viewOf(page)
	const after = expectedOf(now.entries)
	await until('the overview is back', async () => (await nodesOf(page).count()) === after.nodes)
	const visible = { ...after.g, nodes: after.g.nodes.filter((x) => !after.lone.has(x.id)), edges: after.g.edges.filter((e) => !after.lone.has(e.target)) }
	await find.fill('payments')
	await panel.getByRole('button', { name: /^#payments/ }).click()
	await panel.getByRole('button', { name: 'Focus', exact: true }).click()
	await until('Focus changes the hash', async () => (await page.evaluate(() => location.hash)) === `#/graph/${encodeURIComponent('tag:payments')}`)
	const near1 = neighbourhood(visible, 'tag:payments', 1).graph
	const near2 = neighbourhood(visible, 'tag:payments', 2).graph
	await until('and shows only its neighbourhood', async () => (await nodesOf(page).count()) === near1.nodes.length)
	await page.getByRole('button', { name: '2 steps' }).click()
	await until('depth 2 adds more', async () => (await nodesOf(page).count()) === near2.nodes.length && near2.nodes.length > near1.nodes.length, 10_000)
	check('its counts are what is drawn', (await page.getByTestId('graph-counts').textContent()).includes(`${near2.nodes.length} nodes`))
	const groupSum = async (name, p = page) => (await p.getByRole('group', { name, exact: true }).getByRole('button').allTextContents()).reduce((n, t) => n + Number(t.match(/(\d+)\s*$/)?.[1] ?? 0), 0)
	check('in a focus the legend sums to the nodes drawn', (await groupSum('Node types')) === (await nodesOf(page).count()), `${await groupSum('Node types')} vs ${await nodesOf(page).count()}`)
	check('and the kinds to the connections drawn', (await groupSum('Connection kinds')) === (await edgesOf(page).count()), `${await groupSum('Connection kinds')} vs ${await edgesOf(page).count()}`)
	await shot('graph-fixture-focus-light')
	await page.reload()
	await until('a reload on the focus URL keeps it', async () => (await page.evaluate(() => location.hash)) === `#/graph/${encodeURIComponent('tag:payments')}` && (await nodesOf(page).count()) === near1.nodes.length, 15_000)
	await page.getByPlaceholder(/Search, or filter/).fill('Never retry')
	await until('filters still apply inside a focus', async () => (await page.locator('.wp-graph-svg [data-type="lesson"]').count()) === 1)
	await page.getByRole('button', { name: 'Clear filters' }).click()
	await until('and clear', async () => (await nodesOf(page).count()) === near1.nodes.length)
	await page.goBack()
	await until('Back restores the overview', async () => (await page.evaluate(() => location.hash)) !== `#/graph/${encodeURIComponent('tag:payments')}` && (await nodesOf(page).count()) === after.nodes, 15_000)
	await page.goto(ext(`dashboard.html#/graph/${encodeURIComponent('tag:payments')}`))
	await until('Focus by URL', async () => (await nodesOf(page).count()) === near1.nodes.length, 15_000)
	await page.getByRole('button', { name: 'Show everything' }).click()
	await until('Show everything leaves it', async () => (await page.evaluate(() => location.hash)) === '#/graph' && (await nodesOf(page).count()) === after.nodes)
	await page.goto(ext(`dashboard.html#/graph/${encodeURIComponent('e_gone')}`))
	await until('a focus on a node that is gone says so', async () => (await page.getByText('That is no longer in the Brain').count()) === 1, 15_000)
	await shot('graph-focus-gone')
	await page.getByRole('button', { name: 'Show everything' }).click()
	await until('with a way out', async () => (await nodesOf(page).count()) === after.nodes)
	check('leaving a focus puts every label back under its node', (await page.locator('.wp-graph-svg [data-side]').count()) === 0)

	// ── See connections, from the Brain page (R4) ───────────────────────────
	await page.goto(ext('dashboard.html#/brain'))
	await card('Idempotency keys').getByRole('link', { name: 'See connections' }).click()
	await until('See connections on a Brain card lands on that lesson\'s focus', async () => (await page.evaluate(() => location.hash)) === '#/graph/fx-yt' && (await panel.locator('article.wp-card strong', { hasText: 'Idempotency keys' }).count()) === 1 && (await nodesOf(page).count()) === neighbourhood(visible, 'fx-yt', 1).graph.nodes.length, 15_000)

	// ── both themes ─────────────────────────────────────────────────────────
	await page.emulateMedia({ colorScheme: 'dark' })
	await settle(200)
	await shot('graph-fixture-focus-dark')
	await page.getByRole('button', { name: 'Show everything' }).click()
	await arranged(page)
	await settle(200)
	await shot('graph-fixture-overview-dark')
	await page.emulateMedia({ colorScheme: 'light' })
}

/** A browser of its own, on a Brain written to a temp dir here and thrown away after. `start` sets the stand-in's switches before the first page. */
const onBrain = async (name, lines, fn, start = {}) => {
	const dir = mkdtempSync(join(tmpdir(), `workpulse-graph-${name}-`))
	const at = join(dir, 'bridge/entries/2026-10')
	mkdirSync(at, { recursive: true })
	writeFileSync(join(at, 'cli-generated.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
	const s = standIn(dir)
	Object.assign(s.mode, start)
	const b = await launch({ github: s.github })
	const p = await b.ctx.newPage()
	const errors = []
	p.on('pageerror', (e) => errors.push(e.message))
	try {
		await p.goto(b.ext('dashboard.html#/graph'))
		await fn(p, { ...b, files: s.files, log: s.log, mode: s.mode })
		check(`${name}: no page-script error`, errors.length === 0, errors.join(' | '))
	} finally {
		await b.close()
		rmSync(dir, { recursive: true, force: true })
	}
}
const entry = (id, i, more) => ({ schema: 'workpulse.bridge.entry/1', id, at: 1793000000000 - i * 3_600_000, device: 'cli-generated', kind: 'learning', scope: 'work', ...more })
const MAX_MEAN_MOVE = 40
const pngOf = (p, name) => p.screenshot({ path: join(SHOTS, `${name}.png`) })

/** R8: shaped like the real Brain (211 lessons, 134 tags of which 75 used once, 10 projects, 9 sourced lessons across 2 videos, 0 tickets), all made up here. */
const realShape = () => {
	let seed = 42
	const rnd = (n) => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * n
	const words = 'cache retry queue token build deploy parser layout worker schema migration session index render timeout webhook branch release sync payload'.split(' ')
	const tags = Array.from({ length: 134 }, (_, i) => `topic-${words[i % words.length]}-${i}`)
	const shared = tags.slice(0, 59)
	const lone = tags.slice(59)
	const lessons = Array.from({ length: 211 }, (_, i) => {
		const w = () => words[Math.floor(rnd(words.length))]
		return {
			title: `Synthetic lesson ${i + 1}: the ${w()} ${w()} needs a ${w()} before the ${w()}`,
			kind: i % 7 === 0 ? 'mistake' : i % 11 === 0 ? 'debug' : 'learning',
			tags: [],
			...(i < 190 ? { project: `Project ${String.fromCharCode(65 + (i < 10 ? i : Math.floor(rnd(1) ** 2 * 10)))}` } : {}),
		}
	})
	lone.forEach((t, i) => lessons[(i * 3) % 211].tags.push(t))
	// 285 more tag edges on 59 tags, unevenly: the first few are busy, as tags are.
	let left = 285
	for (let t = 0; t < shared.length; t++) {
		const n = t === shared.length - 1 ? left : Math.max(2, Math.min(left - 2 * (shared.length - t - 1), Math.round(38 / (1 + t * 0.35))))
		left -= n
		let placed = 0
		for (let i = Math.floor(rnd(211)); placed < n; i = (i + 13) % 211) {
			if (lessons[i].tags.includes(shared[t])) continue
			lessons[i].tags.push(shared[t])
			placed++
		}
	}
	return lessons.map((l, i) =>
		entry(`syn-${i}`, i, {
			...l,
			...(i < 5 ? { source: { type: 'youtube', url: `https://www.youtube.com/watch?v=synthA&t=${i * 60}`, title: 'A synthetic talk on queues', by: 'Nobody' } } : i < 9 ? { source: { type: 'youtube', url: `https://www.youtube.com/watch?v=synthB&t=${i * 60}`, title: 'Another synthetic talk', by: 'Nobody' } } : {}),
		}),
	)
}

const realShapeChecks = () =>
	onBrain('real-shape', realShape(), async (p, b) => {
		await p.getByRole('button', { name: 'Sync now' }).click().catch(() => undefined)
		const started = Date.now()
		await until('real-shape: all of it arrives', async () => (await nodesOf(p).count()) > 200, 20_000)
		await arranged(p)
		console.log(`    arranged ${await nodesOf(p).count()} nodes in about ${Date.now() - started} ms`)
		const view = await viewOf(p)
		const want = expectedOf(view.entries)
		const types = want.g.nodes.reduce((m, x) => ((m[x.type] = (m[x.type] ?? 0) + 1), m), {})
		check('real-shape: the generator made the shape asked for', types.lesson === 211 && types.tag === 134 && want.lone.size === 75 && types.project === 10 && types.source === 2 && !types.ticket, JSON.stringify(types))
		console.log(`    ${want.g.nodes.length} nodes, ${want.g.edges.length} edges in the Brain`)
		check('real-shape: the counts agree', (await nodesOf(p).count()) === want.nodes && (await p.getByTestId('graph-counts').textContent()).includes(`${want.nodes} nodes`))
		check('real-shape: Tags used once says 75', (await p.getByRole('button', { name: /^Tags used once \d+/ }).textContent()).includes('75'))
		check('real-shape: a mistake lesson has its ring', (await p.locator('.wp-graph-svg [data-type="lesson"] .wp-g-ring').count()) === view.entries.filter((e) => e.kind === 'mistake').length)
		await pngOf(p, 'graph-real-shape-overview-light')
		check('real-shape: no two visible hub labels overlap', (await labelOverlaps(p)).length === 0, JSON.stringify((await labelOverlaps(p)).slice(0, 3)))
		check('real-shape: a hub that gave way keeps its title', (await p.locator('.wp-graph-svg .is-crowded > title').count()) === (await p.locator('.wp-graph-svg .is-crowded').count()))
		const hubsShown = await p.evaluate(() => [...document.querySelectorAll('.wp-graph-svg .is-hub .wp-g-label')].filter((t) => getComputedStyle(t).display !== 'none').length)
		console.log(`    ${hubsShown} of ${await p.locator('.wp-graph-svg .is-hub').count()} hub labels shown on the overview`)
		const used = await p.evaluate(() => {
			const svg = document.querySelector('.wp-graph-svg').getBoundingClientRect()
			const linked = new Set([...document.querySelectorAll('.wp-graph-svg line')].flatMap((l) => [l.dataset.a, l.dataset.b]))
			const xs = [...document.querySelectorAll('.wp-graph-svg [data-node]')].filter((n) => linked.has(n.dataset.node)).map((n) => n.querySelector('.wp-g-mark').getBoundingClientRect())
			const w = Math.max(...xs.map((b) => b.right)) - Math.min(...xs.map((b) => b.left))
			const h = Math.max(...xs.map((b) => b.bottom)) - Math.min(...xs.map((b) => b.top))
			return Math.max(w / svg.width, h / svg.height)
		})
		console.log(`    the connected cluster spans ${Math.round(used * 100)}% of the canvas`)
		check('real-shape: the connected cluster uses most of the canvas', used > 0.8, String(used))

		// Does filtering keep the picture? Measured, and the way back is exact.
		const before = await placesOf(p)
		const legend = p.getByRole('group', { name: 'Node types' })
		await legend.getByRole('button', { name: /^Projects/ }).click()
		await until('real-shape: a legend press redraws', async () => (await p.locator('.wp-graph-svg [data-type="project"]').count()) === 0)
		await arranged(p)
		const during = await placesOf(p)
		const xy = (t) => t.match(/-?[\d.]+/g).map(Number)
		const meanMove = (a, b) => {
			const ids = Object.keys(b).filter((i) => a[i])
			return ids.reduce((sum, i) => sum + Math.hypot(xy(a[i])[0] - xy(b[i])[0], xy(a[i])[1] - xy(b[i])[1]), 0) / ids.length
		}
		// 40 units: a late start can carry a node at most the sum of its remaining ticks' heat, 39.4 at this size
		// (28 x (20 + ... + 1) / 200 + 20 x 0.5), and a spring is 56 long. So this is under one edge's length, and a
		// restart at full heat (484 when this was first measured) fails it twelve times over.
		const moved = meanMove(before, during)
		const spread = Math.max(...Object.values(during).map((t) => Math.hypot(...xy(t))))
		console.log(`    a legend press moved a surviving node ${moved.toFixed(1)} units on average, picture radius ${Math.round(spread)}`)
		check('real-shape: a legend press leaves the survivors where they were', moved < MAX_MEAN_MOVE, `${moved.toFixed(1)} units`)
		await legend.getByRole('button', { name: /^Projects/ }).click()
		await until('real-shape: pressing it back returns the same picture', async () => JSON.stringify(await placesOf(p)) === JSON.stringify(before))

		for (let i = 0; i < 5; i++) await p.getByRole('button', { name: 'Zoom in' }).click()
		await settle(200)
		await pngOf(p, 'graph-real-shape-zoomed-light')

		// The reader's place survives an archive in the panel, and a sync that brings one new lesson.
		const camera = await worldOf(p)
		const placesBefore = await placesOf(p)
		await p.getByLabel('Find a node').fill('Synthetic lesson 100')
		await p.getByTestId('graph-panel').getByRole('button', { name: /Synthetic lesson 100:/ }).click()
		await p.getByTestId('graph-panel').locator('article.wp-card').getByRole('button', { name: 'Archive', exact: true }).click()
		await until('real-shape: archiving in the panel takes it off', async () => (await p.locator('.wp-graph-svg [data-node="syn-99"]').count()) === 0, 15_000)
		await arranged(p)
		check('real-shape: and keeps the camera', (await worldOf(p)) === camera, `${camera} -> ${await worldOf(p)}`)
		const archivedMove = meanMove(placesBefore, await placesOf(p))
		console.log(`    archiving one lesson moved the rest ${archivedMove.toFixed(1)} units on average`)
		check('real-shape: and the nodes', archivedMove < MAX_MEAN_MOVE, archivedMove.toFixed(1))
		const placesSynced = await placesOf(p)
		b.files['bridge/entries/2026-10/cli-other.jsonl'] = JSON.stringify(entry('syn-new', -5, { title: 'A lesson from another device', tags: ['topic-cache-0'] })) + '\n'
		await p.getByRole('button', { name: 'Sync now' }).click()
		await until('real-shape: a sync draws the new lesson', async () => (await p.locator('.wp-graph-svg [data-node="syn-new"]').count()) === 1, 15_000)
		await arranged(p)
		check('real-shape: and keeps the camera too', (await worldOf(p)) === camera)
		const syncedMove = meanMove(placesSynced, await placesOf(p))
		console.log(`    a new lesson moved the rest ${syncedMove.toFixed(1)} units on average`)
		check('real-shape: and the nodes too', syncedMove < MAX_MEAN_MOVE, syncedMove.toFixed(1))
		await p.getByRole('button', { name: 'Fit' }).click()
		await p.locator('.wp-graph-svg [data-node="tag:topic-cache-0"]').waitFor({ state: 'attached' })
		await clickNode(p, 'tag:topic-cache-0')
		await settle(200)
		await pngOf(p, 'graph-real-shape-selected-light')
		await p.getByRole('button', { name: 'Focus', exact: true }).click()
		await until('real-shape: focus', async () => (await p.evaluate(() => location.hash)).startsWith('#/graph/'))
		await settle(300)
		await pngOf(p, 'graph-real-shape-focus-light')
		await p.getByRole('button', { name: '2 steps' }).click()
		await settle(300)
		await pngOf(p, 'graph-real-shape-focus2-light')
		await p.emulateMedia({ colorScheme: 'dark' })
		await settle(200)
		await pngOf(p, 'graph-real-shape-focus2-dark')
		await p.getByRole('button', { name: '1 step', exact: true }).click()
		await settle(300)
		await pngOf(p, 'graph-real-shape-focus-dark')
		await p.getByRole('button', { name: 'Show everything' }).click()
		await arranged(p)
		await settle(200)
		await pngOf(p, 'graph-real-shape-overview-dark')
	})

/** 1,300 lessons on 200 tags and 20 projects: 1,520 nodes, none of them a tag used once. */
const largeChecks = () => {
	const lines = Array.from({ length: 1300 }, (_, i) => entry(`big-${i}`, i, { title: `Generated lesson number ${i}`, project: `project-${i % 20}`, tags: [`tag-${i % 200}`, `tag-${(i * 7) % 200}`, `tag-${(i * 13 + 3) % 200}`] }))
	return onBrain('large', lines, async (p) => {
		await p.getByRole('button', { name: 'Sync now' }).click().catch(() => undefined)
		await until('large: the banner says how much is shown', async () => (await p.getByText('Showing 1,000 of 1,520, the most connected. Filter or focus to see the rest.').count()) === 1, 40_000)
		await until('large: Busy says it is arranging', async () => (await p.getByTestId('graph-busy').count()) === 1 || (await nodesOf(p).count()) === 1000, 5_000)
		const started = Date.now()
		await arranged(p)
		console.log(`    arranged 1,000 nodes in about ${Date.now() - started} ms after the banner`)
		check('large: never more than 1,000 drawn', (await nodesOf(p).count()) === 1000)
		const sum = async (name) => (await p.getByRole('group', { name, exact: true }).getByRole('button').allTextContents()).reduce((n, t) => n + Number(t.match(/(\d+)\s*$/)?.[1] ?? 0), 0)
		check('large: the legend sums to what is drawn, not to the Brain', (await sum('Node types')) === 1000 && (await sum('Connection kinds')) === (await edgesOf(p).count()))
		check('large: no two visible hub labels overlap', (await labelOverlaps(p)).length === 0, JSON.stringify((await labelOverlaps(p)).slice(0, 3)))
		const lag = await p.evaluate(() => new Promise((r) => { const t = performance.now(); setTimeout(() => r(performance.now() - t), 0) }))
		check('large: the page answers', lag < 500, `${Math.round(lag)} ms`)
		await pngOf(p, 'graph-1500-overview')
		await p.getByPlaceholder(/Search, or filter/).fill('repo:project-3')
		await until('large: a filter takes the banner away', async () => (await p.getByText(/Showing 1,000 of/).count()) === 0 && (await nodesOf(p).count()) < 1000, 10_000)
	})
}

/** Nothing written yet, then no repository at all. */
const emptyChecks = () =>
	onBrain('empty', [], async (p, b) => {
		await until('no entries: says how lessons get here', async () => (await p.getByTestId('graph-empty').count()) === 1, 15_000)
		check('no entries: and draws its picture', (await p.locator('.wp-card', { has: p.getByTestId('graph-empty') }).innerHTML()).includes('art/empty-notes.'))
		await pngOf(p, 'graph-empty')
		await b.sw.evaluate(async () => {
			const { settings = {} } = await chrome.storage.local.get('settings')
			await chrome.storage.local.set({ settings: { ...settings, syncRepo: '' } })
			await chrome.storage.local.remove('syncToken')
		})
		await p.reload()
		await until('not connected: asks to connect a repository', async () => (await p.getByText('Connect a repository first.').count()) === 1, 15_000)
		check('not connected: with a link to Settings → Backup', (await p.getByRole('link', { name: 'Settings → Backup' }).getAttribute('href')) === '#/settings/backup')
		await pngOf(p, 'graph-not-connected')
	})

/** Real GitHub's answer over 1 MB is no content at all: a Brain file past that must keep updating, and a write must only append. */
const bigFileChecks = () => {
	const pad = 'x'.repeat(400_000)
	const lines = [1, 2, 3, 4].map((i) => entry(`big-${i}`, i, { title: `A lesson with a long body ${i}`, body: pad }))
	return onBrain('big-file', lines, async (p, b) => {
		const path = 'bridge/entries/2026-10/cli-generated.jsonl'
		check('big-file: the file is over 1 MB', Buffer.byteLength(b.files[path]) > 1_000_000)
		await p.goto(b.ext('dashboard.html#/brain'))
		await until('big-file: its lessons appear', async () => (await viewOf(p)).entries.length === 4, 20_000)
		check('big-file: GitHub gave no content, so the blob was read', b.log.some((l) => l.includes('/contents/bridge/entries/2026-10/cli-generated.jsonl')) && b.log.some((l) => l.includes('/git/blobs/')))
		b.files[path] += `${JSON.stringify(entry('big-5', 0, { title: 'A lesson written later' }))}\n`
		await p.getByRole('button', { name: 'Sync now' }).click()
		await until('big-file: a line added later still arrives', async () => (await viewOf(p)).entries.length === 5, 20_000)
		check('big-file: no error shown', !(await viewOf(p)).error, (await viewOf(p)).error)
		// This browser's own file over 1 MB: writing must keep all of it and add one line.
		const { device } = await viewOf(p)
		const own = entriesPath(Date.now(), device)
		const before = `${[6, 7, 8, 9].map((i) => JSON.stringify({ ...entry(`own-${i}`, i, { title: `Own lesson ${i}`, body: pad }), device })).join('\n')}\n`
		b.files[own] = before
		await p.evaluate(() => chrome.runtime.sendMessage({ wp: 'call', method: 'bridgeAdd', args: [{ kind: 'note', scope: 'work', title: 'Written on top of a big file' }] }))
		await until('big-file: the write reached the file', async () => b.files[own] !== before)
		const added = b.files[own].slice(before.length)
		check('big-file: a write keeps the old text whole', b.files[own].startsWith(before), `${b.files[own].length} characters, was ${before.length}`)
		check('big-file: and adds one line', added.trim().split('\n').length === 1 && JSON.parse(added).title === 'Written on top of a big file', added.slice(0, 200))
	})
}

const FAILED_WORDS = /GitHub returned 503/

/** A poll that fails is not an empty Brain: every page says what happened, and none says "nothing saved". */
const failedPollChecks = () =>
	onBrain(
		'failed-poll',
		[],
		async (p, b) => {
			const banner = () => p.locator('.wp-banner', { hasText: FAILED_WORDS })
			// #/graph first, on a Brain it has never read.
			await until('failed poll: the graph shows the reason', async () => (await banner().count()) === 1, 15_000)
			// The stored reason can reach the page a moment before the look is over, so wait for the state, then read it.
			await until('failed poll: the graph says the look failed', async () => (await p.getByTestId('graph-failed').count()) === 1, 15_000)
			check('failed poll: and not that there are no lessons', (await p.getByTestId('graph-empty').count()) === 0)
			await pngOf(p, 'graph-poll-failed')
			await p.goto(b.ext('dashboard.html#/library'))
			await until('failed poll: the library shows the reason', async () => (await banner().count()) === 1, 15_000)
			await until('failed poll: and says the look failed', async () => (await p.getByTestId('library-failed').count()) === 1, 15_000)
			const text = await p.locator('body').textContent()
			check('failed poll: no "Nothing saved yet", no "off by default"', !text.includes('Nothing saved yet') && !text.includes('off by default'))
			await pngOf(p, 'library-poll-failed')
			// A look in flight, after a look that failed: still honest, on both pages.
			b.mode.treeDelayMs = 2500
			await p.reload()
			await settle(600)
			check('failed poll: while looking again the library keeps the reason', (await p.getByTestId('library-loading').count()) === 1 && (await banner().count()) === 1)
			await p.goto(b.ext('dashboard.html#/graph'))
			await settle(600)
			check('failed poll: and so does the graph', (await p.getByText('Looking in your repository').count()) === 1 && (await banner().count()) === 1)
			await pngOf(p, 'graph-looking-after-failed-poll')
			b.mode.treeDelayMs = 0
			b.mode.treeFail = 0
			await p.getByRole('button', { name: 'Sync now' }).click()
			await until('failed poll: when it works again the empty state is the plain one', async () => (await p.getByTestId('graph-empty').count()) === 1 && (await banner().count()) === 0)
			await p.goto(b.ext('dashboard.html#/library'))
			await until('failed poll: on the library too', async () => (await p.getByTestId('library-empty').count()) === 1 && (await p.locator('body').textContent()).includes('off by default') && (await banner().count()) === 0, 15_000)
		},
		{ treeFail: 503 },
	)

/** Every lesson archived: "Nothing matches" with a Clear that does nothing would be a lie and a dead button. */
const allArchivedChecks = () =>
	onBrain('all-archived', [entry('a1', 1, { title: 'The only lesson' }), entry('a1-gone', 0, { title: 'The only lesson', amends: 'a1', state: 'archived' })], async (p) => {
		const says = p.getByTestId('graph-all-archived')
		await until('all archived: it says so', async () => (await says.count()) === 1, 15_000)
		check('all archived: and points at the button by its name', (await says.locator('..').textContent()).includes('Archived 1'))
		check('all archived: no "Nothing matches", no Clear filters', (await p.getByText('Nothing matches that').count()) === 0 && (await p.getByRole('button', { name: 'Clear filters' }).count()) === 0)
		await pngOf(p, 'graph-all-archived')
		await p.getByRole('button', { name: /^Archived 1/ }).click()
		await until('all archived: the button it names draws them', async () => (await nodesOf(p).count()) >= 1 && (await says.count()) === 0)
		await p.getByRole('button', { name: /^Archived 1/ }).click()
		await until('all archived: and back', async () => (await says.count()) === 1)
		await p.getByPlaceholder(/Search, or filter/).fill('zebrafinch')
		await until('all archived: a typed filter still has its Clear', async () => (await p.getByText('Nothing matches that').count()) === 1)
		await p.getByRole('button', { name: 'Clear filters' }).first().click()
		await until('all archived: which works', async () => (await says.count()) === 1)
	})

// ── the real Brain, read only ────────────────────────────────────────────────
// No fixture, so nothing here knows what the Brain holds: each count is checked against what the page's own data says,
// and printed for comparing with `wp-brain`. Only Sync now, links and filters are pressed: none of them writes.
const realChecks = async () => {
	const call = (method, ...args) => page.evaluate(([m, a]) => chrome.runtime.sendMessage({ wp: 'call', method: m, args: a }).then((r) => r.result), [method, args])
	await page.goto(ext('dashboard.html#/brain'))
	const syncNow = page.getByRole('button', { name: 'Sync now' })
	await syncNow.click({ timeout: 30_000 })
	await until('Sync now finished', async () => (await syncNow.isEnabled({ timeout: 1000 }).catch(() => false)) && !!(await viewOf(page)).polledAt, 180_000)
	const view = await viewOf(page)
	check('GitHub answered without an error', !view.error, view.error)
	console.log(`    Brain: ${view.entries.length} active lessons, ${view.archived.length} archived`)
	await shot('real-brain')

	const tally = {}
	for (const e of view.entries) {
		const t = sourceOf(e)?.type ?? 'none'
		tally[t] = (tally[t] ?? 0) + 1
	}
	const row = page.getByRole('group', { name: 'Source' })
	const labels = view.entries.length ? (await row.getByRole('button').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim()) : []
	const want = Object.entries(tally).map(([t, c]) => `${t === 'none' ? 'No source' : SOURCE_LABEL[t]} ${c}`)
	check('the source filter counts are what the entries say', want.every((l) => labels.includes(l)) && labels.length === (view.entries.length ? want.length + 1 : 0), `${labels.join(' | ')} vs ${want.join(' | ')}`)
	console.log(`    source counts: ${want.join(', ') || 'none'} (compare: wp-brain list --source)`)

	await page.goto(ext('dashboard.html#/library'))
	await until('the library page answered', async () => (await page.getByTestId('library-loading').count()) === 0 && ((await cards().count()) > 0 || (await page.getByTestId('library-empty').count()) === 1), 60_000)
	const { items } = await call('bridgeLibrary')
	check('the library lists what the tree holds', (await cards().count()) === Math.min(items.length, 40), `${await cards().count()} vs ${items.length}`)
	console.log(`    library: ${items.length} saved (compare: wp-brain library list)`)
	await shot('real-library')
	const withNotes = items.find((i) => i.files.some((f) => f.name === 'notes.md'))
	if (withNotes) {
		await page.goto(ext(`dashboard.html#/library/${encodeURIComponent(withNotes.path)}`))
		const shown = page.locator('[data-testid="library-text"], [data-testid="library-pre"]')
		await until('a real notes.md opens', async () => (await shown.count()) === 1 && ((await shown.textContent()) ?? '').trim().length > 0, 60_000)
		await shot('real-library-notes')
	} else console.log('    no notes.md in the library, so none was opened')

	await page.goto(ext('dashboard.html#/graph'))
	if (!view.entries.length) {
		await until('no lessons: the graph says so', async () => (await page.getByTestId('graph-empty').count()) === 1, 60_000)
	} else {
		const expected = expectedOf(view.entries)
		await until('the graph draws', async () => (await nodesOf(page).count()) > 0, 60_000)
		await arranged(page)
		const [drawn, edges, counts] = [await nodesOf(page).count(), await edgesOf(page).count(), await page.getByTestId('graph-counts').textContent()]
		check('the graph\'s counts are what it drew', counts.includes(`${drawn} nodes`) && counts.includes(`${edges} connections`), `${counts} vs ${drawn}, ${edges}`)
		const banner = await page.getByText(/^Showing 1,000 of/).count()
		check('its banner is there only when it drew fewer', banner === (expected.nodes > 1000 ? 1 : 0) && drawn === Math.min(expected.nodes, 1000), `banner ${banner}, drew ${drawn} of ${expected.nodes}`)
		console.log(`    graph: ${drawn} nodes, ${edges} connections drawn; ${expected.g.nodes.length} in all, ${expected.lone.size} tags used once hidden (compare: wp-brain graph)`)
		await shot('real-graph-overview')
	}
	check('no page errors', problems.length === 0, problems.join(' | '))
	if (LOCAL_CLONE) {
		// Only for testing the guard: a write the page would never make, sent straight to the background.
		if (process.env.WP_PROVE_GUARD === '1') await page.evaluate(() => chrome.runtime.sendMessage({ wp: 'call', method: 'bridgeAsk', args: ['the guard must stop this'] }))
		const posted = log.filter((l) => !l.startsWith('GET '))
		check('the stand-in received no write', posted.length === 0 && Object.keys(files).length === seeded.size && Object.keys(files).every((p) => seeded.has(p)), posted.join(' | '))
	}
}

/** Runs this script again in the real mode, with GitHub played by the stand-in. Every path to a browser sets WP_STAND_IN_CLONE. */
const realModeChecks = async () => {
	const rerun = (env, args) =>
		new Promise((done) => {
			const c = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], { env: { ...process.env, WP_SHOTS: join(SHOTS, 'real-mode'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
			let out = ''
			c.stdout.on('data', (d) => (out += d))
			c.stderr.on('data', (d) => (out += d))
			c.on('close', (code) => done({ code, out }))
		})
	const real = { WP_GH_REPO: 'you/workpulse-notes', WP_GH_BRANCH: 'brain', WP_GH_TOKEN: 'stand-in-token' }
	// These three stop before any browser opens, so nothing can be asked of anyone.
	const noSwitch = await rerun(real, ['-'])
	check('real mode: refuses a real repository without WP_READ_ONLY=1', noSwitch.code === 2 && noSwitch.out.includes('Refusing'), noSwitch.out)
	const half = await rerun({ WP_GH_REPO: real.WP_GH_REPO, WP_READ_ONLY: '1' }, ['-'])
	check('real mode: refuses half a setup', half.code === 2 && half.out.includes('needs all of'), half.out)
	const fixture = await rerun({ ...real, WP_READ_ONLY: '1' }, [CLONE])
	check('real mode: refuses a fixture', fixture.code === 2 && fixture.out.includes('pass -'), fixture.out)
	const local = { ...real, WP_READ_ONLY: '1', WP_STAND_IN_CLONE: CLONE }
	const good = await rerun(local, ['-'])
	console.log(good.out.replace(/^/gm, '    | ').trimEnd())
	check('real mode: all its checks pass, and it writes nothing', good.code === 0 && good.out.includes('the stand-in received no write') && /all \d+ checks passed/.test(good.out), good.out.slice(-600))
	const caught = await rerun({ ...local, WP_PROVE_GUARD: '1' }, ['-'])
	check('real mode: a write is stopped before GitHub, and fails the run', caught.code === 1 && caught.out.includes('the stand-in received no write') && /not a GET.*POST \/repos\//s.test(caught.out), caught.out.slice(-600))
}

const run = async () => {
	if (READ_ONLY) return realChecks()
	if (process.env.ONLY === 'real-mode') return realModeChecks()
	const alone = { 'big-file': bigFileChecks, 'failed-poll': failedPollChecks, 'all-archived': allArchivedChecks }[process.env.ONLY]
	if (alone) return alone()
	if (process.env.ONLY === 'graph') {
		await graphChecks()
		await realShapeChecks()
		await largeChecks()
		await emptyChecks()
		check('no page errors', problems.length === 0, problems.join(' | '))
		return
	}
	// ── the Brain page: sync, then the source filter ───────────────────────────
	await page.goto(ext('dashboard.html#/brain'))
	await page.getByRole('button', { name: 'Sync now' }).click()
	await until('the fixture syncs: ten active entries', async () => (await cards().count()) === 10, 15_000)
	await shot('brain-all')

	const filterRow = page.getByRole('group', { name: 'Source' })
	const labels = (await filterRow.getByRole('button').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())
	check('source filter counts match the fixture', ['Any source', 'YouTube 4', 'Instagram 1', 'Site 2', 'No source 3'].every((l, i) => labels[i] === l), labels.join(' | '))
	check('types with no entries are hidden', !labels.some((l) => /WorkPulse|Session|Manual/.test(l)), labels.join(' | '))

	await filterRow.getByRole('button', { name: /^YouTube/ }).click()
	await settle(300)
	check('YouTube narrows to four (explicit, derived and two library lessons)', (await cards().count()) === 4)
	check('the pressed button says so', (await filterRow.getByRole('button', { name: /^YouTube/ }).getAttribute('aria-pressed')) === 'true')
	await shot('brain-filter-youtube')
	await filterRow.getByRole('button', { name: /^No source/ }).click()
	await settle(300)
	check('No source narrows to three', (await cards().count()) === 3)
	await filterRow.getByRole('button', { name: /^YouTube/ }).click()
	await page.getByPlaceholder(/Search, or filter/).fill('source:site')
	await settle(300)
	check('a typed source: wins over the buttons', (await cards().count()) === 2 && (await cards().first().textContent()).includes('Jitter breaks retry lockstep'))
	await page.getByPlaceholder(/Search, or filter/).fill('')
	await filterRow.getByRole('button', { name: /^Any source/ }).click()
	await settle(300)
	check('Any source shows all again', (await cards().count()) === 10)

	// ── the chip links out ─────────────────────────────────────────────────────
	const yt = card('Idempotency keys')
	const chip = yt.locator('a.wp-chip-source')
	check('the chip is a link to the video, in a new tab, safely', (await chip.getAttribute('href')) === 'https://www.youtube.com/watch?v=abc123&t=42' && (await chip.getAttribute('target')) === '_blank' && /noreferrer/.test((await chip.getAttribute('rel')) ?? ''))
	check('its tooltip carries the title and who made it', ((await chip.getAttribute('title')) ?? '').includes('Payments done right') && ((await chip.getAttribute('title')) ?? '').includes('A Channel'))
	check('a lesson with no source has no chip', (await card('Plain lesson about retries').locator('.wp-chip-source').count()) === 0)

	// ── a bad saved link does not take the page down ──────────────────────────
	await card('Lesson with a bad link').getByRole('button', { name: 'more' }).click()
	check('the bad link shows as text, not a link', (await card('Lesson with a bad link').getByText('not a url').count()) === 1 && (await card('Lesson with a bad link').locator('a[href="not a url"]').count()) === 0)
	check('the rest of the list is still there', (await cards().count()) === 10)

	// ── See connections ───────────────────────────────────────────────────────
	check('See connections points at the graph route', (await yt.getByRole('link', { name: 'See connections' }).getAttribute('href')) === '#/graph/fx-yt')

	// ── editing a source ──────────────────────────────────────────────────────
	const before = written().length
	await card('Derived from a legacy').getByRole('button', { name: 'Edit', exact: true }).click()
	check('the editor starts from the derived source', (await page.getByLabel('Source type').inputValue()) === 'youtube' && (await page.getByLabel('Source link').inputValue()) === 'https://youtu.be/legacy01')
	await page.getByRole('button', { name: 'Save changes' }).click()
	await settle(1200)
	check('saving an untouched old lesson writes nothing', written().length === before, `${written().length} vs ${before}`)
	await card('Derived from a legacy').getByRole('button', { name: 'Edit', exact: true }).click()
	await page.getByLabel('Title', { exact: true }).fill('Derived from a legacy video note, retitled #legacy')
	await page.getByRole('button', { name: 'Save changes' }).click()
	await until('a title change is written', () => written().length === before + 1)
	check('and it does not store the derived source', !('source' in (written().at(-1).set ?? {})), JSON.stringify(written().at(-1).set))

	await card('Plain lesson about retries').getByRole('button', { name: 'Edit', exact: true }).click()
	await page.getByLabel('Source type').selectOption('site')
	await page.getByLabel('Source link').fill('ftp://example.com/x')
	await page.getByRole('button', { name: 'Save changes' }).click()
	await settle(500)
	check('a non-http(s) source link is refused', (await page.getByText(/must start with http/).count()) === 1 && written().length === before + 1)
	await page.getByLabel('Source link').fill('https://example.com/retries')
	await page.getByLabel('Source title').fill('Retries explained')
	await shot('brain-edit-source')
	await page.getByRole('button', { name: 'Save changes' }).click()
	await until('the source change is written', () => written().length === before + 2)
	const set = written().at(-1).set
	check('exactly the source is in the change', Object.keys(set).join() === 'source' && set.source.type === 'site' && set.source.url === 'https://example.com/retries', JSON.stringify(set))
	await page.getByRole('button', { name: 'Sync now' }).click()
	await until('the card shows the new chip, as a link', async () => (await card('Plain lesson about retries').locator('a.wp-chip-source').getAttribute('href').catch(() => null)) === 'https://example.com/retries')
	await shot('brain-after-edit')

	// ── archive, restore ──────────────────────────────────────────────────────
	await card('Lesson with a bad link').getByRole('button', { name: 'Archive', exact: true }).click()
	await until('archive removes it from the list', async () => (await cards().filter({ hasText: 'Lesson with a bad link' }).count()) === 0)
	await page.getByRole('button', { name: /^Archived \d+/ }).click()
	await until('the archived list holds it and the earlier one', async () => (await cards().count()) === 2)
	await card('Lesson with a bad link').getByRole('button', { name: 'Restore' }).click()
	await settle(1200)
	await page.getByRole('button', { name: /^Archived/ }).click()
	await until('restore brings it back', async () => (await cards().filter({ hasText: 'Lesson with a bad link' }).count()) === 1 && (await cards().count()) === 10)

	// ── #/brain/entry=<id> ────────────────────────────────────────────────────
	await page.goto(ext('dashboard.html#/today'))
	await page.goto(ext(`dashboard.html#/brain/entry=${encodeURIComponent('fx-ticket')}`))
	await until('entry= shows that one entry', async () => (await cards().count()) === 1 && (await cards().first().textContent()).includes('Webhook retries on PAY-2433'))
	check('and it is open', (await cards().first().getByText('Make webhook retries safe').count()) === 1)
	await shot('brain-entry')

	// ── Learnings shows the chip on Brain lines ───────────────────────────────
	await page.goto(ext('dashboard.html#/journal'))
	await until('a Brain line on Learnings carries its source chip', async () => (await page.locator('.wp-chip-source', { hasText: 'YouTube' }).count()) >= 1)

	await popupChecks()
	await graphChecks()
	await realShapeChecks()
	await largeChecks()
	await emptyChecks()
	await bigFileChecks()
	await failedPollChecks()
	await allArchivedChecks()
	await libraryChecks()

	check('no page errors', problems.length === 0, problems.join(' | '))
	await realModeChecks()
}

let code = 0
try {
	await run()
	if (stopped.length) throw new Failed(`requests to GitHub that were not a GET, all stopped: ${stopped.join(', ')}`)
	console.log(`\nall ${n} checks passed`)
} catch (e) {
	code = 1
	console.error(`\nFAILED after ${n} ok: ${e.message}`)
	// A check that failed must not hide a write that was tried.
	if (stopped.length && !e.message.includes('not a GET')) console.error(`requests to GitHub that were not a GET, all stopped: ${stopped.join(', ')}`)
	await shot('failed').catch(() => undefined)
} finally {
	await close()
}
process.exit(code)
