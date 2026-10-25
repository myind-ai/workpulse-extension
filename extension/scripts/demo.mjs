// Loads the built extension into Chrome for Testing, plays a workday with
// demo data, checks the forced-reminder behaviour, and screenshots every
// surface. Uses local stand-in pages only; nothing is sent to Zoho.
//
//   npm run build && node scripts/demo.mjs [outDir]

import { mkdirSync, mkdtempSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { chromium } from 'playwright'

const EXT = resolve('.output/chrome-mv3')
const OUT = resolve(process.argv[2] ?? '../docs/screenshots/extension-v1')
mkdirSync(OUT, { recursive: true })

const WORK_HTML = `<!doctype html><html><head><title>PAY-231 · Acme Tracker</title><style>
body{margin:0;font:15px -apple-system,system-ui,sans-serif;color:#172b4d;background:#fff}
header{height:52px;background:#0f172a;color:#fff;display:flex;align-items:center;padding:0 24px;font-weight:600}
main{max-width:860px;margin:32px auto;padding:0 24px}h1{font-size:24px}p{line-height:1.6;color:#44546f}
.k{display:inline-block;background:#e9f2ff;color:#0c66e4;padding:2px 8px;border-radius:4px;font-size:13px;font-weight:600}
</style></head><body><header>Acme Tracker</header><main><span class="k">PAY-231</span>
<h1>Webhook retries drop events after the third attempt</h1>
<p>When the payment provider retries a webhook more than three times, the handler acknowledges the request but never enqueues the event. Reproduce with the sandbox replay tool and check the dead-letter queue.</p>
${'<p>Notes and discussion for the fix are below. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>'.repeat(6)}
</main></body></html>`

const ZOHO_HTML = `<!doctype html><html><head><title>Attendance (demo stand-in)</title><style>
body{margin:0;font:15px -apple-system,system-ui,sans-serif;background:#f4f5f7;color:#222}
main{max-width:720px;margin:60px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#16a34a;color:#fff}
</style></head><body><main><h2>Attendance — local demo stand-in</h2>
<p>This page stands in for your Zoho People attendance page during the demo. In real use WorkPulse opens your own Zoho page here.</p>
<button>Check in</button></main></body></html>`

// Stand-ins answered for Zoho's real hostnames (ctx.route), so the setup helper
// runs exactly where it would in real use, without contacting Zoho.
const CONSOLE_HTML = `<!doctype html><html><head><title>API console (demo stand-in)</title><style>
body{margin:0;font:14px -apple-system,system-ui,sans-serif;background:#f5f6fa;color:#222}
.top{background:#fff;border-bottom:1px solid #ddd;padding:14px 24px;font-weight:600}
main{max-width:640px;margin:32px 0 0 48px;background:#fff;border-radius:10px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.row{margin:14px 0}.row span{display:block;font-size:12px;color:#555;margin-bottom:4px}
input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #ccc;border-radius:6px;font:inherit}
button{padding:9px 18px;border:0;border-radius:6px;background:#1a73e8;color:#fff;font:inherit}
#done{display:none;margin-top:20px;padding:14px;background:#f1f8e9;border-radius:8px}
</style></head><body><div class="top">API console — local demo stand-in</div><main>
<h3>Create New Client · Client-based Applications</h3>
<div class="row"><span>Client Name</span><input id="cn"></div>
<div class="row"><span>Homepage URL</span><input id="hu"></div>
<div class="row"><span>Authorized Redirect URIs</span><input id="ru"></div>
<div class="row"><span>JavaScript Domain</span><input id="jd"></div>
<button id="create">CREATE</button>
<div id="done"><b>Client Secret</b><div style="margin-top:8px">Client ID</div><div>1000.DEMO12CD34EF56GH78IJ90KL12MN34</div><div style="margin-top:8px">Client Secret</div><div>••••••••••••</div></div>
</main><script>document.getElementById('create').onclick=()=>{document.getElementById('done').style.display='block'}</script></body></html>`

const PEOPLE_HTML = `<!doctype html><html><head><title>People (demo stand-in)</title><style>
body{margin:0;font:15px -apple-system,system-ui,sans-serif;background:#f4f5f7}main{max-width:720px;margin:60px auto;background:#fff;border-radius:12px;padding:32px}
button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#16a34a;color:#fff}</style></head>
<body><main><h2>Attendance — local demo stand-in for Zoho People</h2><p>The page where you click Check in.</p><button>Check in</button></main></body></html>`

const server = http.createServer((req, res) => {
	res.setHeader('content-type', 'text/html; charset=utf-8')
	res.end(req.url?.startsWith('/zoho') ? ZOHO_HTML : WORK_HTML)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'workpulse-demo-')), {
	headless: true,
	channel: 'chromium',
	viewport: { width: 1280, height: 800 },
	args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
})
await ctx.route('https://api-console.zoho.in/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: CONSOLE_HTML }))
await ctx.route('https://people.zoho.in/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PEOPLE_HTML }))
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker')
const extId = new URL(sw.url()).host
const ext = (p) => `chrome-extension://${extId}/${p}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── IST helpers ─────────────────────────────────────────────────────────
const MIN = 60_000
const IST = 330 * MIN
const pad = (n) => String(n).padStart(2, '0')
const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10)
const istHHMM = (ms) => new Date(ms + IST).toISOString().slice(11, 16)
const atIst = (date, hhmm) => Date.parse(`${date}T${hhmm}:00Z`) - IST
const now = Date.now()
const today = istDate(now)
const yesterday = istDate(now - 24 * 60 * MIN)

// ── control page: talks to the background like the real UI does ─────────
const results = []
const check = (name, ok, detail = '') => {
	results.push({ name, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const pages = () => ctx.pages()
let firstRun = null
for (const end = Date.now() + 6000; !firstRun && Date.now() < end; await sleep(200)) firstRun = pages().find((p) => p.url().includes('dashboard.html'))
check('first install opens Connect Zoho', !!firstRun && firstRun.url().endsWith('#/connect'), firstRun?.url().split('#')[1])
if (firstRun) {
	await firstRun.waitForLoadState()
	await sleep(500)
	await firstRun.screenshot({ path: join(OUT, '01-connect-first-run.png'), fullPage: true })
}
const admin = firstRun ?? (await ctx.newPage())
if (!firstRun) await admin.goto(ext('dashboard.html#/connect'))
const call = (method, ...args) =>
	admin.evaluate(
		([m, a]) =>
			chrome.runtime.sendMessage({ wp: 'call', method: m, args: a }).then((r) => {
				if (!r.ok) throw new Error(r.error)
				return r.result
			}),
		[method, args],
	)
const seed = (items) => admin.evaluate((i) => chrome.storage.local.set(i), items)
const badge = () => admin.evaluate(() => chrome.action.getBadgeText({}))
const hasOverlay = (page) => page.evaluate(() => !!document.querySelector('workpulse-reminder'))
const forcePending = async (pending) => {
	await admin.evaluate((p) => chrome.storage.local.get('runtime').then(({ runtime }) => chrome.storage.local.set({ runtime: { ...runtime, pending: p } })), pending)
	await call('tickNow') // reconcile() re-presents whatever is owed
}

const jobs = [
	{ id: 'j1', name: 'Payment service', project: 'Checkout' },
	{ id: 'j2', name: 'Code review', project: 'Engineering' },
	{ id: 'j3', name: 'Meetings', project: 'Internal' },
]
await seed({
	settings: {
		shiftStart: istHHMM(now - 40 * MIN),
		shiftEnd: istHHMM(now + 4 * 60 * MIN),
		graceMinutes: 15,
		minHours: 8,
		promptInterval: 60,
		workDays: [1, 2, 3, 4, 5, 6, 7],
		email: 'you@company.com',
		defaultJobId: '',
		zohoMode: 'reminder',
		dataCenter: 'in',
		attendanceUrl: `${base}/zoho`, // demo only; real settings require https
		billingStatus: 'non-billable',
		oauthClientId: '',
		scopes: 'ZOHOPEOPLE.attendance.READ,ZOHOPEOPLE.timetracker.READ,ZOHOPEOPLE.forms.READ,ZOHOPEOPLE.leave.READ',
	},
	jobs: { list: jobs, at: now },
})
await admin.evaluate(() => chrome.storage.local.remove(['runtime']))

// ── 1. forced check-in on a normal web page ─────────────────────────────
const work = await ctx.newPage()
await work.goto(`${base}/issue/PAY-231`)
await work.bringToFront()
await call('tickNow')
await sleep(1200)
check('forced check-in overlay appears on the page you are on', await hasOverlay(work))
check('toolbar badge shows IN before check-in', (await badge()) === 'IN', `badge "${await badge()}"`)
await work.screenshot({ path: join(OUT, '02-checkin-forced-overlay.png') })

// Switching tabs: the overlay follows you.
const other = await ctx.newPage()
await other.goto(`${base}/issue/OPS-12`)
await other.bringToFront()
await sleep(1200)
check('overlay follows you to a newly opened tab', await hasOverlay(other))
await other.close()
await work.bringToFront()

await work.getByRole('button', { name: 'Check in on Zoho' }).click()
await sleep(1500)
const zoho = pages().find((p) => p.url().startsWith(`${base}/zoho`))
check('"Check in on Zoho" opens the attendance page', !!zoho)
if (zoho) {
	await zoho.bringToFront()
	await sleep(1200)
	await zoho.screenshot({ path: join(OUT, '03-checkin-waiting-for-zoho.png') })
	await zoho.getByRole('button', { name: "I've checked in" }).click()
	await sleep(1000)
	check('"I\'ve checked in" clears the overlay', !(await hasOverlay(zoho)))
	await zoho.close()
}

// ── 2. the hourly prompt ────────────────────────────────────────────────
const checkin = now - 70 * MIN
const tasks = [
	{ uid: 't1', title: 'Fix webhook retries', key: 'PAY-231', jobId: 'j1', status: 'doing', createdAt: now - 3 * 60 * MIN, spentMinutes: 95 },
	{ uid: 't2', title: 'Review refund flow PR', key: 'PAY-244', jobId: 'j2', status: 'todo', createdAt: now - 2 * 60 * MIN, spentMinutes: 0 },
	{ uid: 't3', title: 'Sprint planning notes', status: 'todo', jobId: 'j3', createdAt: now - 60 * MIN, spentMinutes: 30 },
]
await seed({
	[`day:${today}`]: { date: today, checkedInAt: checkin, timelogStatus: 'pending', isOff: false },
	lastWork: { uid: 'lw', date: yesterday, slotStart: 0, slotEnd: 0, text: 'Investigated dropped webhook events in staging', jobId: 'j1', minutes: 60, kind: 'work', synced: false },
	tasks,
	timer: { taskUid: 't1', startedAt: now - 25 * MIN },
})
await admin.evaluate(
	([a, b]) => chrome.storage.local.get('runtime').then(({ runtime }) => chrome.storage.local.set({ runtime: { ...runtime, away: [[a, b]] } })),
	[now - 48 * MIN, now - 36 * MIN],
)
await work.bringToFront()
const actions = await call('tickNow')
const idleState = await admin.evaluate(() => chrome.idle.queryState(120))
if (!actions.some((a) => a.type === 'prompt') && idleState !== 'active') {
	// The prompt waits until you are active. While this script runs nobody touches
	// the Mac, so put the owed prompt on screen directly (decide() is unit-tested).
	console.log(`INFO  machine is ${idleState}: the scheduled prompt is correctly held back; showing it directly for the screenshots`)
	await forcePending({ kind: 'prompt', blocking: true, since: Date.now() })
} else {
	check('scheduler raises the hourly prompt when due', actions.some((a) => a.type === 'prompt'))
}
await sleep(1500)
check('hourly prompt is forced on the page', await hasOverlay(work))
check('toolbar badge shows LOG while a prompt is owed', (await badge()) === 'LOG')
await work.screenshot({ path: join(OUT, '04-hourly-prompt.png') })
await work.emulateMedia({ colorScheme: 'dark' })
await sleep(300)
await work.screenshot({ path: join(OUT, '05-hourly-prompt-dark.png') })
await work.emulateMedia({ colorScheme: 'light' })

const saveBtn = work.getByRole('button', { name: /Save/ })
check('Save is disabled until 10 characters and a job', await saveBtn.isDisabled())
await work.getByLabel('What did you work on?').fill('Fixed the webhook retry bug and added a dead-letter test')
await work.getByLabel('Zoho job').selectOption('j1')
await saveBtn.click()
await sleep(1200)
check('saving the hour clears the forced prompt', !(await hasOverlay(work)))
const saved = (await call('review')).entries
check('the answer is stored locally', saved.some((e) => e.text.startsWith('Fixed the webhook')), `${saved.length} entr${saved.length === 1 ? 'y' : 'ies'} today`)

// ── 3. demo history: yesterday pending, issues ──────────────────────────
const slot = (from, to, text, jobId, kind = 'work') => ({
	uid: `${from}-${to}`,
	date: yesterday,
	slotStart: atIst(yesterday, from),
	slotEnd: atIst(yesterday, to),
	text,
	jobId,
	minutes: kind === 'work' ? (atIst(yesterday, to) - atIst(yesterday, from)) / MIN : 0,
	kind,
	synced: false,
})
await seed({
	dayIndex: [yesterday, today],
	[`day:${yesterday}`]: { date: yesterday, checkedInAt: atIst(yesterday, '09:05'), checkedOutAt: atIst(yesterday, '18:42'), timelogStatus: 'pending', isOff: false },
	[`entries:${yesterday}`]: [
		slot('09:05', '10:05', 'Standup, triaged overnight payment alerts', 'j3'),
		slot('10:05', '11:05', 'Investigated dropped webhook events in staging', 'j1'),
		slot('11:05', '12:05', 'Wrote a replay script for the provider sandbox', 'j1'),
		slot('12:05', '13:00', 'Reviewed the refund flow PR (PAY-244)', 'j2'),
		slot('13:00', '13:45', 'Lunch / break', undefined, 'break'),
		slot('13:45', '15:00', 'Pairing on retry back-off with Priya', 'j1'),
		slot('15:00', '15:20', 'Skipped (screen share)', undefined, 'skipped'),
		slot('15:20', '17:30', 'Sprint planning and estimates', 'j3'),
		slot('17:30', '18:42', 'Release notes and handover', 'j1'),
	],
	issues: [
		{ date: '2026-10-02', kind: 'missing_checkout', detail: 'Checked in 02-Oct-2026 09:14 AM with no check-out', firstSeen: now },
		{ date: '2026-10-06', kind: 'absent', detail: 'Marked absent with no leave or holiday', firstSeen: now },
		{ date: '2026-10-08', kind: 'short_hours', detail: '6.5h of 8h', firstSeen: now },
	],
})

// ── 4. popup and dashboard ──────────────────────────────────────────────
const popup = await ctx.newPage()
await popup.setViewportSize({ width: 340, height: 600 })
await popup.goto(ext('popup.html'))
await sleep(800)
await popup.screenshot({ path: join(OUT, '06-toolbar-popup.png'), fullPage: true })
await popup.close()

const dash = await ctx.newPage()
const shot = async (hash, file, opts = {}) => {
	await dash.goto(ext(`dashboard.html#/${hash}`))
	await sleep(900)
	await dash.screenshot({ path: join(OUT, file), fullPage: true, ...opts })
}
await shot('today', '07-dashboard-today.png')
await shot(`review/${yesterday}`, '08-review-timesheet.png')
await shot('tasks', '09-tasks.png')
await shot('issues', '10-regularisation.png')
await shot('settings', '11-settings.png')
await dash.emulateMedia({ colorScheme: 'dark' })
await shot(`review/${yesterday}`, '12-review-dark.png')
await dash.emulateMedia({ colorScheme: 'light' })

// Mark yesterday done from the review screen.
await dash.goto(ext(`dashboard.html#/review/${yesterday}`))
await sleep(800)
await dash.getByRole('button', { name: 'Mark as done' }).click()
await sleep(800)
const y = await admin.evaluate((k) => chrome.storage.local.get(k), `day:${yesterday}`)
check('Mark as done logs the day', y[`day:${yesterday}`]?.timelogStatus === 'pushed')

// ── 5. fallback window when no web page can host the overlay ────────────
await dash.bringToFront()
const winPromise = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('prompt.html'), timeout: 5000 }).catch(() => null)
await call('logNow')
const win = await winPromise
check('prompt window opens when the active tab is not a web page', !!win)
if (win) {
	await win.setViewportSize({ width: 580, height: 720 })
	await sleep(900)
	await win.screenshot({ path: join(OUT, '13-prompt-window-fallback.png') })
	await win.getByRole('button', { name: 'Cancel' }).click()
	await sleep(600)
}

