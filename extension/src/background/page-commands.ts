// The no-API path, for roles Zoho answers with "your role is not allowed to
// access api's". Nothing here needs a token: the reader runs on your own
// signed-in Zoho People tab, so its fetch is same-origin and the browser
// attaches your session itself — no CORS, no admin, no new permission.
//
// Order of work: record which endpoints Zoho's own web app calls → point the
// reader at one → it reports the reply here. The DOM read in core/zoho-page.ts
// is the fallback for when an endpoint moves.

import { parseCurl } from '@/core/curl'
import { blank } from '@/core/rules'
import { istDate, MIN } from '@/core/time'
import type { Day } from '@/core/types'
import { classifyRequest, punchUrl, timeOn, timesheetBody, usable, writeLooking, type PageAttendance } from '@/core/zoho-page'
import { allowed } from '@/core/zoho-parse'
import type { ReadSource, SeenRequest } from '@/lib/store'

import type { PushResult } from './review-commands'
import { SetupCommands } from './setup-commands'

/** What the injected reader asks for before it does anything. */
export interface PageTask {
	req?: SeenRequest
	/** Today in IST: the worker owns the clock, the content script does not. */
	date: string
	/** Header name Zoho's own calls carry, mirrored from the cookie of the same name. */
	csrfHeader?: string
	/** Refresh the project and task names too, using these recorded calls. */
	catalog?: { projects?: SeenRequest; jobs?: SeenRequest }
}

const CSRF = /csrf|csr$/i
/** Just enough of a row to tell whether a captured call is a timesheet save. */
const SAMPLE_ROW = { date: '2026-01-01', minutes: 0, workItem: '', description: '' }

export class PageCommands extends SetupCommands {
	/** Armed by your click, handed to the injected script once, then cleared. */
	private armedPunch: { url: string; checkIn: boolean } | null = null
	private armedWrite: { url: string; contentType?: string; bodies: string[]; date: string; uids: string[] } | null = null

	async pageState() {
		const p = await this.store.pageSource()
		const rt = await this.store.runtime()
		return { ...p, recording: this.env.ui.recording?.() ?? false, roleBlocked: !!rt.roleBlocked }
	}

	/**
	 * The whole setup without DevTools: open Zoho, watch what its own pages ask
	 * for while you click around, and keep the ones WorkPulse needs. Everything
	 * else on this path exists for when this does not work.
	 */
	async startAutoSetup(): Promise<void> {
		await this.startRecording()
		await this.env.ui.openUrl((await this.store.settings()).attendanceUrl)
		this.env.ui.changed()
	}

	async startRecording(): Promise<void> {
		// Keeps what you pasted: wiping the list here used to throw away a
		// timesheet save the moment you started a recording.
		this.env.ui.record?.(true)
		this.env.ui.changed()
	}

	async forgetCalls(): Promise<void> {
		await this.store.updatePageSource((p) => {
			p.seen = []
			p.req = undefined
		})
		this.env.ui.changed()
	}

	/** Which of the four jobs WorkPulse can do with what it has been given. */
	async wiring() {
		const found = this.sources((await this.store.pageSource()).seen)
		return {
			attendance: !!found.attendance,
			tasks: !!found.jobs,
			save: !!found.write,
			logged: !!found.timesheet,
		}
	}

	async stopRecording(): Promise<void> {
		this.env.ui.record?.(false)
		this.env.ui.changed()
	}