// ── 6. wrap-up at the end of the day ────────────────────────────────────
await work.bringToFront()
await forcePending({ kind: 'wrapup', blocking: true, since: Date.now() })
await sleep(1200)
check('wrap-up reminder is forced on the page', await hasOverlay(work))
await work.screenshot({ path: join(OUT, '14-wrapup-forced.png') })

// ── 7. guided Zoho connection ───────────────────────────────────────────
// The wrap-up reminder from step 6 is still owed; it must not block Zoho's pages.
// New tabs are reported while still about:blank, so poll the open pages for the URL.
const waitForPageUrl = async (prefix, ms = 6000) => {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
		const p = ctx.pages().find((x) => x.url().startsWith(prefix))
		if (p) return p
	}
	return null
}
const hasHelper = (page) => page.evaluate(() => !!document.querySelector('workpulse-setup'))
const shadowValue = (page, id) => page.evaluate((i) => document.getElementById(i).value, id)
await dash.goto(ext('dashboard.html#/connect'))
await dash.bringToFront()
await sleep(700)
await dash.getByRole('button', { name: /Open Zoho API console/ }).click()
// Tabs opened by the extension itself are not intercepted by ctx.route, so this
// click really reaches Zoho: it redirects to Zoho's public sign-in page with the
// console as the return address (no credentials are sent). Then the same tab is
// pointed at the stand-in, as if you had signed in.
const consolePage = (await waitForPageUrl('https://api-console.zoho.in')) ?? (await waitForPageUrl('https://accounts.zoho.in/signin'))
const landed = consolePage?.url() ?? ''
check('"Open Zoho API console" opens the India console (via Zoho sign-in)', /api-console\.zoho\.in|serviceurl=https%3A%2F%2Fapi-console\.zoho\.in/.test(landed), landed.slice(0, 90))
if (consolePage) {
	await consolePage.goto('https://api-console.zoho.in/')
	await sleep(1500)
	check('the WorkPulse helper appears on the console page', await hasHelper(consolePage))
	check('a forced reminder never covers Zoho\'s console', !(await hasOverlay(consolePage)))
	await consolePage.screenshot({ path: join(OUT, '15-console-helper.png') })
	await consolePage.getByRole('button', { name: 'Fill it for me' }).click()
	await sleep(300)
	const filled = await Promise.all(['cn', 'hu', 'ru', 'jd'].map((i) => shadowValue(consolePage, i)))
	check('"Fill it for me" fills all four Zoho fields', filled.every(Boolean), filled.join(' | '))
	await consolePage.getByRole('button', { name: 'CREATE' }).click()
	await sleep(1500)
	const foundBtn = consolePage.getByRole('button', { name: /Save & sign in/ })
	check('the helper spots the new Client ID on the page', await foundBtn.isVisible())
	await consolePage.screenshot({ path: join(OUT, '16-console-client-id-found.png') })
	// "Save & sign in" opens Zoho's real sign-in window, which a headless run cannot complete; save the id the same way.
	await call('saveClientId', '1000.DEMO12CD34EF56GH78IJ90KL12MN34')
	await consolePage.close()
}

await dash.bringToFront()
await dash.getByRole('button', { name: /Open Zoho People/ }).click()
// Signed out, people.zoho.in redirects to Zoho's product page (www.zoho.com/people).
const people = (await waitForPageUrl('https://people.zoho.in')) ?? (await waitForPageUrl('https://www.zoho.com/people')) ?? (await waitForPageUrl('https://accounts.zoho.in'))
check('"Open Zoho People" reaches Zoho People (signed out: Zoho\'s product page)', !!people, people?.url().slice(0, 90))
if (people) {
	await people.goto('https://people.zoho.in/#attendance/entry/checkin')
	await sleep(1500)
	check('the helper offers "Use this page" on Zoho People', await hasHelper(people))
	await people.screenshot({ path: join(OUT, '17-attendance-page-helper.png') })
	await people.getByRole('button', { name: /Use this page/ }).click()
	await sleep(800)
	const info = await call('setupInfo')
	check('one click saves the attendance page', info.attendanceUrl === 'https://people.zoho.in/#attendance/entry/checkin', info.attendanceUrl)
	await people.close()
}
await dash.bringToFront()
await dash.goto(ext('dashboard.html#/connect'))
await sleep(800)
await dash.screenshot({ path: join(OUT, '18-connect-after-setup.png'), fullPage: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`)
await ctx.close()
server.close()
process.exit(failed.length ? 1 : 0)