	/**
	 * "Paste a curl": the quickest way to hand WorkPulse one of Zoho's own calls,
	 * copied straight from DevTools. Cookies in the paste are discarded by the
	 * parser, and a write is kept out of the reader's reach as usual.
	 */
	async addCurl(text: string) {
		const c = parseCurl(text)
		if (!c) throw new Error('That does not look like a copied curl command. Use DevTools → right-click the request → Copy as cURL.')
		if (!/^https:\/\/[a-z0-9.-]*\.zoho\.(in|com|eu|com\.au)\//i.test(c.url)) throw new Error('That call is not a Zoho address.')
		const req: SeenRequest = { at: this.now(), method: c.method, url: c.url, body: c.body, contentType: c.contentType, headers: c.headers, pinned: true }
		await this.noteRequest(req)
		// A timesheet save is not classified (the reader must never see a write),
		// so name it here — otherwise pasting one looks like it was not understood.
		const kind = classifyRequest(req.url, req.body) ?? (timesheetBody(req.body, SAMPLE_ROW) ? ('write' as const) : null)
		if (kind === 'attendance') await this.store.updatePageSource((p) => void (p.req = req))
		this.env.ui.changed()
		return { kind, url: req.url }
	}

	/** Called by the webRequest listener in the background, once per Zoho XHR. */
	async noteRequest(r: SeenRequest): Promise<void> {
		// The timesheet save is the one request the push depends on, and the rarest
		// thing you will ever do — one save against a thousand reads. Unpinned it
		// was eventually pushed out of the list by ordinary traffic, and the Push
		// button quietly became a Copy button days later. Pin it on sight.
		const save = !r.pinned && timesheetBody(r.body, SAMPLE_ROW) != null
		const req = save ? { ...r, pinned: true } : r
		// Same URL with a different body is a different call (Zoho's modes ride in
		// the body), so dedupe on all three.
		await this.store.updatePageSource((p) => {
			p.seen = [req, ...p.seen.filter((s) => s.url !== req.url || s.method !== req.method || s.body !== req.body)]
		})
	}

	/**
	 * Saves the request to replay and tries it once on your open Zoho tab.
	 * A request that could punch you in or out is refused outright: on this path
	 * WorkPulse only ever reads, exactly as it promises on the API path.
	 */
	async useEndpoint(req: SeenRequest) {
		if (!/^https:\/\/[a-z0-9.-]*\.zoho\.(in|com|eu|com\.au)\//i.test(req.url)) throw new Error('Use a https://…zoho… address from the recorded list.')
		const write = writeLooking(req.url, req.body)
		if (write) throw new Error(`That call writes to Zoho ("${write}"). WorkPulse only reads here — pick a status or report call instead.`)
		await this.store.updatePageSource((p) => void (p.req = req))
		return this.readZohoPage()
	}

	/** What the injected reader should do. */
	async pageTask(): Promise<PageTask> {
		const p = await this.store.pageSource()
		const header = p.seen.flatMap((s) => Object.keys(s.headers ?? {})).find((k) => CSRF.test(k))
		const found = this.sources(p.seen)
		const catalogAt = await this.store.jobsUpdatedAt()
		return {
			req: p.req ?? found.attendance,
			date: istDate(this.now()),
			csrfHeader: header,
			// The project and task names change rarely; once a day is plenty.
			catalog: catalogAt != null && this.now() - catalogAt < 24 * 60 * MIN ? undefined : { projects: found.projects, jobs: found.jobs },
		}
	}

	/** The recorded calls, sorted by what each one is for. */
	private sources(seen: SeenRequest[]) {
		const out: Partial<Record<'attendance' | 'projects' | 'jobs' | 'timesheet' | 'write', SeenRequest>> = {}
		for (const s of seen) {
			const kind = classifyRequest(s.url, s.body)
			if (kind && !out[kind]) out[kind] = s
			// The timesheet save is kept apart from everything the reader can see:
			// it is only ever reached from an explicit push.
			else if (!out.write && timesheetBody(s.body, SAMPLE_ROW)) out.write = s
		}
		return out
	}

	/** Projects and their tasks, as the hourly prompt's dropdown. */
	async reportCatalog(jobs: { id: string; name: string; project: string }[]): Promise<void> {
		if (!jobs.length) return
		await this.store.saveJobs(jobs, this.now())
		this.env.ui.changed()
	}

	/**
	 * A Zoho People tab just finished loading: catch up right then, rather than
	 * waiting for the next tick. Throttled, because Zoho's own app navigates a
	 * lot and every load would otherwise mean another read.
	 */
	async syncOnZohoTab(): Promise<void> {
		const rt = await this.store.runtime()
		if (rt.lastSync != null && this.now() - rt.lastSync < 30_000) return
		await this.store.updateRuntime((r) => void (r.lastSync = this.now()))
		const apiUsable = !rt.roleBlocked && (await this.zoho.hasAuth())
		if (apiUsable) await this.engine.syncAttendance(istDate(this.now())).catch(() => undefined)
		else await this.env.ui.readZohoPage?.().catch(() => undefined)
	}

	/**
	 * Pushes the day's rows through Zoho's own timesheet save, for roles the API
	 * refuses. Same gate as the API push (Time-logs or Full mode), same trigger:
	 * your click in Review. Each row is molded from your captured save, so the
	 * org's ids stay exactly as Zoho wrote them.
	 */
	async pushDay(date: string, rows: { jobId?: string; minutes: number; description: string; workItem?: string; from?: number; to?: number }[], uids: string[] = []) {
		const rt = await this.store.runtime()
		const apiUsable = !rt.roleBlocked && (await this.zoho.hasAuth())
		if (!apiUsable) return this.pushDayViaPage(date, rows, uids)
		return super.pushDay(date, rows, uids)
	}

	async pushDayViaPage(date: string, rows: { jobId?: string; minutes: number; description: string; workItem?: string }[], uids: string[] = []): Promise<PushResult> {
		const s = await this.store.settings()
		if (!allowed(s.zohoMode, 'timelog')) throw new Error('Pushing needs Time-logs or Full mode.')
		const template = this.sources((await this.store.pageSource()).seen).write
		if (!template?.body) {
			throw new Error(
				'WorkPulse has no timesheet save to copy yet. Save one row by hand in Zoho, then DevTools → Network → right-click addUpdateRecord.zp → Copy as cURL, and paste it under Connect Zoho → "Paste a call from Zoho".',
			)
		}
		const bad = rows.findIndex((r) => !(r.minutes > 0))
		if (bad >= 0) throw new Error(`Row ${bad + 1} has no time on it.`)
		const bodies = rows.map((r) =>
			timesheetBody(template.body, {
				date,
				minutes: Math.round(r.minutes),
				workItem: (r.workItem || r.description).slice(0, 200),
				description: r.description,
				jobId: r.jobId,
			}),
		)
		if (bodies.some((b) => b == null)) throw new Error('That captured call is not a timesheet save.')
		this.armedWrite = { url: template.url, contentType: template.contentType, bodies: bodies as string[], date, uids }
		const sent = (await this.env.ui.writeZohoPage?.()) ?? false
		if (!sent) {
			this.armedWrite = null
			throw new Error('Open your Zoho People tab first, then push again.')
		}
		return { status: 'pushing' as const, done: [], message: `Saving ${bodies.length} row${bodies.length === 1 ? '' : 's'} in Zoho…` }
	}

	/** Handed to the injected writer once, then cleared. */
	async writeTask() {
		const armed = this.armedWrite
		this.armedWrite = null
		return armed
	}

	/** What Zoho said to each row. Only rows it accepted are marked as logged. */
	async reportTimelogs(r: { date: string; results: { ok: boolean; status: number; body: string }[]; uids?: string[] }): Promise<void> {
		const done = r.results.filter((x) => x.ok).length
		await this.store.updatePageSource((p) => void (p.write = { at: this.now(), date: r.date, done, total: r.results.length, failures: r.results.filter((x) => !x.ok).map((x) => x.body || `HTTP ${x.status}`) }))
		// All or nothing: a half-written day must not look logged.
		if (done === r.results.length && done > 0) {
			if (r.uids?.length) await this.markEntriesSynced(r.date, r.uids)
			else await this.markDone(r.date)
		}
		else {
			const why = r.results.find((x) => !x.ok)?.body
			await this.store.updateRuntime(
				(rt) => void (rt.lastError = `Zoho accepted ${done} of ${r.results.length} rows${why ? ` — it said: ${why.slice(0, 160)}` : ''}. Check the timesheet in Zoho before pushing again.`),
			)
		}
		this.env.ui.changed()
	}

	/** Injects the reader into an open Zoho People tab; it reports back below. */
	async readZohoPage() {
		const injected = (await this.env.ui.readZohoPage?.()) ?? false
		if (!injected) throw new Error('Open your Zoho People tab first, then read again.')
		return this.pageState()
	}

	/**
	 * Check in or out. Prefers Zoho's own page call whenever the API cannot be
	 * used, so the button does the whole job in one click instead of opening Zoho
	 * for you to click again. Still Full mode only, still only from your click.
	 */
	protected async punch(checkIn: boolean) {
		const s = await this.store.settings()
		const rt = await this.store.runtime()
		const apiUsable = !rt.roleBlocked && (await this.zoho.hasAuth())
		if (allowed(s.zohoMode, 'attendance') && !apiUsable) {
			// No Zoho tab to punch on: fall through, which opens one.
			const sent = await this.punchViaPage(checkIn).catch(() => null)
			if (sent) return sent
		}
		return super.punch(checkIn)
	}

	/**
	 * The punch the injected script should send. Built from your data centre, not
	 * from a capture, and only ever handed out after `punchViaPage()` armed it —
	 * so nothing can punch without your click.
	 */
	async punchTask(): Promise<{ url: string; checkIn: boolean; token?: string } | null> {
		const armed = this.armedPunch
		this.armedPunch = null
		return armed ? { ...armed, token: await this.recordedToken() } : null
	}

	/** The csrf token Zoho's own calls carried, as a last resort for the punch. */
	private async recordedToken(): Promise<string | undefined> {
		const { seen } = await this.store.pageSource()
		for (const s of seen) {
			const hit = [...new URLSearchParams(s.body ?? '')].find(([k, v]) => CSRF.test(k) && /^[a-f0-9]{32,}$/i.test(v))
			if (hit) return hit[1]
		}
		return undefined
	}

	/**
	 * Checks you in or out through Zoho's own page call. Needs Full mode, the
	 * same gate the API punch uses, so the mode switch keeps meaning what it says.
	 */
	async punchViaPage(checkIn: boolean): Promise<{ result: 'punching' }> {
		const s = await this.store.settings()
		if (!allowed(s.zohoMode, 'attendance')) throw new Error('Switch to Full mode in Settings to let WorkPulse punch for you.')
		this.armedPunch = { url: punchUrl(s.dataCenter, checkIn), checkIn }
		const sent = (await this.env.ui.punchZohoPage?.()) ?? false
		if (!sent) {
			this.armedPunch = null
			throw new Error('Open your Zoho People tab first, then press it again.')
		}
		return { result: 'punching' }
	}

	/**
	 * The punch result. Zoho's reply is not trusted for the time: `awaiting` is
	 * set and the reader confirms from Zoho's own status, so what WorkPulse
	 * records is what Zoho recorded.
	 */
	async reportPunch(r: { checkIn: boolean; ok: boolean; status: number; body: string; located: boolean }): Promise<void> {
		await this.store.updatePageSource((p) => void (p.punch = { at: this.now(), ...r }))
		// Quote Zoho's own words when it gave any: "HTTP 400" alone tells you nothing.
		const why = r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
		await this.store.updateRuntime((rt) => {
			rt.awaiting = r.ok ? (r.checkIn ? 'in' : 'out') : rt.awaiting
			rt.lastError = r.ok
				? undefined
				: `Zoho would not accept the punch${r.status ? ` (HTTP ${r.status})` : ''}${why ? `: ${why}` : ''}. Do it in Zoho and press "I've checked ${r.checkIn ? 'in' : 'out'}".`
		})
		this.env.ui.changed()
		if (r.ok) await this.env.ui.readZohoPage?.().catch(() => false)
	}

	async reportProbe(r: { url: string; status: number; ok: boolean; body: string }): Promise<void> {
		await this.store.updatePageSource((p) => void (p.last = { at: this.now(), ...r, body: r.body.slice(0, 4000) }))
		this.env.ui.changed()
	}

	/**
	 * The reader's DOM result. A found check-in fills today's check-in time, so
	 * the forced reminder clears itself exactly as it does with the API.
	 */
	async reportPageRead(data: PageAttendance, source: ReadSource = 'page'): Promise<void> {
		const now = this.now()
		await this.store.updatePageSource((p) => void (p.read = { at: now, data, source }))
		// The page path paces itself like the API sync would.
		await this.store.updateRuntime((r) => void (r.lastSync = now))
		if (!usable(data)) return this.env.ui.changed()
		await this.applyRead(data, source, false)
	}

	/**
	 * Zoho is the truth for today, so a read corrects what is already stored and
	 * does not only fill blanks — otherwise one wrong time (a test day, a punch
	 * that did not land) sticks for the rest of the day.
	 *
	 * `replace` is the "Match Zoho" button: it also clears what Zoho has no
	 * record of. A plain read never clears on absence, because a missed label is
	 * not the same as a missing punch.
	 */
	private async applyRead(data: PageAttendance, source: ReadSource, replace: boolean, readAt = this.now()) {
		const now = this.now()
		const today = istDate(now)
		const day = await this.store.day(today)
		const entries = await this.store.entries(today)
		const logged = entries.some((e) => e.kind === 'work' && e.minutes > 0)
		const inAt = timeOn(today, data.firstIn)
		const outAt = timeOn(today, data.lastOut)
		const patch: Partial<Day> = {}
		if (inAt != null && day.checkedInAt !== inAt) patch.checkedInAt = inAt
		if (outAt != null && day.checkedOutAt !== outAt) patch.checkedOutAt = outAt

		/**
		 * A first-in with no last-out can mean you are in right now — or it can
		 * mean the reader did not find the label, or that Zoho's widget has not
		 * caught up with a punch made a minute ago. Undoing a check-out on the
		 * strength of that restarts the whole day: the widget asks you to check
		 * out again, the hourly card comes back, and the wrap-up never finishes.
		 *
		 * So it is undone only when all three hold: Zoho positively shows no
		 * punch-out (the label was found and is empty), the read is newer than
		 * the check-out it would be contradicting, and nothing has been logged
		 * against the day since.
		 */
		const saysNoPunchOut = !data.missing.includes('Last Out') && blank(data.lastOut ?? undefined)
		const readerIsNewer = day.checkedOutAt == null || readAt > day.checkedOutAt
		if (inAt != null && outAt == null && day.checkedOutAt != null && saysNoPunchOut && readerIsNewer && (replace || source === 'endpoint')) {
			patch.checkedOutAt = undefined
		}

		if (replace && inAt == null) {
			// "I could not read a time" is not "Zoho has no punch". Clearing on the
			// first of those wipes a real morning check-in and leaves you checking
			// in again — so it only clears when the page positively says there is
			// no punch, and says so plainly when it cannot tell.
			if (!blank(data.firstIn ?? undefined)) {
				throw new Error(
					`Zoho's page shows “${(data.firstIn ?? '').trim()}” as your first punch and WorkPulse could not read it as a time. Nothing was changed — your check-in is still here.`,
				)
			}
			// A day with work logged against it happened, whatever the page says —
			// most likely the page is showing a different day. Emptying it would
			// throw away the morning along with the punch.
			if (logged) {
				throw new Error(
					'Zoho shows no punch for today, but there is time logged here against it. Nothing was changed — check that your Zoho tab is showing today before matching.',
				)
			}
			patch.checkedInAt = undefined
			patch.checkedOutAt = undefined
		}
		if (Object.keys(patch).length) await this.store.updateDay(today, patch)
		await this.store.updateRuntime((r) => void (r.awaiting = undefined))
		await this.engine.reconcile()
		this.env.ui.changed()
	}

	/**
	 * "Match Zoho": reads your tab and makes today agree with it, clearing times
	 * Zoho has no record of. For when the stored day went wrong — a test day, or
	 * a punch that never landed.
	 */
	async matchZoho(): Promise<{ day: Day; read: { firstIn: string | null; lastOut: string | null; source: ReadSource; missing: string[] } }> {
		await this.readZohoPage()
		const p = await this.store.pageSource()
		if (!p.read) throw new Error('Nothing read back from your Zoho tab yet. Try again in a moment.')
		// A read from an hour ago is not what Zoho says now, and this button
		// overwrites today with what it is given.
		if (this.now() - p.read.at > 2 * MIN) {
			throw new Error('The last read of your Zoho tab is too old to match against. Open your Zoho People tab, let it load, and try again.')
		}
		await this.applyRead(p.read.data, p.read.source, true, p.read.at)
		// What it read and where from, so "it cleared everything" is never the
		// whole story the UI can tell you.
		return {
			day: await this.store.day(istDate(this.now())),
			read: { firstIn: p.read.data.firstIn, lastOut: p.read.data.lastOut, source: p.read.source, missing: p.read.data.missing },
		}
	}
}

