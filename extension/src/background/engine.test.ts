import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addedTogether, sortTickets } from '@/core/links'
import { splitRows, type DayReport } from '@/core/rules'
import { changedFiles, digestsOf, filesFor, setupStep, syncTarget } from '@/core/sync'
import { parseIst } from '@/core/time'
import { READ_SCOPES, type Pending } from '@/core/types'
import { parseUserReport, ZohoError, type Attendance } from '@/core/zoho-parse'
import { memoryKV, Store } from '@/lib/store'
import type { ZohoClient } from '@/lib/zoho'

import { Engine, type Ui } from './engine'
import { Commands } from './bridge-commands'

const fixture = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), '../src-tauri/fixtures', `${name}.json`), 'utf8'))

class FakeUi implements Ui {
	shown: Pending[] = []
	hidden = 0
	notes: string[] = []
	opened: string[] = []
	badgeText = ''
	async show(p: Pending) {
		this.shown.push(p)
	}
	async hide() {
		this.hidden++
	}
	notify(id: string) {
		this.notes.push(id)
	}
	async openUrl(url: string) {
		this.opened.push(url)
	}
	async openDashboard(view: string) {
		this.opened.push(`dashboard#${view}`)
	}
	badge(text: string) {
		this.badgeText = text
	}
	/** The tab the worker would be reading, for the page-aware commands. */
	page: { title: string; url: string } | null = null
	async currentPage() {
		return this.page
	}
	changes = 0
	changed() {
		this.changes++
	}
	openedAs: string[] = []
	cleared: string[] = []
	history: { url: string; title: string; at: number }[] = []
	async visits(from: number, to: number) {
		return this.history.filter((v) => v.at >= from && v.at < to)
	}
	clearNote(id: string) {
		this.cleared.push(id)
	}
	backups = 0
	async pushBackup() {
		this.backups++
	}
	shares = 0
	async shareTeam() {
		this.shares++
	}
	/** Whether something is ringing, and how many times it was started. */
	ringing = false
	rings = 0
	alarm(on: boolean) {
		this.ringing = on
		if (on) this.rings++
	}
	pageUrl(view: string) {
		return `dashboard#/${view}`
	}
	async openTabs(urls: string[], groupName?: string) {
		this.opened.push(...urls)
		if (groupName) this.openedAs.push(groupName)
	}
	closed: number[] = []
	async closeTabs(ids: number[]) {
		this.closed.push(...ids)
	}
	chimes = 0
	chime() {
		this.chimes++
	}
	injected = 0
	async injectSetupHelper() {
		this.injected++
	}
	pageReads = 0
	pageTabOpen = true
	async readZohoPage() {
		this.pageReads++
		return this.pageTabOpen
	}
	punches = 0
	async punchZohoPage() {
		this.punches++
		return this.pageTabOpen
	}
	writes = 0
	async writeZohoPage() {
		this.writes++
		return this.pageTabOpen
	}
	recordingOn = false
	record(on: boolean) {
		this.recordingOn = on
	}
	recording() {
		return this.recordingOn
	}
}

class FakeZoho {
	auth = false
	reads = 0
	attendanceResult: Attendance = { checkedIn: false, checkedOut: false, firstIn: null, lastOut: null, totalHours: 0, status: '' }
	timelogError: ZohoError | null = null
	logged: unknown[] = []
	async hasAuth() {
		return this.auth
	}
	async attendance() {
		this.reads++
		return this.attendanceResult
	}
	async jobs() {
		return [{ id: 'j1', name: 'Payment service', project: 'Checkout' }]
	}
	/** Overridden by a test that cares what the report says. */
	report: DayReport[] | null = null
	async userReport() {
		return this.report ?? parseUserReport(fixture('user_report'))
	}
	async addTimelog(a: unknown) {
		if (this.timelogError) throw this.timelogError
		this.logged.push(a)
		return 'tl-1'
	}
	async punch() {}
	signedIn = 0
	redirectUri() {
		return 'https://eipfgalnomnkdbehopenpiopogejenef.chromiumapp.org/'
	}
	async signIn() {
		this.signedIn++
		this.auth = true
	}
}

let clock = 0
let idle = 0
let ui: FakeUi
let zoho: FakeZoho
let store: Store
let engine: Engine
let cmd: Commands

const at = (s: string) => (clock = parseIst(s))
const pending = async () => (await store.runtime()).pending

beforeEach(() => {
	ui = new FakeUi()
	zoho = new FakeZoho()
	store = new Store(memoryKV())
	idle = 0
	engine = new Engine({ store, zoho, now: () => clock, idleSecs: async () => idle, ui })
	cmd = new Commands(engine, zoho as unknown as ZohoClient)
})

// 2026-10-12 is a Monday.
describe('a workday in reminder mode without Zoho', () => {
	it('escalates check-in and clears it when you confirm', async () => {
		at('2026-10-12T08:40:00')
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'checkin', blocking: false })
		expect(ui.badgeText).toBe('IN')
		await cmd.dismiss()
		expect(await pending()).toBeNull()

		at('2026-10-12T09:16:00')
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'checkin', blocking: true })
		await expect(cmd.dismiss()).rejects.toThrow('needs an answer')

		expect(await cmd.checkIn()).toEqual({ result: 'opened' })
		expect(ui.opened[0]).toBe('https://people.zoho.in/')
		await cmd.confirmAttendance('in')
		expect((await store.day('2026-10-12')).checkedInAt).toBe(clock)
		expect(await pending()).toBeNull()
		expect(ui.hidden).toBeGreaterThan(0)
	})

	it('prompts hourly, validates, saves, snoozes and wraps up', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T09:59:00')
		expect(await engine.tick()).toEqual([])
		at('2026-10-12T10:00:00')
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'prompt', blocking: true })
		expect(ui.badgeText).toBe('LOG')

		const ctx = await cmd.promptContext()
		expect(ctx.label).toBe('09:00 – 10:00')
		expect(ctx.minutes).toBe(60)
		await expect(cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'short', minutes: 60 })).rejects.toThrow('at least 10')
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'Fixed the webhook retry bug', minutes: 60 })
		expect(await pending()).toBeNull()

		at('2026-10-12T11:00:00')
		await engine.tick()
		await cmd.snooze()
		at('2026-10-12T11:05:00')
		expect(await engine.tick()).toEqual([])
		at('2026-10-12T11:11:00')
		await engine.tick()
		const c2 = await cmd.promptContext()
		expect(c2.label).toBe('10:00 – 11:11')
		expect(c2.snoozes).toBe(1)
		await cmd.takeBreak(c2.slotStart, c2.slotEnd)

		at('2026-10-12T18:35:00')
		await engine.tick() // final partial slot prompt + wrap-up notification
		expect(ui.notes).toContain('wrapup')
		const c3 = await cmd.promptContext()
		expect(c3.label).toBe('11:11 – 18:30')
		await cmd.saveEntry({ slotStart: c3.slotStart, slotEnd: c3.slotEnd, text: 'Code review and release prep', minutes: 300 })

		at('2026-10-12T19:01:00')
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'wrapup' })
		const review = await cmd.review('2026-10-12')
		expect(review.rows).toHaveLength(1)
		expect(review.rows[0].minutes).toBe(360)
		expect(review.loggedMinutes).toBe(360)
		expect(review.canPush).toBe(false)
		await cmd.markDone('2026-10-12')
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pushed')
		expect(await pending()).toBeNull()
	})

	it('turns a locked screen into an away span on the next prompt', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T09:30:00')
		await engine.tick()
		idle = 601
		at('2026-10-12T09:40:00')
		await engine.tick()
		at('2026-10-12T10:20:00')
		await engine.tick()
		expect(await pending()).toBeNull() // no prompt while away
		idle = 0
		at('2026-10-12T10:21:00')
		await engine.tick()
		const ctx = await cmd.promptContext()
		expect(ctx.awayNote).toMatch(/^Away 09:2\d–10:21$/)
		expect(ctx.minutes).toBeLessThan(40)
	})
})

describe('with Zoho connected', () => {
	it('reads Zoho first, then scans and flags regularisation', async () => {
		zoho.auth = true
		zoho.attendanceResult = { checkedIn: true, checkedOut: false, firstIn: '12-10-2026 09:12:05', lastOut: null, totalHours: 1, status: 'Present' }
		await store.saveSettings({ email: 'me@example.com' })
		at('2026-10-12T09:20:00')
		expect(await engine.tick()).toEqual([{ type: 'sync' }])
		expect((await store.day('2026-10-12')).checkedInAt).toBe(parseIst('2026-10-12T09:12:05'))
		at('2026-10-12T09:21:00')
		await engine.tick()
		const issues = await store.openIssues()
		expect(issues.map((i) => i.kind)).toEqual(['absent', 'missing_checkout'])
		expect(ui.notes).toContain('issues')
		expect(ui.badgeText).toBe('2')
	})

	it('marks a holiday off when Zoho refuses the time log with 8008', async () => {
		zoho.auth = true
		zoho.timelogError = new ZohoError('Cannot log time during Weekend/Holidays/Leave', 8008)
		await store.saveSettings({ email: 'me@example.com', zohoMode: 'timelogs' })
		const r = await cmd.pushDay('2026-10-12', [{ jobId: 'j1', minutes: 120, description: 'x' }])
		expect(r.status).toBe('skipped')
		expect(await store.day('2026-10-12')).toMatchObject({ isOff: true, timelogStatus: 'skipped' })
	})

	it('pushes one time log per row in timelogs mode', async () => {
		zoho.auth = true
		await store.saveSettings({ email: 'me@example.com', zohoMode: 'timelogs' })
		const r = await cmd.pushDay('2026-10-12', [
			{ jobId: 'j1', minutes: 120, description: 'a' },
			{ jobId: 'j1', minutes: 90, description: 'b' },
		])
		expect(r).toEqual({ status: 'pushed', done: [0, 1] })
		expect(zoho.logged).toHaveLength(2)
		await expect(cmd.pushDay('2026-10-12', [{ minutes: 60, description: 'x' }])).rejects.toThrow('needs a job')
	})

	it('sends a continuous row with its real start and end, and an edited one as hours', async () => {
		zoho.auth = true
		await store.saveSettings({ email: 'me@example.com', zohoMode: 'timelogs' })
		const from = parseIst('2026-10-12T10:00:00')
		await cmd.pushDay('2026-10-12', [
			{ jobId: 'j1', minutes: 180, description: 'retry fix', from, to: from + 180 * 60_000 },
			{ jobId: 'j1', minutes: 150, description: 'edited to 2:30', from, to: from + 180 * 60_000 },
		])
		expect(zoho.logged).toEqual([
			expect.objectContaining({ minutes: 180, from: '10:00', to: '13:00' }),
			expect.not.objectContaining({ from: expect.anything() }),
		])
	})

	it('sends hours when the setting is off, and retries as hours when Zoho refuses the times', async () => {
		zoho.auth = true
		const from = parseIst('2026-10-12T10:00:00')
		const row = { jobId: 'j1', minutes: 60, description: 'x', from, to: from + 3_600_000 }
		await store.saveSettings({ email: 'me@example.com', zohoMode: 'timelogs', timelogTimes: false })
		await cmd.pushDay('2026-10-12', [row])
		expect(zoho.logged[0]).not.toHaveProperty('from')

		await store.saveSettings({ timelogTimes: true })
		zoho.logged = []
		const real = zoho.addTimelog.bind(zoho)
		zoho.addTimelog = async (a: { from?: string }) => {
			if (a.from) throw new ZohoError('Error in adding Timelog')
			return real(a)
		}
		expect(await cmd.pushDay('2026-10-12', [row])).toMatchObject({ status: 'pushed', done: [0] })
		expect(zoho.logged).toEqual([expect.not.objectContaining({ from: expect.anything() })])
	})
})

describe('tasks and timer', () => {
	it('starting a task stops the previous one and prefills the prompt', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		const a = await cmd.createTask({ title: 'PAY-231 webhook', key: 'PAY-231', jobId: 'j1' })
		const b = await cmd.createTask({ title: 'Code review' })
		await cmd.startTimer(a.uid)
		at('2026-10-12T09:40:00')
		await cmd.startTimer(b.uid)
		const { tasks, timer } = await cmd.tasks()
		expect(tasks.find((t) => t.uid === a.uid)?.spentMinutes).toBe(40)
		expect(timer?.task.uid).toBe(b.uid)
		at('2026-10-12T10:00:00')
		const ctx = await cmd.promptContext()
		expect(ctx.timer?.task.title).toBe('Code review')
		expect(ctx.timer?.minutesInSlot).toBe(20)
		expect(await cmd.stopTimer()).toBe(20)
	})
})

describe('settings validation', () => {
	it('rejects bad values with readable errors', async () => {
		await expect(cmd.saveSettings({ shiftStart: '9am' })).rejects.toThrow('HH:MM')
		await expect(cmd.saveSettings({ shiftStart: '19:00', shiftEnd: '18:00' })).rejects.toThrow('after shift start')
		await expect(cmd.saveSettings({ promptInterval: 0 })).rejects.toThrow('Prompt interval')
		await expect(cmd.saveSettings({ workDays: [] })).rejects.toThrow('work day')
		const s = await cmd.saveSettings({ promptInterval: 2, workDays: [5, 1, 1] })
		expect(s.promptInterval).toBe(2)
		expect(s.workDays).toEqual([1, 5])
	})
})

describe('guided Zoho setup', () => {
	const ID = '1000.AB12CD34EF56GH78IJ90KL12MN34OP'

	it('gives the console link and the exact form values', async () => {
		const info = await cmd.setupInfo()
		expect(info.consoleUrl).toBe('https://api-console.zoho.in/')
		expect(info.formValues.map((v) => v.label)).toEqual(['Client Name', 'Homepage URL', 'Authorized Redirect URIs', 'JavaScript Domain'])
		expect(info.formValues[2].value).toBe('https://eipfgalnomnkdbehopenpiopogejenef.chromiumapp.org/')
		expect(info.attendanceSet).toBe(false)
	})

	it('one click opens the console and turns the helper on', async () => {
		await cmd.startSetup('client')
		expect(ui.opened).toEqual(['https://api-console.zoho.in/'])
		expect((await cmd.setupState()).flags).toEqual({ client: true, attendance: false })
	})

	it('saves the Client ID, signs in and tests in one go', async () => {
		await expect(cmd.saveClientId('1000.short')).rejects.toThrow('Client ID')
		await cmd.startSetup('client')
		const test = await cmd.connectWithClientId(ID)
		expect(zoho.signedIn).toBe(1)
		expect((await store.settings()).oauthClientId).toBe(ID)
		expect(test.jobs).toMatchObject({ ok: true, detail: '1 job' })
		expect((await cmd.setupState()).flags.client).toBe(false)
	})

	it('captures the attendance page from Zoho People only', async () => {
		await cmd.startSetup('attendance')
		await expect(cmd.captureAttendanceUrl('https://evil.example.com/')).rejects.toThrow('Zoho People')
		await cmd.captureAttendanceUrl('https://people.zoho.in/acme/zp#attendance/entry/checkin')
		const info = await cmd.setupInfo()
		expect(info.attendanceUrl).toBe('https://people.zoho.in/acme/zp#attendance/entry/checkin')
		expect(info.attendanceSet).toBe(true)
		expect(info.flags.attendance).toBe(false)
	})
})

describe('Zoho reads, punches and guided setup', () => {
	const connect = () => store.setAuth({ kind: 'self', clientId: '1000.ID', clientSecret: 's', refreshToken: 'r' })

	it('should broadcast only when a Zoho read changed something', async () => {
		at('2026-10-12T09:30:00')
		await connect()
		zoho.auth = true
		zoho.attendanceResult = { checkedIn: true, checkedOut: false, firstIn: '12-10-2026 09:12:05', lastOut: null, totalHours: 0.3, status: 'Present' }
		await engine.syncAttendance('2026-10-12')
		expect((await store.day('2026-10-12')).checkedInAt).toBe(parseIst('2026-10-12T09:12:05'))
		const after = ui.changes
		expect(after).toBeGreaterThan(0)

		await engine.syncAttendance('2026-10-12')
		expect(ui.changes).toBe(after) // nothing new: no broadcast, so open pages cannot loop
	})

	it('should not loop Zoho calls when review() is reloaded', async () => {
		at('2026-10-12T19:00:00')
		await connect()
		zoho.auth = true
		zoho.attendanceResult = { checkedIn: true, checkedOut: true, firstIn: '12-10-2026 09:12:05', lastOut: '12-10-2026 18:40:00', totalHours: 9, status: 'Present' }
		await cmd.review()
		const afterFirst = ui.changes
		await cmd.review()
		await cmd.review()
		expect(zoho.reads).toBe(3)
		expect(ui.changes).toBe(afterFirst)
	})

	it('should refuse an API punch when no Zoho email is set', async () => {
		at('2026-10-12T09:30:00')
		await connect()
		zoho.auth = true
		await store.saveSettings({ zohoMode: 'full', email: '' })
		await expect(cmd.checkIn()).rejects.toThrow('Zoho email')
	})

	it('should inject the setup helper for a Zoho tab that is already open', async () => {
		await cmd.startSetup('client')
		expect(ui.injected).toBe(1)
		expect(ui.opened).toContain('https://api-console.zoho.in/')
	})

	it('should offer the Self Client scopes of the current write mode', async () => {
		expect((await cmd.setupInfo()).scopes).toBe(READ_SCOPES)
		await store.saveSettings({ zohoMode: 'timelogs' })
		expect((await cmd.setupInfo()).scopes).toContain('ZOHOPEOPLE.timetracker.CREATE')
	})
})

describe('reading your own Zoho pages when the API role is blocked', () => {
	it('should read the open Zoho tab as the main source, paced like the API sync', async () => {
		at('2026-10-12T09:20:00')
		await engine.tick() // no usable API: your own page is the source
		expect(ui.pageReads).toBe(1)

		at('2026-10-12T09:21:00')
		await engine.tick()
		expect(ui.pageReads).toBe(1) // a minute later is too soon — every 5

		at('2026-10-12T09:26:00')
		await engine.tick()
		expect(ui.pageReads).toBe(2)

		expect(await cmd.checkIn()).toEqual({ result: 'opened' }) // reminder mode: opens Zoho, awaits the punch
		at('2026-10-12T09:26:30')
		await engine.tick()
		expect(ui.pageReads).toBe(3) // while a punch is expected, every tick

		await cmd.reportPageRead({ firstIn: '09:12 AM', lastOut: null, totalHours: '00:08', missing: [] })
		expect((await store.day('2026-10-12')).checkedInAt).toBe(parseIst('2026-10-12T09:12:00'))
		expect((await store.runtime()).awaiting).toBeUndefined()
		expect(await pending()).toBeNull()

		const before = ui.pageReads
		await engine.tick()
		expect(ui.pageReads).toBe(before) // nothing awaited any more
	})

	it('should ignore a page read with no check-in on it', async () => {
		at('2026-10-12T09:20:00')
		await cmd.reportPageRead({ firstIn: null, lastOut: null, totalHours: null, missing: ['First In', 'Last Out', 'Total Hours'] })
		expect((await store.day('2026-10-12')).checkedInAt).toBeUndefined()
		expect((await cmd.pageState()).read?.data.missing).toHaveLength(3)
	})

	it('should only accept a Zoho address as the endpoint', async () => {
		await expect(cmd.useEndpoint({ at: 1, method: 'POST', url: 'https://example.com/attendance' })).rejects.toThrow('zoho')
		const seen = { at: 1, method: 'POST', url: 'https://people.zoho.in/logiciel/commonAction/getUserStatus' }
		await cmd.noteRequest(seen)
		await cmd.noteRequest(seen) // the same call again must not pile up
		expect((await cmd.pageState()).seen).toHaveLength(1)
	})

	it('should say so when no Zoho tab is open', async () => {
		ui.pageTabOpen = false
		await expect(cmd.readZohoPage()).rejects.toThrow('Open your Zoho People tab')
	})

	it('should pass the recorded CSRF header name to the reader', async () => {
		at('2026-10-12T09:20:00')
		await cmd.noteRequest({ at: 1, method: 'GET', url: 'https://people.zoho.in/people/zp/x', headers: { 'X-ZCSRF-TOKEN': 'abc' } })
		await cmd.useEndpoint({ at: 1, method: 'POST', url: 'https://people.zoho.in/people/zp/x' }).catch(() => undefined)
		expect(await cmd.pageTask()).toMatchObject({ req: { url: 'https://people.zoho.in/people/zp/x' }, date: '2026-10-12', csrfHeader: 'X-ZCSRF-TOKEN' })
	})
})

describe('the endpoint path', () => {
	it('should hand the reader today’s date and use what it parsed', async () => {
		at('2026-10-12T09:30:00')
		const req = { at: 1, method: 'POST', url: 'https://people.zoho.in/logiciel/AttendanceAction.zp', body: 'mode=getStatus&conreqcsr=tok', contentType: 'application/x-www-form-urlencoded; charset=UTF-8' }
		await cmd.noteRequest(req)
		await cmd.useEndpoint(req).catch(() => undefined)
		expect(await cmd.pageTask()).toMatchObject({ date: '2026-10-12', req: { body: 'mode=getStatus&conreqcsr=tok' } })

		await cmd.reportPageRead({ firstIn: '12-10-2026 09:12:05', lastOut: null, totalHours: '00:18', missing: ['Last Out'] }, 'endpoint')
		const state = await cmd.pageState()
		expect(state.read?.source).toBe('endpoint')
		expect((await store.day('2026-10-12')).checkedInAt).toBe(parseIst('2026-10-12T09:12:05'))
	})
})

describe('check in, check out and forcing a reminder by hand', () => {
	it('should force the check-in card on demand and drop any snooze', async () => {
		at('2026-10-12T09:05:00')
		await cmd.snooze()
		expect((await store.runtime()).snoozeUntil).toBeGreaterThan(clock)

		await cmd.forceReminder('checkin')
		expect(await pending()).toMatchObject({ kind: 'checkin', blocking: true })
		expect((await store.runtime()).snoozeUntil).toBeUndefined()
		await expect(cmd.dismiss()).rejects.toThrow('needs an answer')
	})

	it('should force the hourly and the timesheet card', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.forceReminder('prompt')
		expect(await pending()).toMatchObject({ kind: 'prompt', blocking: true })

		await cmd.forceReminder('wrapup')
		expect(await pending()).toMatchObject({ kind: 'wrapup', blocking: true })
	})

	it('should refuse a reminder that no longer applies', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await expect(cmd.forceReminder('checkin')).rejects.toThrow('already checked in')

		await cmd.markDone('2026-10-12')
		await expect(cmd.forceReminder('wrapup')).rejects.toThrow('already done')

		await cmd.markOff()
		await expect(cmd.forceReminder('prompt')).rejects.toThrow('marked off')
	})

	it('should check out through Zoho the same way it checks in', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T18:40:00')
		expect(await cmd.checkOut()).toEqual({ result: 'opened' })
		expect((await store.runtime()).awaiting).toBe('out')
		await cmd.confirmAttendance('out')
		expect((await store.day('2026-10-12')).checkedOutAt).toBe(clock)
	})
})

describe('one-click punch through Zoho’s own page call', () => {
	it('should refuse to punch unless Full mode is on', async () => {
		at('2026-10-12T09:20:00')
		await expect(cmd.punchViaPage(true)).rejects.toThrow('Full mode')
		expect(await cmd.punchTask()).toBeNull() // nothing armed, so nothing can punch
	})

	it('should arm one punch per click, for the right data centre', async () => {
		at('2026-10-12T09:20:00')
		await store.saveSettings({ zohoMode: 'full' })
		expect(await cmd.punchViaPage(true)).toEqual({ result: 'punching' })
		expect(await cmd.punchTask()).toEqual({ url: 'https://people.zoho.in/logiciel/AttendanceAction.zp?mode=punchIn', checkIn: true })
		expect(await cmd.punchTask()).toBeNull() // handed out once only
	})

	it('should take the time from Zoho, not from the reply', async () => {
		at('2026-10-12T09:20:00')
		await store.saveSettings({ zohoMode: 'full' })
		await cmd.punchViaPage(true)
		await cmd.reportPunch({ checkIn: true, ok: true, status: 200, body: 'ok', located: true })
		expect((await store.runtime()).awaiting).toBe('in') // waiting for Zoho to confirm
		expect((await store.day('2026-10-12')).checkedInAt).toBeUndefined()

		await cmd.reportPageRead({ firstIn: '09:12 AM', lastOut: null, totalHours: '00:08', missing: [] }, 'endpoint')
		expect((await store.day('2026-10-12')).checkedInAt).toBe(parseIst('2026-10-12T09:12:00'))
	})

	it('should explain a refused punch and leave you able to do it by hand', async () => {
		at('2026-10-12T09:20:00')
		await store.saveSettings({ zohoMode: 'full' })
		await cmd.punchViaPage(true)
		await cmd.reportPunch({ checkIn: true, ok: false, status: 403, body: 'no', located: false })
		expect((await store.runtime()).lastError).toContain('403')
		expect((await cmd.pageState()).punch?.ok).toBe(false)
	})

	it('should fall back to opening Zoho when no tab is there to punch on', async () => {
		at('2026-10-12T09:20:00')
		await store.saveSettings({ zohoMode: 'full' })
		ui.pageTabOpen = false
		expect(await cmd.checkIn()).toEqual({ result: 'opened' })
	})
})

describe('the day’s hours', () => {
	it('should say so once when the hours are complete, and not after shift end', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T16:59:00')
		expect((await engine.tick()).some((a) => a.type === 'notify' && a.kind === 'hoursdone')).toBe(false)

		at('2026-10-12T17:00:00') // eight hours in
		await engine.tick()
		expect(ui.notes).toContain('hoursdone')

		const before = ui.notes.filter((n) => n === 'hoursdone').length
		at('2026-10-12T17:30:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'hoursdone').length).toBe(before) // told once
	})

	it('should not mention the hours once you have checked out', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T17:05:00')
		await cmd.confirmAttendance('out')
		await engine.tick()
		expect(ui.notes).not.toContain('hoursdone')
	})
})

describe('Zoho is the truth for today', () => {
	it('should correct a wrong stored time instead of only filling a blank', async () => {
		at('2026-10-12T22:12:00')
		await cmd.confirmAttendance('in') // stored 22:12 by hand — wrong
		await cmd.reportPageRead({ firstIn: '09:12 AM', lastOut: null, totalHours: '01:00', missing: ['Last Out'] }, 'endpoint')
		expect((await store.day('2026-10-12')).checkedInAt).toBe(parseIst('2026-10-12T09:12:00'))
	})

	it('should drop a stale check-out when Zoho positively shows no punch-out', async () => {
		at('2026-10-12T21:35:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T22:12:00')
		await cmd.confirmAttendance('out')
		expect((await store.day('2026-10-12')).checkedOutAt).toBe(clock)

		at('2026-10-12T22:20:00')
		// The label was found and it is empty: Zoho is saying you are in.
		await cmd.reportPageRead({ firstIn: '09:30 PM', lastOut: '-', totalHours: '00:40', missing: [] }, 'endpoint')
		expect((await store.day('2026-10-12')).checkedOutAt).toBeUndefined()
	})

	it('should not drop a check-out just because it could not find the label', async () => {
		// This used to drop it, and it is the bug that restarted a finished day:
		// the widget asked to check out again and the hourly card came back.
		at('2026-10-12T21:35:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T22:12:00')
		await cmd.confirmAttendance('out')
		at('2026-10-12T22:20:00')
		await cmd.reportPageRead({ firstIn: '09:30 PM', lastOut: null, totalHours: '00:40', missing: ['Last Out'] }, 'endpoint')
		expect((await store.day('2026-10-12')).checkedOutAt).toBe(parseIst('2026-10-12T22:12:00'))
	})

	it('should not clear anything from a page read that simply found nothing', async () => {
		at('2026-10-12T21:35:00')
		await cmd.confirmAttendance('in')
		await cmd.reportPageRead({ firstIn: null, lastOut: null, totalHours: null, missing: ['First In', 'Last Out', 'Total Hours'] }, 'page')
		expect((await store.day('2026-10-12')).checkedInAt).toBe(parseIst('2026-10-12T21:35:00'))
	})

	it('should clear the day on Match Zoho when Zoho has no punch', async () => {
		at('2026-10-12T22:12:00')
		await cmd.confirmAttendance('in')
		await cmd.reportPageRead({ firstIn: null, lastOut: null, totalHours: null, missing: ['First In'] }, 'endpoint')
		const { day } = await cmd.matchZoho()
		expect(day.checkedInAt).toBeUndefined()
		expect(day.checkedOutAt).toBeUndefined()
	})

	it('should keep quiet about an API that is rate-limited, not only one that is refused', () => {
		expect(new ZohoError('API access blocked since threshold limit exceeded. Please try after some time').isRoleBlocked).toBe(true)
		expect(new ZohoError("Sorry!your role is not allowed to access api's.").isRoleBlocked).toBe(true)
		expect(new ZohoError('Cannot log time during Weekend/Holidays/Leave', 8008).isRoleBlocked).toBe(false)
	})
})

describe('project and task names without the API', () => {
	const recorded = [
		{ at: 1, method: 'POST', url: 'https://people.zoho.in/logiciel/AttendanceAction.zp', body: 'mode=getStatus&conreqcsr=tok', contentType: 'application/x-www-form-urlencoded; charset=UTF-8' },
		{ at: 2, method: 'POST', url: 'https://people.zoho.in/logiciel/timetracker/projects', body: 'mode=getTimesheetProjectList&conreqcsr=tok&limit=24' },
		{ at: 3, method: 'POST', url: 'https://people.zoho.in/logiciel/timesheet.zp', body: 'mode=getJobs&projectId=7&conreqcsr=tok' },
		{ at: 4, method: 'POST', url: 'https://people.zoho.in/logiciel/addUpdateRecord.zp', body: 'zp_mode=addRecord&zp_tableName=P_Timesheet' },
	]

	it('should wire the attendance and catalogue calls from one recording, and skip the write', async () => {
		at('2026-10-12T09:20:00')
		for (const r of recorded) await cmd.noteRequest(r)
		const task = await cmd.pageTask()
		expect(task.req?.body).toBe('mode=getStatus&conreqcsr=tok')
		expect(task.catalog?.projects?.url).toContain('timetracker/projects')
		expect(task.catalog?.jobs?.url).toContain('timesheet.zp')
		expect(JSON.stringify(task)).not.toContain('addRecord') // a write is never handed to the reader
	})

	it('should put the real task names in the hourly prompt', async () => {
		at('2026-10-12T09:20:00')
		await cmd.reportCatalog([
			{ id: '68447000008734366', name: 'PAY-2952', project: 'LeapPay' },
			{ id: '2', name: 'Code review', project: 'LeapPay' },
		])
		const ctx = await cmd.promptContext()
		expect(ctx.jobs.map((j) => `${j.project} · ${j.name}`)).toEqual(['LeapPay · Code review', 'LeapPay · PAY-2952'])
	})

	it('should ask for the catalogue only once a day', async () => {
		at('2026-10-12T09:20:00')
		for (const r of recorded) await cmd.noteRequest(r)
		await cmd.reportCatalog([{ id: '1', name: 'A', project: 'P' }])
		expect((await cmd.pageTask()).catalog).toBeUndefined()

		at('2026-10-13T09:20:00')
		expect((await cmd.pageTask()).catalog?.projects).toBeDefined()
	})
})

describe('“have you done this today?” in the popup', () => {
	it('should ask about open tasks and go quiet for an interval once answered', async () => {
		at('2026-10-12T10:00:00')
		const task = await cmd.createTask({ title: 'Ship the retry fix', key: 'PAY-2952' })
		expect((await cmd.tasks()).ask.map((t) => t.uid)).toEqual([task.uid])

		await cmd.answerTask(task.uid, 'doing')
		expect((await cmd.tasks()).ask).toEqual([])
		expect((await store.tasks())[0].status).toBe('doing')

		at('2026-10-12T10:59:00')
		expect((await cmd.tasks()).ask).toEqual([]) // still inside the hour
		at('2026-10-12T11:00:00')
		expect((await cmd.tasks()).ask.map((t) => t.uid)).toEqual([task.uid]) // an hour later, asked again
	})

	it('should stop asking about a task you finished, and stop its timer', async () => {
		at('2026-10-12T10:00:00')
		const task = await cmd.createTask({ title: 'Write the release notes' })
		await cmd.startTimer(task.uid)
		at('2026-10-12T10:30:00')
		await cmd.answerTask(task.uid, 'done')

		at('2026-10-12T12:00:00')
		expect((await cmd.tasks()).ask).toEqual([])
		expect(await store.timer()).toBeNull()
		expect((await store.tasks())[0].spentMinutes).toBe(30)
	})

	it('should follow the prompt interval, not a hardcoded hour', async () => {
		at('2026-10-12T10:00:00')
		await store.saveSettings({ promptInterval: 30 })
		const task = await cmd.createTask({ title: 'Review the PR' })
		await cmd.answerTask(task.uid, 'later')
		at('2026-10-12T10:29:00')
		expect((await cmd.tasks()).ask).toEqual([])
		at('2026-10-12T10:30:00')
		expect((await cmd.tasks()).ask).toHaveLength(1)
	})
})

describe('syncing when you open Zoho', () => {
	it('should read as soon as a Zoho tab loads, but not on every navigation', async () => {
		at('2026-10-12T09:20:00')
		await cmd.syncOnZohoTab()
		expect(ui.pageReads).toBe(1)

		at('2026-10-12T09:20:20')
		await cmd.syncOnZohoTab()
		expect(ui.pageReads).toBe(1) // Zoho's own app navigates constantly

		at('2026-10-12T09:21:00')
		await cmd.syncOnZohoTab()
		expect(ui.pageReads).toBe(2)
	})

	it('should use the API instead when the API works', async () => {
		at('2026-10-12T09:20:00')
		zoho.auth = true
		await cmd.syncOnZohoTab()
		expect(zoho.reads).toBe(1)
		expect(ui.pageReads).toBe(0)
	})
})

describe('pushing the timesheet without the API', () => {
	const TEMPLATE = {
		at: 1,
		method: 'POST',
		url: 'https://people.zoho.in/logiciel/addUpdateRecord.zp',
		contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
		body: 'Work_Item=Work+on+PAY-2952&Date=09-10-2026&zp_tableName=P_Timesheet&loginUserZUID=ZUID&conreqcsr=TOK&zp_formId=FORM&zp_mode=addRecord&JobId=JOB&Project=PROJ&Billable_Status=0&User_Name=EREC&timelogtype=0&loggedHrs=03%3A00&Description=&isDraft=false',
	}
	const rows = [{ jobId: 'JOB2', minutes: 95, description: 'Webhook retries' }]

	it('should ask for a captured save before it writes anything', async () => {
		at('2026-10-12T19:00:00')
		await store.saveSettings({ zohoMode: 'timelogs' })
		await expect(cmd.pushDayViaPage('2026-10-12', rows)).rejects.toThrow('no timesheet save to copy')
	})

	it('should refuse in Reminder mode, as the API push does', async () => {
		at('2026-10-12T19:00:00')
		await cmd.noteRequest(TEMPLATE)
		await expect(cmd.pushDayViaPage('2026-10-12', rows)).rejects.toThrow('Time-logs or Full mode')
	})

	it('should mold the row and hand it over exactly once', async () => {
		at('2026-10-12T19:00:00')
		await store.saveSettings({ zohoMode: 'timelogs' })
		await cmd.noteRequest(TEMPLATE)
		expect(await cmd.pushDayViaPage('2026-10-12', rows)).toMatchObject({ status: 'pushing' })

		const task = await cmd.writeTask()
		const sent = new URLSearchParams(task!.bodies[0])
		expect(sent.get('Date')).toBe('12-10-2026')
		expect(sent.get('loggedHrs')).toBe('01:35')
		expect(sent.get('JobId')).toBe('JOB2')
		expect(sent.get('Work_Item')).toBe('Webhook retries')
		expect(sent.get('Description')).toBe('') // the work item already says it
		expect(sent.get('zp_formId')).toBe('FORM') // your org's id, untouched
		expect(await cmd.writeTask()).toBeNull()
	})

	it('should mark the day done only when Zoho took every row', async () => {
		at('2026-10-12T19:00:00')
		await store.saveSettings({ zohoMode: 'timelogs' })
		await cmd.reportTimelogs({ date: '2026-10-12', results: [{ ok: true, status: 200, body: 'ok' }, { ok: false, status: 200, body: 'error: overlapping entry' }] })
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pending')
		expect((await store.runtime()).lastError).toContain('1 of 2')

		await cmd.reportTimelogs({ date: '2026-10-12', results: [{ ok: true, status: 200, body: 'ok' }] })
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pushed')
	})

	it('should still use the API when the API works', async () => {
		at('2026-10-12T19:00:00')
		zoho.auth = true
		await store.saveSettings({ email: 'me@example.com', zohoMode: 'timelogs' })
		expect(await cmd.pushDay('2026-10-12', [{ jobId: 'j1', minutes: 120, description: 'x' }])).toMatchObject({ status: 'pushed' })
		expect(zoho.logged).toHaveLength(1)
	})
})

describe('knowing which calls WorkPulse still needs', () => {
	const SAVE = {
		at: 1,
		method: 'POST',
		url: 'https://people.zoho.in/logiciel/addUpdateRecord.zp',
		body: 'zp_tableName=P_Timesheet&zp_mode=addRecord&Date=09-10-2026&loggedHrs=03%3A00&JobId=J&conreqcsr=T',
	}
	const STATUS = { at: 2, method: 'POST', url: 'https://people.zoho.in/logiciel/AttendanceAction.zp', body: 'mode=getStatus&conreqcsr=T' }

	it('should name a pasted timesheet save instead of calling it unrecognised', async () => {
		at('2026-10-12T10:00:00')
		const curl = `curl --url '${SAVE.url}' -H 'Content-Type: application/x-www-form-urlencoded' --data-raw '${SAVE.body}'`
		expect(await cmd.addCurl(curl)).toMatchObject({ kind: 'write' })
		expect((await cmd.wiring()).save).toBe(true)
	})

	it('should report what is still missing', async () => {
		at('2026-10-12T10:00:00')
		expect(await cmd.wiring()).toEqual({ attendance: false, tasks: false, save: false, logged: false })
		await cmd.noteRequest(STATUS)
		await cmd.noteRequest(SAVE)
		expect(await cmd.wiring()).toEqual({ attendance: true, tasks: false, save: true, logged: false })
	})

	it('should keep a pasted save when a recording starts', async () => {
		at('2026-10-12T10:00:00')
		await cmd.noteRequest(SAVE)
		await cmd.startRecording()
		expect((await cmd.wiring()).save).toBe(true) // used to be wiped here
		await cmd.stopRecording()

		await cmd.forgetCalls()
		expect((await cmd.wiring()).save).toBe(false)
	})
})

describe('a pasted call must survive', () => {
	const SAVE_CURL = `curl --url 'https://people.zoho.in/logiciel/addUpdateRecord.zp' -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' -b '_iamadt=SECRET; CSRF_TOKEN=TOK' --data-raw 'isPicklistIdEnabled=true&Work_Item=Review+PR&Date=12-10-2026&zp_tableName=P_Timesheet&loginUserZUID=ZUID&conreqcsr=TOK&zp_formId=FORM&zp_mode=addRecord&isFromNewUI=true&JobId=JOB&Project=PROJ&Billable_Status=0&User_Name=EREC&timelogtype=0&loggedHrs=00%3A30&Description=&isDraft=false'`

	it('should accept the real timesheet curl and name it', async () => {
		at('2026-10-12T19:00:00')
		expect(await cmd.addCurl(SAVE_CURL)).toMatchObject({ kind: 'write' })
		expect((await cmd.wiring()).save).toBe(true)
		expect(JSON.stringify(await cmd.pageState())).not.toContain('SECRET')
	})

	it('should not be pushed out by a flood of recorded calls', async () => {
		at('2026-10-12T19:00:00')
		await cmd.addCurl(SAVE_CURL)
		for (let i = 0; i < 80; i++) await cmd.noteRequest({ at: i, method: 'GET', url: `https://people.zoho.in/_chat/noise?n=${i}` })
		expect((await cmd.wiring()).save).toBe(true)
	})

	it('should push with it, taking the hours from the row not the capture', async () => {
		at('2026-10-12T19:00:00')
		await store.saveSettings({ zohoMode: 'timelogs' })
		await cmd.addCurl(SAVE_CURL)
		await cmd.pushDayViaPage('2026-10-12', [{ jobId: 'JOB', minutes: 150, description: 'Review PR' }])
		const sent = new URLSearchParams((await cmd.writeTask())!.bodies[0])
		expect(sent.get('loggedHrs')).toBe('02:30')
		expect(sent.get('Work_Item')).toBe('Review PR')
		expect(sent.get('Description')).toBe('') // not the same sentence twice
		expect(sent.get('zp_formId')).toBe('FORM')
	})
})

describe('pushing only the entries you ticked', () => {
	const SAVE_CURL = `curl --url 'https://people.zoho.in/logiciel/addUpdateRecord.zp' -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' --data-raw 'Work_Item=x&Date=12-10-2026&zp_tableName=P_Timesheet&conreqcsr=T&zp_formId=FORM&zp_mode=addRecord&JobId=JOB&Project=PROJ&Billable_Status=0&User_Name=EREC&timelogtype=0&loggedHrs=00%3A30&Description=&isDraft=false'`

	const threeEntries = async () => {
		await cmd.addManualEntry({ date: '2026-10-12', from: '09:00', to: '10:00', text: 'Work on 3018 and 3017', jobId: 'JOB' })
		await cmd.addManualEntry({ date: '2026-10-12', from: '10:00', to: '11:00', text: 'Review the Garud PR', jobId: 'JOB' })
		await cmd.addManualEntry({ date: '2026-10-12', from: '11:00', to: '12:00', text: 'Leap360 refactor', jobId: 'JOB' })
		return (await store.entries('2026-10-12')).map((e) => e.uid)
	}

	it('should mark only the entries that went, leaving the day open', async () => {
		at('2026-10-12T19:00:00')
		zoho.auth = true
		await store.saveSettings({ email: 'me@example.com', zohoMode: 'timelogs' })
		const [first, second, third] = await threeEntries()

		await cmd.pushDay('2026-10-12', [{ jobId: 'JOB', minutes: 120, description: 'two of them' }], [first, second])
		const after = await store.entries('2026-10-12')
		expect(after.filter((e) => e.synced).map((e) => e.uid)).toEqual([first, second])
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pending') // one still to go

		await cmd.pushDay('2026-10-12', [{ jobId: 'JOB', minutes: 60, description: 'the last one' }], [third])
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pushed')
	})

	it('should offer the next push only what is still unsynced', async () => {
		at('2026-10-12T19:00:00')
		zoho.auth = true
		await store.saveSettings({ email: 'me@example.com', zohoMode: 'timelogs' })
		const [first] = await threeEntries()
		await cmd.pushDay('2026-10-12', [{ jobId: 'JOB', minutes: 60, description: 'one' }], [first])

		const review = await cmd.review('2026-10-12')
		expect(review.entries.filter((e) => !e.synced)).toHaveLength(2)
		expect(review.rows[0].minutes).toBe(120) // the two left, not all three
	})

	it('should offer Push once a timesheet save is pasted, with no OAuth at all', async () => {
		at('2026-10-12T19:00:00')
		await store.saveSettings({ zohoMode: 'timelogs' })
		expect((await cmd.review('2026-10-12')).canPush).toBe(false)
		await cmd.addCurl(SAVE_CURL)
		expect((await cmd.review('2026-10-12')).canPush).toBe(true)
	})

	it('should mark the ticked entries when the page push comes back clean', async () => {
		at('2026-10-12T19:00:00')
		await store.saveSettings({ zohoMode: 'timelogs' })
		await cmd.addCurl(SAVE_CURL)
		const [first] = await threeEntries()
		await cmd.pushDay('2026-10-12', [{ jobId: 'JOB', minutes: 60, description: 'one' }], [first])
		const task = await cmd.writeTask()
		expect(task!.uids).toEqual([first])

		await cmd.reportTimelogs({ date: '2026-10-12', results: [{ ok: true, status: 200, body: 'ok' }], uids: task!.uids })
		expect((await store.entries('2026-10-12')).filter((e) => e.synced).map((e) => e.uid)).toEqual([first])
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pending')
	})
})

describe('tasks you asked to be reminded about', () => {
	it('should stay quiet until the time, then say so once', async () => {
		at('2026-10-12T09:00:00')
		await store.saveSettings({ promptInterval: 600 }) // keep the hourly card out of the way
		await cmd.confirmAttendance('in')
		const task = await cmd.createTask({ title: 'Call the vendor back', priority: 'high', remindAt: parseIst('2026-10-12T14:30:00') })
		expect(task.priority).toBe('high')

		at('2026-10-12T14:29:00')
		await engine.tick()
		expect(ui.notes).not.toContain('taskdue')

		at('2026-10-12T14:30:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'taskdue')).toHaveLength(1)
		expect(await pending()).toMatchObject({ kind: 'remind' })

		await cmd.answerReminder((await store.tasks())[0].uid, 'done')
		at('2026-10-12T14:45:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'taskdue')).toHaveLength(1) // told once, not every minute
	})

	it('should not remind about a task already finished', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		const task = await cmd.createTask({ title: 'Ship the fix', remindAt: parseIst('2026-10-12T14:30:00') })
		await cmd.answerTask(task.uid, 'done')
		at('2026-10-12T14:31:00')
		await engine.tick()
		expect(ui.notes).not.toContain('taskdue')
	})

	it('should ask about the urgent one first', async () => {
		at('2026-10-12T09:00:00')
		await cmd.createTask({ title: 'Tidy the backlog', priority: 'low' })
		await cmd.createTask({ title: 'Production incident', priority: 'high' })
		await cmd.createTask({ title: 'Code review', priority: 'normal' })
		expect((await cmd.tasks()).ask.map((t) => t.title)).toEqual(['Production incident', 'Code review', 'Tidy the backlog'])
	})
})

describe('the history behind the heatmap', () => {
	it('should give one entry per day, oldest first, with what was logged', async () => {
		at('2026-10-12T19:00:00')
		await cmd.addManualEntry({ date: '2026-10-10', from: '09:00', to: '12:00', text: 'Shipped the retry fix' })
		await cmd.addManualEntry({ date: '2026-10-12', from: '09:00', to: '10:00', text: 'Reviewed the PR queue' })
		await cmd.markOff()

		const days = await cmd.history(3)
		expect(days.map((d) => d.date)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'])
		expect(days.map((d) => d.minutes)).toEqual([0, 180, 0, 60])
		expect(days.at(-1)?.isOff).toBe(true)
	})
})

describe('regularisation without the API', () => {
	it('should flag a day you checked into but never left', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-13T10:00:00') // the next day: yesterday is now in range
		expect(await cmd.scanNow()).toBe(1)
		const [issue] = (await cmd.state()).issues
		expect(issue).toMatchObject({ date: '2026-10-12', kind: 'missing_checkout' })
		expect(issue.detail).toContain('09:00')
	})

	it('should flag a short day and a day worked with no check-in', async () => {
		at('2026-10-12T19:00:00')
		await cmd.confirmAttendance('in')
		await cmd.confirmAttendance('out') // in and out at the same minute: nothing on the clock
		await cmd.addManualEntry({ date: '2026-10-09', from: '10:00', to: '13:00', text: 'Worked with no check-in' })

		at('2026-10-13T10:00:00')
		await cmd.scanNow()
		const kinds = (await cmd.state()).issues.map((i) => `${i.date}:${i.kind}`)
		expect(kinds).toContain('2026-10-09:absent')
		expect(kinds).toContain('2026-10-12:short_hours')
	})

	it('should leave days WorkPulse never saw alone', async () => {
		at('2026-10-13T10:00:00')
		expect(await cmd.scanNow()).toBe(0)
	})

	it('should write the reason from what you logged', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.addManualEntry({ date: '2026-10-12', from: '09:00', to: '11:00', text: 'Reviewed the Garud PR' })
		const reason = await cmd.issueReason('2026-10-12')
		expect(reason).toContain('Worked 09:00')
		expect(reason).toContain('2h 0m logged')
		expect(reason).toContain('Forgot to check out')
		expect(reason).toContain('Reviewed the Garud PR')
	})

	it('should drop an issue you have sorted, without waiting for a scan', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-13T10:00:00')
		await cmd.scanNow()
		await cmd.resolveIssue('2026-10-12')
		expect((await cmd.state()).issues).toHaveLength(0)
	})
})

describe('clearing a day you were only testing with', () => {
	it('should wipe that day and leave the rest alone', async () => {
		at('2026-10-12T10:00:00')
		await cmd.confirmAttendance('in')
		await cmd.addManualEntry({ date: '2026-10-12', from: '09:00', to: '10:00', text: 'A test entry to remove' })
		await cmd.addManualEntry({ date: '2026-10-09', from: '09:00', to: '10:00', text: 'A real entry to keep' })

		await cmd.clearDay('2026-10-12')
		expect(await store.entries('2026-10-12')).toHaveLength(0)
		expect((await store.day('2026-10-12')).checkedInAt).toBeUndefined()
		expect(await store.entries('2026-10-09')).toHaveLength(1)
	})
})


describe('keeping something for later', () => {
	it('should save a link with a day and time, and bring it back then', async () => {
		at('2026-10-12T11:00:00')
		const saved = await cmd.capture({
			text: 'Zoho timesheet API docs',
			url: 'https://www.zoho.com/people/api/timesheet/add-timelogs.html',
			when: '2026-10-13T09:30',
			kind: 'note',
		})
		expect(saved).toMatchObject({ kind: 'note', url: 'https://www.zoho.com/people/api/timesheet/add-timelogs.html' })
		expect(saved.remindAt).toBe(parseIst('2026-10-13T09:30:00'))

		at('2026-10-13T09:29:00')
		await engine.tick()
		expect(ui.notes).not.toContain('taskdue')

		at('2026-10-13T09:30:00')
		await cmd.confirmAttendance('in') // otherwise the check-in card holds the screen
		await engine.tick()
		expect(ui.notes).toContain('taskdue')
		expect((await store.runtime()).reminderUrl).toContain('zoho.com/people/api')
	})

	it('should never nag about something you only wanted to keep', async () => {
		at('2026-10-12T11:00:00')
		await cmd.capture({ text: 'Useful thread about Parse hooks', url: 'https://example.com/t', kind: 'note' })
		await cmd.capture({ text: 'Reply to the design review', kind: 'task' })
		expect((await cmd.tasks()).ask.map((t) => t.title)).toEqual(['Reply to the design review'])
	})

	it('should show it on the day it was saved and the day it comes back', async () => {
		at('2026-10-12T11:00:00')
		await cmd.capture({ text: 'Check the payout reconciliation', when: '2026-10-14T10:00' })
		expect((await cmd.savedFor('2026-10-12')).map((t) => t.title)).toEqual(['Check the payout reconciliation'])
		expect((await cmd.savedFor('2026-10-14')).map((t) => t.title)).toEqual(['Check the payout reconciliation'])
		expect(await cmd.savedFor('2026-10-13')).toEqual([])
	})

	it('should refuse a half-written capture', async () => {
		at('2026-10-12T11:00:00')
		await expect(cmd.capture({ text: '   ' })).rejects.toThrow('what you want to keep')
		await expect(cmd.capture({ text: 'Something', when: '2026-10-13T99:99' })).rejects.toThrow('date and time')
	})
})

describe('carrying your data across a reinstall', () => {
	it('should round-trip everything the extension knows', async () => {
		at('2026-10-12T10:00:00')
		await cmd.saveSettings({ email: 'me@example.com', promptInterval: 45 })
		await cmd.addManualEntry({ date: '2026-10-12', from: '09:00', to: '10:00', text: 'Reviewed the Garud PR' })
		await cmd.createTask({ title: 'Ship the retry fix', priority: 'high' })
		await cmd.addCurl(`curl --url 'https://people.zoho.in/logiciel/AttendanceAction.zp' -H 'Content-Type: application/x-www-form-urlencoded' --data-raw 'mode=getStatus&conreqcsr=T'`)

		const dump = await cmd.exportData()
		expect(Object.keys(dump.data).length).toBeGreaterThan(3)

		// A fresh install: empty storage, same commands.
		const fresh = new Store(memoryKV())
		const freshEngine = new Engine({ store: fresh, zoho, now: () => clock, idleSecs: async () => idle, ui })
		const freshCmd = new Commands(freshEngine, zoho as unknown as ZohoClient)
		expect((await freshCmd.state()).settings.email).toBe('')

		expect(await freshCmd.importData(JSON.stringify(dump))).toBe(Object.keys(dump.data).length)
		expect((await freshCmd.state()).settings).toMatchObject({ email: 'me@example.com', promptInterval: 45 })
		expect((await freshCmd.review('2026-10-12')).entries[0].text).toBe('Reviewed the Garud PR')
		expect((await freshCmd.tasks()).tasks[0].title).toBe('Ship the retry fix')
		expect((await freshCmd.wiring()).attendance).toBe(true) // the pasted call survived too
	})

	it('should refuse anything that is not a backup', async () => {
		at('2026-10-12T10:00:00')
		await expect(cmd.importData('not json')).rejects.toThrow('not a WorkPulse backup')
		await expect(cmd.importData('{"version":1}')).rejects.toThrow('no WorkPulse data')
	})
})

describe('reminders that actually fire', () => {
	it('should put a reminder on screen, with its own card and a chime', async () => {
		at('2026-10-12T09:00:00')
		await store.saveSettings({ promptInterval: 600 })
		await cmd.confirmAttendance('in')
		await cmd.capture({ text: 'Take the tablet', when: '2026-10-12T14:00' })

		at('2026-10-12T14:00:00')
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'remind' })
		expect(ui.notes).toContain('taskdue')
		expect(ui.chimes).toBe(1)

		const overlay = await cmd.overlayState()
		expect(overlay.remind?.title).toBe('Take the tablet') // not "What did you work on?"
	})

	it('should keep a reminder owed until it is answered, not drop it', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.capture({ text: 'Stand up and stretch', when: '2026-10-12T11:00' })

		// Something else is already on screen at 11:00.
		await cmd.forceReminder('prompt')
		at('2026-10-12T11:00:00')
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'prompt' }) // not stolen
		expect(ui.notes).not.toContain('taskdue')

		await cmd.snooze() // the prompt is answered
		at('2026-10-12T11:01:00')
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'remind' }) // still owed, now shown
	})

	it('should keep coming back when it repeats, and stop when you say so', async () => {
		at('2026-10-12T09:00:00')
		await store.saveSettings({ promptInterval: 600 })
		await cmd.confirmAttendance('in')
		const water = await cmd.capture({ text: 'Drink water', repeatMinutes: 45 })
		expect(water.remindAt).toBe(parseIst('2026-10-12T09:45:00'))

		at('2026-10-12T09:45:00')
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'remind' })
		await cmd.answerReminder(water.uid, 'done')
		expect(await pending()).toBeNull()

		// Done does not finish a repeating one: it books the next round.
		const after = (await store.tasks()).find((t) => t.uid === water.uid)!
		expect(after.status).not.toBe('done')
		expect(after.remindAt).toBe(parseIst('2026-10-12T10:30:00'))

		at('2026-10-12T10:30:00')
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'remind' })

		await cmd.answerReminder(water.uid, 'stop')
		at('2026-10-12T11:15:00')
		await engine.tick()
		expect((await pending())?.kind).not.toBe('remind')
	})

	it('should not fire a repeat once per missed hour after the laptop wakes', async () => {
		at('2026-10-12T09:00:00')
		await store.saveSettings({ promptInterval: 600 })
		await cmd.confirmAttendance('in')
		const water = await cmd.capture({ text: 'Drink water', repeatMinutes: 30 })

		at('2026-10-12T12:10:00') // three hours later, lid opened
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'taskdue')).toHaveLength(1)
		expect((await store.tasks()).find((t) => t.uid === water.uid)?.remindAt).toBe(parseIst('2026-10-12T12:30:00'))
	})

	it('should come back in ten minutes when you are busy', async () => {
		at('2026-10-12T09:00:00')
		await store.saveSettings({ promptInterval: 600 })
		await cmd.confirmAttendance('in')
		const t = await cmd.capture({ text: 'Call the bank', when: '2026-10-12T10:00' })
		at('2026-10-12T10:00:00')
		await engine.tick()
		await cmd.answerReminder(t.uid, 'snooze')

		at('2026-10-12T10:09:00')
		await engine.tick()
		expect((await pending())?.kind).not.toBe('remind')
		at('2026-10-12T10:10:00')
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'remind' })
	})
})

describe('a reminder behaves like an alarm', () => {
	const quiet = async () => {
		await store.saveSettings({ promptInterval: 600 })
		await cmd.confirmAttendance('in')
	}

	it('should keep ringing and stay on screen until it is answered', async () => {
		at('2026-10-12T09:00:00')
		await quiet()
		const t = await cmd.capture({ text: 'Drink water', when: '2026-10-12T10:00' })

		at('2026-10-12T10:00:00')
		await engine.tick()
		expect(ui.chimes).toBe(1)
		const shown = ui.shown.length

		at('2026-10-12T10:01:00')
		await engine.tick()
		expect(ui.chimes).toBe(2) // still ringing
		expect(ui.shown.length).toBeGreaterThan(shown) // still re-presented

		await expect(cmd.dismiss()).rejects.toThrow('needs an answer') // cannot be waved away
		await cmd.answerReminder(t.uid, 'done')

		at('2026-10-12T10:02:00')
		await engine.tick()
		expect(ui.chimes).toBe(2) // quiet once answered
	})

	it('should take the snooze you picked, not a fixed ten minutes', async () => {
		at('2026-10-12T09:00:00')
		await quiet()
		const t = await cmd.capture({ text: 'Stretch', when: '2026-10-12T10:00' })
		at('2026-10-12T10:00:00')
		await engine.tick()
		await cmd.answerReminder(t.uid, 'snooze', 30)
		expect((await store.tasks()).find((x) => x.uid === t.uid)?.remindAt).toBe(parseIst('2026-10-12T10:30:00'))
	})

	it('should offer the rest of your open work on the alarm card', async () => {
		at('2026-10-12T09:00:00')
		await quiet()
		await cmd.createTask({ title: 'Review the Garud PR' })
		await cmd.capture({ text: 'Zoho docs', url: 'https://example.com', kind: 'note' })
		const t = await cmd.capture({ text: 'Drink water', when: '2026-10-12T10:00' })
		at('2026-10-12T10:00:00')
		await engine.tick()

		const { remind } = await cmd.overlayState()
		expect(remind?.uid).toBe(t.uid)
		expect(remind?.tasks.map((x) => x.title)).toEqual(['Review the Garud PR']) // the note is not work
	})

	it('should not show an API error that nothing can act on', async () => {
		at('2026-10-12T09:00:00')
		await store.updateRuntime((r) => void (r.lastError = 'Zoho session expired. Sign in again in Settings.'))
		await engine.tick()
		expect((await cmd.state()).lastError).toBeUndefined()
		expect((await store.runtime()).lastError).toBeUndefined()
	})
})

describe('setting up without DevTools', () => {
	it('should watch Zoho and work out what it learned by itself', async () => {
		at('2026-10-12T10:00:00')
		expect(await cmd.wiring()).toEqual({ attendance: false, tasks: false, save: false, logged: false })

		await cmd.startAutoSetup()
		expect(ui.recordingOn).toBe(true)
		expect(ui.opened).toContain('https://people.zoho.in/') // Zoho opens for you

		// What using Zoho normally produces, caught by the recorder.
		await cmd.noteRequest({ at: 1, method: 'POST', url: 'https://people.zoho.in/logiciel/AttendanceAction.zp', body: 'mode=getStatus&conreqcsr=T' })
		await cmd.noteRequest({ at: 2, method: 'POST', url: 'https://people.zoho.in/logiciel/timesheet.zp', body: 'mode=getJobs&projectId=0&conreqcsr=T' })
		await cmd.noteRequest({ at: 3, method: 'POST', url: 'https://people.zoho.in/logiciel/timesheetDispAction.zp', body: 'mode=getTimesheet&fromDate=12-10-2026&conreqcsr=T' })
		await cmd.noteRequest({ at: 4, method: 'POST', url: 'https://people.zoho.in/logiciel/addUpdateRecord.zp', body: 'zp_tableName=P_Timesheet&zp_mode=addRecord&loggedHrs=01%3A00&conreqcsr=T' })
		await cmd.noteRequest({ at: 5, method: 'GET', url: 'https://people.zoho.in/_chat/history?limit=20' }) // noise

		await cmd.stopRecording()
		expect(ui.recordingOn).toBe(false)
		expect(await cmd.wiring()).toEqual({ attendance: true, tasks: true, save: true, logged: true })
	})
})

describe('keeping tabs instead of losing them', () => {
	it('should save each tab as a link, then close only what was asked', async () => {
		at('2026-10-12T15:00:00')
		const saved = await cmd.saveTabs(
			[
				{ title: 'Zoho timesheet API', url: 'https://www.zoho.com/people/api/x' },
				{ title: 'PAY-3017 · pull request', url: 'https://github.com/acme/api/pull/9' },
			],
			[11, 12],
		)
		expect(saved).toBe(2)
		expect(ui.closed).toEqual([11, 12])

		const kept = await store.tasks()
		expect(kept.map((t) => t.title)).toContain('Zoho timesheet API')
		expect(kept.every((t) => t.kind === 'note')).toBe(true) // kept, never nagged about
		expect(kept[0].url).toContain('github.com')
	})

	it('should keep without closing when that is what you chose', async () => {
		at('2026-10-12T15:00:00')
		await cmd.saveTabs([{ title: 'Read later', url: 'https://example.com/post' }])
		expect(ui.closed).toEqual([])
		expect((await store.tasks())).toHaveLength(1)
	})
})

describe('a focus session', () => {
	it('should keep the hourly card quiet, then ask once about the whole block', async () => {
		at('2026-10-12T09:00:00')
		await store.saveSettings({ promptInterval: 20 }) // the card would be due mid-session
		await cmd.confirmAttendance('in')
		const task = await cmd.createTask({ title: 'Finish the retry logic' })
		await cmd.startFocus(50, task.uid)

		at('2026-10-12T09:30:00') // the hourly card is already overdue
		expect((await engine.tick()).some((a) => a.type === 'prompt')).toBe(false)
		expect(await pending()).toBeNull()
		expect((await store.timer())?.taskUid).toBe(task.uid) // the task is running

		at('2026-10-12T09:50:00') // the block ends
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'prompt', blocking: true })
		expect(ui.notes).toContain('focus')
		expect(ui.chimes).toBe(1)

		const ctx = await cmd.promptContext()
		expect(ctx.label).toBe('09:00 – 09:50') // the whole block, in one answer
		expect(ctx.timer?.task.title).toBe('Finish the retry logic')
	})

	it('should end early and still ask', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.startFocus(50)
		at('2026-10-12T09:20:00')
		await cmd.endFocus()
		expect(await pending()).toMatchObject({ kind: 'prompt' })
		expect((await store.runtime()).focus).toBeUndefined()
	})

	it('should hold the wrap-up until the block is over', async () => {
		at('2026-10-12T18:00:00')
		await cmd.confirmAttendance('in')
		await cmd.startFocus(60)
		at('2026-10-12T19:05:00') // past shift end + wrap-up delay
		const actions = await engine.tick()
		expect(actions.some((a) => a.type === 'wrapup')).toBe(false)
	})

	it('should refuse a session longer than a working block', async () => {
		at('2026-10-12T09:00:00')
		const { endsAt } = await cmd.startFocus(999)
		expect(endsAt).toBe(parseIst('2026-10-12T13:00:00')) // capped at 4 hours
	})
})

describe('coming back to a piece of work', () => {
	const tabs = [
		{ title: 'PAY-3017 · pull request', url: 'https://github.com/acme/api/pull/9' },
		{ title: 'Retry logs', url: 'https://logs.acme.io/run/41' },
		{ title: 'Zoho timesheet API', url: 'https://www.zoho.com/people/api/x' },
	]

	it('should keep the pages, the task and the name together', async () => {
		at('2026-10-12T15:00:00')
		const task = await cmd.createTask({ title: 'Fix the retry logic' })
		const w = await cmd.saveWorkspace({ name: 'PAY-3017 debugging', tabs, taskUid: task.uid })
		expect(w.tabs).toHaveLength(3)
		expect((await cmd.workspaces()).map((x) => x.name)).toEqual(['PAY-3017 debugging'])
	})

	it('should reopen every page and pick the task back up', async () => {
		at('2026-10-12T15:00:00')
		const task = await cmd.createTask({ title: 'Fix the retry logic' })
		const w = await cmd.saveWorkspace({ name: 'PAY-3017 debugging', tabs, taskUid: task.uid })

		at('2026-10-13T09:30:00') // the next morning, context gone
		await cmd.openWorkspace(w.id)
		expect(ui.opened).toEqual([`dashboard#/links/${w.id}`, ...tabs.map((t) => t.url)])
		expect((await store.timer())?.taskUid).toBe(task.uid) // straight back to work
		expect((await cmd.workspaces())[0].lastOpenedAt).toBe(clock)
	})

	it('should close what you asked while it restores', async () => {
		at('2026-10-12T15:00:00')
		const w = await cmd.saveWorkspace({ name: 'Research', tabs })
		await cmd.openWorkspace(w.id, [7, 8])
		expect(ui.closed).toEqual([7, 8])
	})

	it('should refuse a workspace with no name or nothing in it', async () => {
		at('2026-10-12T15:00:00')
		await expect(cmd.saveWorkspace({ name: '  ', tabs })).rejects.toThrow('name you will recognise')
		await expect(cmd.saveWorkspace({ name: 'Empty', tabs: [] })).rejects.toThrow('at least one tab')
		await expect(cmd.openWorkspace('gone')).rejects.toThrow('is gone')
	})
})

describe('logging more after a day was already sent', () => {
	it('should reopen the day and offer only the new work', async () => {
		at('2026-10-12T12:00:00')
		zoho.auth = true
		await store.setAuth({ kind: 'self', clientId: 'c', clientSecret: 's', refreshToken: 'r' })
		await store.saveSettings({ email: 'me@example.com', zohoMode: 'timelogs' })
		await cmd.addManualEntry({ date: '2026-10-12', from: '09:00', to: '12:00', text: 'Morning on the retry fix', jobId: 'j1' })
		const [morning] = (await store.entries('2026-10-12')).map((e) => e.uid)
		await cmd.pushDay('2026-10-12', [{ jobId: 'j1', minutes: 180, description: 'Morning' }], [morning])
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pushed')

		// The afternoon happens.
		at('2026-10-12T17:00:00')
		await cmd.addManualEntry({ date: '2026-10-12', from: '14:00', to: '17:00', text: 'Afternoon on the payout bug', jobId: 'j1' })
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pending') // reopened

		const review = await cmd.review('2026-10-12')
		expect(review.entries.filter((e) => !e.synced)).toHaveLength(1)
		expect(review.rows).toHaveLength(1)
		expect(review.rows[0].minutes).toBe(180) // only the afternoon
		expect(review.canPush).toBe(true)

		const [, afternoon] = (await store.entries('2026-10-12')).map((e) => e.uid)
		await cmd.pushDay('2026-10-12', [{ jobId: 'j1', minutes: 180, description: 'Afternoon' }], [afternoon])
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pushed')
		expect(zoho.logged).toHaveLength(2)
	})

	it('should do the same for an hourly entry, not just a hand-written one', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.addManualEntry({ date: '2026-10-12', from: '09:00', to: '10:00', text: 'First thing this morning' })
		await cmd.markDone('2026-10-12')
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pushed')

		at('2026-10-12T11:00:00')
		const ctx = await cmd.promptContext()
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'The next hour of work', minutes: 60 })
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pending')
	})
})

describe('sending a long day as several rows', () => {
	it('should send each chunk as its own Zoho row and mark the entries once', async () => {
		at('2026-10-12T18:00:00')
		zoho.auth = true
		await store.setAuth({ kind: 'self', clientId: 'c', clientSecret: 's', refreshToken: 'r' })
		await store.saveSettings({ email: 'me@example.com', zohoMode: 'timelogs' })
		await cmd.addManualEntry({ date: '2026-10-12', from: '09:00', to: '13:00', text: 'Four hours on the retry logic', jobId: 'j1' })
		const uids = (await store.entries('2026-10-12')).map((e) => e.uid)

		// What the Review screen sends when you choose "no longer than 2 hours".
		const r = await cmd.pushDay(
			'2026-10-12',
			[
				{ jobId: 'j1', minutes: 120, description: 'Four hours on the retry logic' },
				{ jobId: 'j1', minutes: 120, description: 'Four hours on the retry logic' },
			],
			uids,
		)
		expect(r.status).toBe('pushed')
		expect(zoho.logged).toHaveLength(2)
		expect((await store.entries('2026-10-12')).every((e) => e.synced)).toBe(true)
		expect((await store.day('2026-10-12')).timelogStatus).toBe('pushed')
	})

	it('should stop at the row Zoho refused, leaving the rest to retry', async () => {
		at('2026-10-12T18:00:00')
		zoho.auth = true
		await store.setAuth({ kind: 'self', clientId: 'c', clientSecret: 's', refreshToken: 'r' })
		await store.saveSettings({ email: 'me@example.com', zohoMode: 'timelogs' })
		await cmd.addManualEntry({ date: '2026-10-12', from: '09:00', to: '13:00', text: 'Four hours', jobId: 'j1' })
		const uids = (await store.entries('2026-10-12')).map((e) => e.uid)
		zoho.timelogError = new ZohoError('Cannot log time beyond attendance hours')

		const r = await cmd.pushDay('2026-10-12', [{ jobId: 'j1', minutes: 120, description: 'a' }, { jobId: 'j1', minutes: 120, description: 'b' }], uids)
		expect(r.status).toBe('beyond')
		expect((await store.entries('2026-10-12')).some((e) => e.synced)).toBe(false) // nothing claimed
	})
})

describe('a day’s task history', () => {
	it('should keep saved links out of the work you pick from', async () => {
		at('2026-10-12T10:00:00')
		await cmd.confirmAttendance('in')
		await cmd.createTask({ title: 'Fix the retry logic' })
		await cmd.saveTabs([{ title: 'Zoho API docs', url: 'https://zoho.com/api' }])

		const ctx = await cmd.promptContext()
		expect(ctx.tasks.map((t) => t.title)).toEqual(['Fix the retry logic']) // the saved tab is not a task
	})

	it('should record when a task was finished, and show it under that day', async () => {
		at('2026-10-12T10:00:00')
		const task = await cmd.createTask({ title: 'Review the Garud PR' })
		at('2026-10-12T16:30:00')
		await cmd.answerTask(task.uid, 'done')
		expect((await store.tasks())[0].doneAt).toBe(clock)

		const today = await cmd.tasksOn('2026-10-12')
		expect(today.done.map((t) => t.title)).toEqual(['Review the Garud PR'])
		expect(today.open).toEqual([])
	})

	it('should show yesterday separately from today', async () => {
		at('2026-10-12T10:00:00')
		const old = await cmd.createTask({ title: 'Yesterday’s work' })
		await cmd.answerTask(old.uid, 'done')
		await cmd.saveTabs([{ title: 'A link kept yesterday', url: 'https://example.com' }])

		at('2026-10-13T10:00:00')
		await cmd.createTask({ title: 'Today’s work' })

		const yesterday = await cmd.tasksOn('2026-10-12')
		expect(yesterday.done.map((t) => t.title)).toEqual(['Yesterday’s work'])
		expect(yesterday.notes.map((t) => t.title)).toEqual(['A link kept yesterday'])

		const today = await cmd.tasksOn('2026-10-13')
		expect(today.open.map((t) => t.title)).toEqual(['Today’s work'])
		expect(today.done).toEqual([])
	})

	it('should list a task on the day its reminder is due, not only the day it was made', async () => {
		at('2026-10-12T10:00:00')
		await cmd.capture({ text: 'Call the bank back', when: '2026-10-14T11:00' })
		expect((await cmd.tasksOn('2026-10-14')).open.map((t) => t.title)).toEqual(['Call the bank back'])
	})
})

describe('alarms and the discipline they protect', () => {
	it('should ring, not only show, when the check-in is overdue', async () => {
		at('2026-10-12T09:16:00') // past shift start + grace
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'checkin', blocking: true })
		expect(ui.chimes).toBe(1)
	})

	it('should stay silent when you turned the check-in alarm off', async () => {
		at('2026-10-12T09:16:00')
		await store.saveSettings({ alarmCheckIn: false })
		await engine.tick()
		expect(await pending()).toMatchObject({ kind: 'checkin' }) // still shown
		expect(ui.chimes).toBe(0) // just not rung
	})

	it('should ring at the end of the shift so the day gets closed', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T18:31:00') // shift end
		await engine.tick()
		expect(ui.notes).toContain('wrapup')
		expect(ui.chimes).toBe(1)
	})

	it('should suggest a break after a long stretch, once per stretch', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')

		at('2026-10-12T11:59:00')
		await engine.tick()
		expect(ui.notes).not.toContain('break')

		at('2026-10-12T12:00:00') // three hours in
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'break')).toHaveLength(1)

		at('2026-10-12T12:30:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'break')).toHaveLength(1) // not every minute

		// A break resets the stretch, so the afternoon is watched too.
		await cmd.takeBreak(parseIst('2026-10-12T12:30:00'), parseIst('2026-10-12T12:45:00'))
		at('2026-10-12T15:46:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'break')).toHaveLength(2)
	})

	it('should not interrupt a focus session to suggest a break', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.startFocus(240)
		at('2026-10-12T12:05:00')
		await engine.tick()
		expect(ui.notes).not.toContain('break')
	})

	it('should leave breaks alone when you switch them off', async () => {
		at('2026-10-12T09:00:00')
		await store.saveSettings({ breakAfterHours: 0 })
		await cmd.confirmAttendance('in')
		at('2026-10-12T14:00:00')
		await engine.tick()
		expect(ui.notes).not.toContain('break')
	})
})

describe('meetings that repeat every week', () => {
	const standup = { name: 'Standup', time: '09:45', days: [1, 2, 3, 4, 5], leadMinutes: 5 }

	it('should nudge before it starts, once, and not again that day', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in') // otherwise the check-in alarm rings too
		await cmd.saveMeeting(standup)

		at('2026-10-12T09:39:00')
		await engine.tick()
		expect(ui.notes.some((n) => n.startsWith('meeting-'))).toBe(false)

		at('2026-10-12T09:40:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n.startsWith('meeting-'))).toHaveLength(1)
		// A meeting rings rather than pings: it starts without you.
		expect(ui.rings).toBe(1)
		expect(ui.ringing).toBe(true)

		at('2026-10-12T09:44:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n.startsWith('meeting-'))).toHaveLength(1) // said once
	})

	it('should come back tomorrow, and stay quiet at the weekend', async () => {
		at('2026-10-12T09:40:00')
		await cmd.saveMeeting(standup)
		await engine.tick()
		const first = ui.notes.filter((n) => n.startsWith('meeting-')).length

		at('2026-10-13T09:40:00') // Tuesday
		await engine.tick()
		expect(ui.notes.filter((n) => n.startsWith('meeting-'))).toHaveLength(first + 1)

		at('2026-10-17T09:40:00') // Saturday
		await engine.tick()
		expect(ui.notes.filter((n) => n.startsWith('meeting-'))).toHaveLength(first + 1)
	})

	it('should hold several, and mute one without touching the others', async () => {
		at('2026-10-12T09:00:00')
		await cmd.saveMeeting(standup)
		const review = await cmd.saveMeeting({ name: 'Sprint review', time: '16:00', days: [5], leadMinutes: 10 })
		expect((await cmd.meetings()).map((m) => m.name)).toEqual(['Standup', 'Sprint review'])

		await cmd.saveMeeting({ ...review, enabled: false })
		at('2026-10-16T15:50:00') // Friday
		await engine.tick()
		expect(ui.notes.some((n) => n === `meeting-${review.id}`)).toBe(false)
	})

	it('should refuse a meeting with no name, no time or no days', async () => {
		at('2026-10-12T09:00:00')
		await expect(cmd.saveMeeting({ ...standup, name: ' ' })).rejects.toThrow('name')
		await expect(cmd.saveMeeting({ ...standup, time: '25:00' })).rejects.toThrow('time like')
		await expect(cmd.saveMeeting({ ...standup, days: [] })).rejects.toThrow('at least one day')
	})

	it('should let a retimed meeting speak again today', async () => {
		at('2026-10-12T09:40:00')
		const m = await cmd.saveMeeting(standup)
		await engine.tick()
		const said = ui.notes.filter((n) => n.startsWith('meeting-')).length

		await cmd.saveMeeting({ ...m, time: '14:00' }) // moved
		at('2026-10-12T13:55:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n.startsWith('meeting-'))).toHaveLength(said + 1)
	})
})

describe("a ticket's links, kept together", () => {
	// Four sites per ticket — the PR, the dev deploy, stage, the test cases. Saved
	// under the ticket, they are one named group to open any time after.
	const save = () =>
		cmd.saveWorkspace({
			name: 'PAY-2433 financing button',
			tabs: [{ title: 'Pull request #812', url: 'https://github.com/acme/api/pull/812' }],
		})

	it('should guess what each link is, so it still reads months later', async () => {
		const space = await save()
		expect(space.tabs[0].note).toBe('PR')
		await cmd.addToWorkspace(space.id, [{ title: 'Deploy', url: 'https://stage.acme.com/orders' }])
		const [saved] = await cmd.workspaces()
		expect(saved.tabs.map((t) => t.note)).toEqual(['PR', 'Stage'])
	})

	it('should take the links that turn up on later days', async () => {
		const space = await save()
		await cmd.addToWorkspace(space.id, [{ title: 'Jenkins build', url: 'https://jenkins.acme.com/job/api/9' }])
		await cmd.addToWorkspace(space.id, [{ title: 'Test cases', url: 'https://confluence.acme.com/wiki/PAY-2433' }])
		const [saved] = await cmd.workspaces()
		expect(saved.tabs).toHaveLength(3)
	})

	it('should refuse a link it already has, rather than list it twice', async () => {
		const space = await save()
		await expect(cmd.addToWorkspace(space.id, [{ title: 'Same PR', url: 'https://github.com/acme/api/pull/812' }])).rejects.toThrow(/already/i)
	})

	it('should let you say what a link is for, in your words', async () => {
		const space = await save()
		await cmd.editLink(space.id, 'https://github.com/acme/api/pull/812', { note: 'merged on dev, waiting for stage' })
		const [saved] = await cmd.workspaces()
		expect(saved.tabs[0].note).toBe('merged on dev, waiting for stage')
	})

	it('should open every link as one group named after the ticket', async () => {
		const space = await save()
		await cmd.addToWorkspace(space.id, [{ title: 'Stage', url: 'https://stage.acme.com/orders' }])
		await cmd.openWorkspace(space.id)
		// The ticket's own page leads the group, then its links.
		expect(ui.opened).toEqual([`dashboard#/links/${space.id}`, 'https://github.com/acme/api/pull/812', 'https://stage.acme.com/orders'])
		expect(ui.openedAs).toEqual(['PAY-2433 financing button'])
	})

	it('should keep the name findable after a rename, and forget a removed link', async () => {
		const space = await save()
		await cmd.renameWorkspace(space.id, 'PAY-2433 financing button (done)')
		await cmd.removeLink(space.id, 'https://github.com/acme/api/pull/812')
		const [saved] = await cmd.workspaces()
		expect(saved.name).toBe('PAY-2433 financing button (done)')
		expect(saved.tabs).toEqual([])
	})

	it('should not touch a workspace that is gone', async () => {
		await expect(cmd.addToWorkspace('nope', [{ title: 'x', url: 'https://x.com' }])).rejects.toThrow(/gone/i)
		await expect(cmd.renameWorkspace('nope', '')).rejects.toThrow(/name/i)
	})
})

describe("a ticket's notes", () => {
	const save = () => cmd.saveWorkspace({ name: 'PAY-2398 refunds', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/9' }] })

	it('should file a note under the day it was written', async () => {
		at('2026-10-13T11:00:00')
		const space = await save()
		const note = await cmd.saveNote(space.id, { text: '## Decided\n\n- [ ] verify on stage' })
		expect(note.date).toBe('2026-10-13')
		const [saved] = await cmd.workspaces()
		expect(saved.notes).toHaveLength(1)
	})

	it('should let you write up yesterday today', async () => {
		at('2026-10-13T11:00:00')
		const space = await save()
		await cmd.saveNote(space.id, { text: 'what we agreed', date: '2026-10-12' })
		await cmd.saveNote(space.id, { text: 'today', date: '2026-10-13' })
		const [saved] = await cmd.workspaces()
		expect(saved.notes?.map((n) => n.date)).toEqual(['2026-10-13', '2026-10-12']) // newest day first
	})

	it('should edit a note in place, keeping its day', async () => {
		at('2026-10-13T11:00:00')
		const space = await save()
		const note = await cmd.saveNote(space.id, { text: 'first pass' })
		at('2026-10-14T09:00:00')
		const edited = await cmd.saveNote(space.id, { noteId: note.id, text: 'second pass' })
		expect(edited).toMatchObject({ id: note.id, date: '2026-10-13', text: 'second pass' })
		expect(edited.editedAt).toBeGreaterThan(note.at)
		const [saved] = await cmd.workspaces()
		expect(saved.notes).toHaveLength(1)
	})

	it('should refuse an empty note and a note that is gone', async () => {
		const space = await save()
		await expect(cmd.saveNote(space.id, { text: '   ' })).rejects.toThrow(/nothing/i)
		await expect(cmd.saveNote(space.id, { noteId: 'nope', text: 'x' })).rejects.toThrow(/gone/i)
		await expect(cmd.saveNote('nope', { text: 'x' })).rejects.toThrow(/gone/i)
	})

	it('should delete one note and leave the rest', async () => {
		const space = await save()
		const a = await cmd.saveNote(space.id, { text: 'keep me' })
		const b = await cmd.saveNote(space.id, { text: 'drop me' })
		await cmd.deleteNote(space.id, b.id)
		const [saved] = await cmd.workspaces()
		expect(saved.notes?.map((n) => n.id)).toEqual([a.id])
	})
})

describe('changing a ticket later', () => {
	const save = () => cmd.saveWorkspace({ name: 'PAY-2398 refunds', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/9' }] })

	it('should add one link pasted by hand, with the name you give it', async () => {
		const space = await save()
		await cmd.addToWorkspace(space.id, [{ title: 'Stage deploy', url: 'https://stage.acme.com/orders', note: 'after the Thursday release' }])
		const [saved] = await cmd.workspaces()
		expect(saved.tabs[1]).toMatchObject({ title: 'Stage deploy', note: 'after the Thursday release' })
	})

	it('should refuse something that is not a link, and say why', async () => {
		const space = await save()
		await expect(cmd.addToWorkspace(space.id, [{ title: 'oops', url: 'stage.acme.com' }])).rejects.toThrow(/http/i)
		await expect(cmd.addToWorkspace(space.id, [{ title: 'bad', url: 'javascript:alert(1)' }])).rejects.toThrow(/http/i)
	})

	it('should rename a link and relabel it, together or apart', async () => {
		const space = await save()
		const url = 'https://github.com/acme/api/pull/9'
		await cmd.editLink(space.id, url, { title: 'Refunds PR #9' })
		expect((await cmd.workspaces())[0].tabs[0]).toMatchObject({ title: 'Refunds PR #9', note: 'PR' }) // label untouched
		await cmd.editLink(space.id, url, { note: 'merged, waiting on stage' })
		expect((await cmd.workspaces())[0].tabs[0]).toMatchObject({ title: 'Refunds PR #9', note: 'merged, waiting on stage' })
	})

	it('should fall back to the address rather than leave a link nameless', async () => {
		const space = await save()
		await cmd.editLink(space.id, 'https://github.com/acme/api/pull/9', { title: '   ' })
		expect((await cmd.workspaces())[0].tabs[0].title).toBe('https://github.com/acme/api/pull/9')
	})

	it('should clear a label when you empty it', async () => {
		const space = await save()
		await cmd.editLink(space.id, 'https://github.com/acme/api/pull/9', { note: '' })
		expect((await cmd.workspaces())[0].tabs[0].note).toBeUndefined()
	})
})

describe('a time someone else wrote', () => {
	it('should read it in my zone, and in the zones I watch', async () => {
		at('2026-07-01T18:00:00') // 11:30pm in India, 11am in Los Angeles
		await cmd.saveSettings({ myZone: 'Asia/Kolkata', otherZones: ['Europe/London'] })
		const c = await cmd.convertTime('standup moved to 3pm PST')
		expect(c?.rows.map((r) => [r.label, r.time])).toEqual([
			['Kolkata', '3:30 AM'],
			['London', '11:00 PM'],
			['Los Angeles', '3:00 PM'],
		])
		expect(c?.assumedZone).toBe(false)
	})

	it('should read a bare time as mine, rather than refuse', async () => {
		await cmd.saveSettings({ myZone: 'Asia/Kolkata', otherZones: [] })
		const c = await cmd.convertTime('call at 09:45')
		expect(c).toMatchObject({ assumedZone: true, from: 'Asia/Kolkata' })
		expect(c?.rows[0].time).toBe('9:45 AM')
	})

	it('should say nothing when the selection holds no time', async () => {
		expect(await cmd.convertTime('PAY-2433 financing button')).toBeNull()
	})
})

describe('a date and a time together', () => {
	it('should read the date that was written, not today', async () => {
		at('2026-10-13T06:00:00')
		await cmd.saveSettings({ myZone: 'Asia/Kolkata', otherZones: ['America/New_York'] })
		const c = await cmd.convertTime('Oct 12, 17:44 GMT+5:30')
		expect(c?.read).toBe('Oct 12 17:44 GMT+5:30') // the date and the time, as read
		expect(c?.rows).toEqual([
			{ zone: 'Asia/Kolkata', label: 'Kolkata', time: '5:44 PM', day: 'Mon 12 Oct', otherDay: false, mine: true },
			{ zone: 'America/New_York', label: 'New York', time: '8:14 AM', day: 'Mon 12 Oct', otherDay: false, mine: false },
			{ zone: 'GMT+5:30', label: 'GMT+5:30', time: '5:44 PM', day: 'Mon 12 Oct', otherDay: false, mine: false },
		])
	})
})

describe('snoozing an hourly prompt', () => {
	beforeEach(async () => {
		at('2026-10-12T09:00:00')
		await cmd.saveSettings({ promptInterval: 30, myZone: 'Asia/Kolkata' })
		await cmd.confirmAttendance('in')
	})

	it('should ask once for the whole gap, not once per interval', async () => {
		at('2026-10-12T09:30:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('prompt')

		await cmd.snooze()
		expect((await cmd.overlayState()).pending).toBeNull()

		// Half an hour later a second interval has also passed. There is one hour
		// of unlogged time, so there is one card — not one per interval.
		at('2026-10-12T10:05:00')
		await engine.tick()
		const state = await cmd.overlayState()
		expect(state.pending?.kind).toBe('prompt')
		expect(state.prompt?.totalMinutes).toBe(65) // 09:00 → 10:05, in one slot

		// The next tick re-presents the same card rather than queueing another.
		const since = state.pending!.since
		at('2026-10-12T10:06:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending!.since).toBe(since)
	})

	it('should take the card away when the hour was logged somewhere else', async () => {
		at('2026-10-12T09:30:00')
		await engine.tick()
		await cmd.snooze()

		at('2026-10-12T09:40:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'wrote the parser', minutes: 40 })

		at('2026-10-12T09:45:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull()
		expect(await engine.owed({ kind: 'prompt', blocking: true, since: parseIst('2026-10-12T09:30:00') })).toBe(false)
	})

	it('should keep asking while the time really is unlogged', async () => {
		at('2026-10-12T09:30:00')
		await engine.tick()
		expect(await engine.owed({ kind: 'prompt', blocking: true, since: parseIst('2026-10-12T09:30:00') })).toBe(true)
	})
})

describe('the end-of-day question', () => {
	beforeEach(async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
	})

	it('should not ask during the day', async () => {
		at('2026-10-12T15:00:00')
		await engine.tick()
		expect(ui.notes).not.toContain('learn')
	})

	it('should ask once after the shift has ended', async () => {
		at('2026-10-12T18:35:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'learn')).toHaveLength(1)
		at('2026-10-12T18:45:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'learn')).toHaveLength(1)
	})

	it('should ask as soon as the day is checked out, before the shift ends', async () => {
		at('2026-10-12T17:00:00')
		await cmd.confirmAttendance('out')
		await engine.tick()
		expect(ui.notes).toContain('learn')
	})

	it('should not ask again once something has been written', async () => {
		at('2026-10-12T17:00:00')
		await cmd.saveLearning({ text: 'Zoho wants the CSRF token in the body #zoho', kind: 'learning' })
		at('2026-10-12T18:35:00')
		await engine.tick()
		expect(ui.notes).not.toContain('learn')
	})

	it('should stay quiet when the setting is off, and on a day off', async () => {
		await cmd.saveSettings({ learnPrompt: false })
		at('2026-10-12T18:35:00')
		await engine.tick()
		expect(ui.notes).not.toContain('learn')
	})

	it('should tag what it saves and notice a mistake repeating', async () => {
		at('2026-10-12T17:00:00')
		await cmd.saveLearning({ text: 'Forgot the index again #mysql #slow-query', kind: 'mistake' })
		at('2026-10-13T17:00:00')
		await cmd.saveLearning({ text: 'Same missing index, different table #mysql', kind: 'mistake' })
		const list = await cmd.learnings()
		expect(list[0].date).toBe('2026-10-13') // newest day first
		expect(list[1].tags).toEqual(['mysql', 'slow-query'])
		expect(await cmd.learnRepeats()).toEqual([{ tag: 'mysql', count: 2, lastAt: parseIst('2026-10-13T17:00:00') }])
	})
})

describe('the learning loop', () => {
	const mistake = (text: string) => cmd.saveLearning({ text, kind: 'mistake' })

	it('should name the mistake that keeps coming back, once a week', async () => {
		at('2026-10-12T10:00:00')
		await mistake('Missing index again #mysql')
		at('2026-10-13T10:00:00')
		await mistake('Same thing, other table #mysql')

		at('2026-10-13T11:00:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'loop')).toHaveLength(1)

		// Not again tomorrow.
		at('2026-10-14T11:00:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'loop')).toHaveLength(1)

		// A week later, if it is still the state of things, it says so again.
		at('2026-10-21T11:00:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'loop')).toHaveLength(2)
	})

	it('should count a mistake Claude Code recorded in the Brain alongside my own', async () => {
		at('2026-10-13T10:00:00')
		await mistake('Forgot the retry path #webhooks')
		const line = JSON.stringify({ id: 'b1', at: Date.parse('2026-10-12T10:00:00+05:30'), device: 'cli-mac', kind: 'mistake', title: 'Retry path again #webhooks' })
		await engine.store.updateRuntime((r) => void (r.bridge = { files: { 'bridge/entries/2026-10/cli-mac.jsonl': line } }))
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'loop')).toHaveLength(1)
	})

	it('should stay quiet when nothing has repeated', async () => {
		at('2026-10-13T10:00:00')
		await mistake('One-off, my own fault #typo')
		await engine.tick()
		expect(ui.notes).not.toContain('loop')
	})

	it('should stay quiet when the setting is off', async () => {
		await cmd.saveSettings({ learnLoop: false })
		at('2026-10-12T10:00:00')
		await mistake('a #ci')
		at('2026-10-13T10:00:00')
		await mistake('b #ci')
		await engine.tick()
		expect(ui.notes).not.toContain('loop')
	})

	it('should hand back what you wrote the previous times', async () => {
		at('2026-10-12T10:00:00')
		await mistake('first time #mysql')
		at('2026-10-13T10:00:00')
		await mistake('second time #mysql')
		expect((await cmd.learnBehind('mysql')).map((l) => l.text)).toEqual(['first time #mysql', 'second time #mysql'])
	})
})

describe('linking a learning to a ticket', () => {
	it('should link and unlink at any time, and show on the ticket', async () => {
		at('2026-10-13T10:00:00')
		const ticket = await cmd.saveWorkspace({ name: 'PAY-2398 refunds', tabs: [{ title: 'PR', url: 'https://github.com/a/b/pull/1' }] })
		const note = await cmd.saveLearning({ text: 'Refunds need the idempotency key #payments' })
		expect(await cmd.learnFor(ticket.id)).toEqual([])

		await cmd.linkLearning(note.id, ticket.id)
		expect((await cmd.learnFor(ticket.id)).map((l) => l.id)).toEqual([note.id])

		await cmd.linkLearning(note.id, null)
		expect(await cmd.learnFor(ticket.id)).toEqual([])
	})

	it('should offer every tag used, most used first', async () => {
		await cmd.saveLearning({ text: 'a #ci #mysql' })
		await cmd.saveLearning({ text: 'b #ci' })
		expect((await cmd.learnTags()).map((t) => [t.tag, t.count])).toEqual([
			['ci', 2],
			['mysql', 1],
		])
	})

	it('should refuse a note or a ticket that is gone', async () => {
		await expect(cmd.linkLearning('nope', null)).rejects.toThrow(/gone/i)
		const note = await cmd.saveLearning({ text: 'x' })
		await expect(cmd.linkLearning(note.id, 'nope')).rejects.toThrow(/gone/i)
	})
})

describe('filing a page from the right-click menu', () => {
	beforeEach(async () => {
		await cmd.saveSettings({ ticketPrefixes: ['PAY', 'LEAP'] })
	})

	it('should offer the ticket whose key this page carries', async () => {
		const w = await cmd.saveWorkspace({ name: 'PAY-2433 financing button', tabs: [{ title: 'PR', url: 'https://github.com/a/b/pull/1' }] })
		const menu = await cmd.pageMenuFor({ title: 'PAY-2433 · financing', url: 'https://jira/browse/PAY-2433' })
		expect(menu[1]).toMatchObject({ id: `wp-add:${w.id}`, title: 'Add this page to PAY-2433 financing button' })
	})

	it('should offer to start a ticket from a key it has not seen', async () => {
		const menu = await cmd.pageMenuFor({ title: 'LEAP-3233 refunds', url: 'https://jira/browse/LEAP-3233' })
		expect(menu.map((m) => m.title)).toContain('New ticket LEAP-3233 with this page')
	})

	it('should ignore a key that is not one of my prefixes', async () => {
		const menu = await cmd.pageMenuFor({ title: 'ABC-99 someone else', url: 'https://jira/browse/ABC-99' })
		expect(menu.map((m) => m.title)).not.toContain('New ticket ABC-99 with this page')
	})

	it('should start the ticket with the page as its first link', async () => {
		const w = await cmd.ticketFromKey('PAY-2433', { title: 'Financing button', url: 'https://jira/browse/PAY-2433' })
		expect(w.name).toBe('PAY-2433 Financing button')
		expect(w.tabs[0]).toMatchObject({ url: 'https://jira/browse/PAY-2433', note: 'Ticket' })
	})
})

describe('clearing a reminder from the tasks page', () => {
	it('should take the time off without finishing the task', async () => {
		at('2026-10-13T09:00:00')
		const task = await cmd.capture({ text: 'Drink water', kind: 'task', when: '2026-10-13T11:00', repeatMinutes: 60 })
		await cmd.answerReminder(task.uid, 'stop')
		const after = (await cmd.tasks()).tasks.find((t) => t.uid === task.uid)!
		expect(after).toMatchObject({ status: 'todo' })
		expect(after.remindAt).toBeUndefined()
		expect(after.repeatMinutes).toBeUndefined()
	})
})

describe('a page whose ticket is only in its body', () => {
	beforeEach(() => cmd.saveSettings({ ticketPrefixes: ['PAY'] }))

	it('should match a key found in the page to an existing ticket', async () => {
		const w = await cmd.saveWorkspace({ name: 'PAY-2433 financing button', tabs: [{ title: 'PR', url: 'https://github.com/a/b/pull/1' }] })
		// Title and address say nothing; the page text named it.
		const menu = await cmd.pageMenuFor({ title: 'Release checklist', url: 'https://confluence/x', keys: ['PAY-2433'] })
		expect(menu[1]).toMatchObject({ id: `wp-add:${w.id}` })
	})

	it('should offer to start one for a key found only in the page', async () => {
		const menu = await cmd.pageMenuFor({ title: 'Release checklist', url: 'https://confluence/x', keys: ['PAY-99'] })
		expect(menu.map((m) => m.title)).toContain('New ticket PAY-99 with this page')
	})

	it('should hand the page a pattern built from my prefixes', async () => {
		expect(await cmd.keyPattern()).toBe('\\b(PAY)-(\\d{1,6})\\b')
		await cmd.saveSettings({ ticketPrefixes: [] })
		expect(await cmd.keyPattern()).toBe('\\b([A-Z]{2,10})-(\\d{1,6})\\b')
	})

	it('should say which of several keys already has a ticket', async () => {
		const w = await cmd.saveWorkspace({ name: 'PAY-2433 financing', tabs: [{ title: 'x', url: 'https://x.com/1' }] })
		expect(await cmd.ticketsForKeys(['PAY-2433', 'PAY-99'])).toEqual([
			{ key: 'PAY-2433', ticketId: w.id, name: 'PAY-2433 financing' },
			{ key: 'PAY-99', ticketId: undefined, name: undefined },
		])
	})
})

describe('a ticket from what Claude Code recorded', () => {
	const entry = (o: Record<string, unknown>) => JSON.stringify({ id: 'e1', at: Date.parse('2026-10-25T10:00:00Z'), device: 'cli-a', kind: 'ticket', title: 'Double submit', ...o })
	const seed = (...lines: string[]) =>
		engine.store.updateRuntime((r) => void (r.bridge = { files: { 'bridge/entries/2026-10/cli-a.jsonl': lines.join('\n') } }))

	it('should start the ticket with the entry’s pull request as its first link, and its ask as the note', async () => {
		await seed(entry({ ticket: 'PAY-77', asked: 'Stop the double submit', links: { pr: 'https://github.com/acme/web/pull/9' } }))
		expect(await cmd.brainTickets(['PAY-77'])).toEqual({ 'PAY-77': null })
		const { id } = await cmd.ticketFromBrain('e1')
		const w = (await engine.store.workspaces()).find((x) => x.id === id)!
		expect(w.name).toBe('PAY-77 Double submit')
		expect(w.note).toBe('Stop the double submit')
		expect(w.tabs.map((t) => t.url)).toEqual(['https://github.com/acme/web/pull/9'])
		expect(await cmd.brainTickets(['PAY-77'])).toEqual({ 'PAY-77': id })
	})

	it('should name it from the ticket record and gather its links, whichever entry was clicked', async () => {
		await seed(
			entry({ id: 'e1', kind: 'mistake', ticket: 'PAY-79', title: 'Enter key path' }),
			entry({ id: 'e2', ticket: 'PAY-79', title: 'Refund flow', asked: 'Stop double refunds', links: { pr: 'https://github.com/acme/web/pull/11', urls: ['https://stage.acme.com/r'] } }),
		)
		const { id } = await cmd.ticketFromBrain('e1')
		const w = (await engine.store.workspaces()).find((x) => x.id === id)!
		expect(w.name).toBe('PAY-79 Refund flow')
		expect(w.note).toBe('Stop double refunds')
		expect(w.tabs.map((t) => t.url)).toEqual(['https://github.com/acme/web/pull/11', 'https://stage.acme.com/r'])
	})

	it('should open the one already saved rather than make a second', async () => {
		const have = await cmd.saveWorkspace({ name: 'PAY-78 checkout', tabs: [{ title: 'x', url: 'https://x.com/1' }] })
		await seed(entry({ ticket: 'PAY-78', links: { pr: 'https://github.com/acme/web/pull/10' } }))
		expect(await cmd.ticketFromBrain('e1')).toEqual({ id: have.id })
		expect((await engine.store.workspaces()).filter((w) => w.name.startsWith('PAY-78'))).toHaveLength(1)
	})

	it('should refuse an entry with no ticket key', async () => {
		await seed(entry({ kind: 'learning' }))
		await expect(cmd.ticketFromBrain('e1')).rejects.toThrow(/no ticket key/)
	})
})

describe('a hundred of everything', () => {
	it('should not quietly drop a ticket past the old cap of fifty', async () => {
		at('2026-10-13T09:00:00')
		for (let i = 0; i < 60; i++) await cmd.saveWorkspace({ name: `PAY-${i} thing`, tabs: [{ title: `t${i}`, url: `https://x.com/${i}` }] })
		expect(await cmd.ticketList()).toHaveLength(60)
	})

	it('should refuse rather than drop when a ticket is full of links', async () => {
		const w = await cmd.saveWorkspace({ name: 'PAY-1', tabs: [{ title: 'a', url: 'https://x.com/a' }] })
		const many = Array.from({ length: 220 }, (_, i) => ({ title: `t${i}`, url: `https://x.com/p/${i}` }))
		await cmd.addToWorkspace(w.id, many)
		expect((await cmd.ticket(w.id))!.tabs).toHaveLength(200) // the cap, filled
		await expect(cmd.addToWorkspace(w.id, [{ title: 'one more', url: 'https://x.com/last' }])).rejects.toThrow(/200 links/)
	})

	it('should send the list without the notes and links in it', async () => {
		const w = await cmd.saveWorkspace({ name: 'PAY-2433 financing', tabs: [{ title: 'PR', url: 'https://github.com/a/b/pull/1' }] })
		await cmd.saveNote(w.id, { text: '## Decided\n\n- [ ] verify on stage' })
		const [row] = await cmd.ticketList()
		expect(row).toMatchObject({ id: w.id, name: 'PAY-2433 financing', links: 1, notes: 1, latestNote: 'Decided' })
		expect(Object.keys(row)).not.toContain('tabs')
		expect(row.hay).toContain('github.com')
	})

	it('should stamp what changed last, and keep opening separate from changing', async () => {
		at('2026-10-13T09:00:00')
		const w = await cmd.saveWorkspace({ name: 'PAY-1', tabs: [{ title: 'a', url: 'https://x.com/a' }] })
		at('2026-10-13T10:00:00')
		await cmd.openWorkspace(w.id)
		expect((await cmd.ticketList())[0]).toMatchObject({ updatedAt: parseIst('2026-10-13T09:00:00'), lastOpenedAt: parseIst('2026-10-13T10:00:00') })

		at('2026-10-13T11:00:00')
		await cmd.editLink(w.id, 'https://x.com/a', { note: 'merged' })
		expect((await cmd.ticketList())[0].updatedAt).toBe(parseIst('2026-10-13T11:00:00'))
	})

	it('should order a hundred tickets by what changed last', async () => {
		at('2026-10-13T09:00:00')
		const a = await cmd.saveWorkspace({ name: 'PAY-1', tabs: [{ title: 'a', url: 'https://x.com/a' }] })
		at('2026-10-13T09:05:00')
		await cmd.saveWorkspace({ name: 'PAY-2', tabs: [{ title: 'b', url: 'https://x.com/b' }] })
		at('2026-10-13T12:00:00')
		await cmd.saveNote(a.id, { text: 'touched later' })
		expect(sortTickets(await cmd.ticketList(), 'activity')[0].name).toBe('PAY-1')
		expect(sortTickets(await cmd.ticketList(), 'created')[0].name).toBe('PAY-2')
	})
})

describe('backing up to your own repository', () => {
	it('should leave the token, the client id and the email out of the backup', async () => {
		await cmd.saveSettings({ email: 'me@example.com', oauthClientId: 'secret-client' })
		await cmd.saveSyncToken('github_pat_secret')
		const json = JSON.stringify(await cmd.backup())
		expect(json).not.toContain('github_pat_secret')
		expect(json).not.toContain('secret-client')
		expect(json).not.toContain('me@example.com')
	})

	it('should carry everything worth restoring', async () => {
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		const ticket = await cmd.saveWorkspace({ name: 'PAY-2433 financing', tabs: [{ title: 'PR', url: 'https://github.com/a/b/pull/1' }] })
		await cmd.saveNote(ticket.id, { text: 'waiting on the flag' })
		await cmd.saveLearning({ text: 'CSRF goes in the body #zoho', kind: 'learning' })
		at('2026-10-13T10:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'wrote the parser', minutes: 60 })

		const b = await cmd.backup()
		expect(b.version).toBe(1)
		expect(b.learnings).toHaveLength(1)
		expect(b.tickets).toHaveLength(1)
		expect(b.entries['2026-10-13']).toHaveLength(1)
		expect(b.days.some((d) => (d as { date: string }).date === '2026-10-13')).toBe(true)
	})

	it('should say what is missing before it tries to talk to GitHub', async () => {
		await cmd.saveSettings({ syncRepo: '' })
		await expect(cmd.pushBackup()).rejects.toThrow(/repository first/i)
		await cmd.saveSettings({ syncRepo: 'me/notes' })
		await expect(cmd.pushBackup()).rejects.toThrow(/token/i)
	})

	it('should report what is set up without ever handing the token back', async () => {
		await cmd.saveSettings({ syncRepo: 'me/notes', syncPath: 'notes' })
		await cmd.saveSyncToken('github_pat_secret')
		const state = await cmd.syncState()
		expect(state).toMatchObject({ repo: 'me/notes', path: 'notes', hasToken: true })
		expect(JSON.stringify(state)).not.toContain('github_pat_secret')
	})
})

describe('the daily backup', () => {
	beforeEach(async () => {
		await cmd.saveSettings({ syncRepo: 'me/notes', syncDaily: true, syncAfter: '19:00' })
		await cmd.saveSyncToken('tok')
		// The first backup was pressed by hand on an earlier day; from then on it is daily.
		await engine.store.updateRuntime((r) => void (r.sync = { ...r.sync, at: Date.parse('2026-10-01T19:00:00+05:30') }))
	})

	it('should never make the first backup on its own — that one is pressed, with the branch on screen', async () => {
		await engine.store.updateRuntime((r) => void (r.sync = undefined))
		at('2026-10-12T19:05:00')
		await engine.tick()
		expect(ui.backups).toBe(0)
	})

	it('should not run during the day', async () => {
		at('2026-10-12T15:00:00')
		await engine.tick()
		expect(ui.backups).toBe(0)
	})

	it('should run in the evening, and once only', async () => {
		at('2026-10-12T19:05:00')
		await engine.tick()
		await engine.tick()
		expect(ui.backups).toBe(1)
	})

	it('should run as soon as the day is closed', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T17:00:00')
		await cmd.confirmAttendance('out')
		await engine.tick()
		expect(ui.backups).toBe(1)
	})

	it('should stay out of the way when no repository is set', async () => {
		await cmd.saveSettings({ syncRepo: '' })
		at('2026-10-12T19:05:00')
		await engine.tick()
		expect(ui.backups).toBe(0)
	})
})

describe('setting the backup up', () => {
	it('should want the repository before the token, because the token is scoped to it', async () => {
		expect(setupStep({ madeRepo: false, hasToken: false, repo: '' })).toBe('repo')
		expect(setupStep({ madeRepo: true, hasToken: false, repo: '' })).toBe('token')
	})

	it('should refuse to list repositories before a token is in', async () => {
		await expect(cmd.githubRepos()).rejects.toThrow(/token first/i)
	})

	it('should report the repository and the folder without the token', async () => {
		await cmd.saveSettings({ syncRepo: 'me/notes', syncPath: 'notes' })
		await cmd.saveSyncToken('github_pat_secret')
		const s = await cmd.syncState()
		expect(setupStep({ madeRepo: true, hasToken: s.hasToken, repo: s.repo })).toBe('backup')
		expect(JSON.stringify(s)).not.toContain('github_pat_secret')
	})
})

describe('a meeting reaching you', () => {
	const standup = { name: 'Standup', time: '09:45', days: [1, 2, 3, 4, 5], leadMinutes: 5 }

	it('should put a card on the screen, not only a notification', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.saveMeeting(standup)
		at('2026-10-12T09:40:00')
		await engine.tick()

		const state = await cmd.overlayState()
		expect(state.pending).toMatchObject({ kind: 'meeting', title: 'Standup', blocking: false })
		expect(state.pending?.body).toContain('in 5 minutes')
		expect(ui.notes.some((n) => n.startsWith('meeting-'))).toBe(true)
		expect(ui.ringing).toBe(true)
		expect(ui.shown.some((p) => p.kind === 'meeting')).toBe(true)
	})

	it('should arrive with the three points a scrum asks for', async () => {
		at('2026-10-12T09:00:00')
		await cmd.saveSettings({ promptInterval: 60, workDays: [1, 2, 3, 4, 5] })
		await cmd.confirmAttendance('in')
		at('2026-10-12T10:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'PAY-2433: wrote the parser', minutes: 60 })
		await cmd.capture({ text: 'PAY-2433 verify on staging' })
		const m = await cmd.saveMeeting({ ...standup, kind: 'scrum', time: '09:45' })

		// The next morning, before the standup.
		at('2026-10-13T09:41:00')
		const brief = await cmd.meetingBrief(m.id)
		expect(brief?.kind).toBe('scrum')
		expect(brief?.when).toBe('morning')
		expect(brief?.points.map((p) => p.heading)).toEqual(['Yesterday', 'Today'])
		expect(brief?.points[0].lines[0]).toContain('PAY-2433')
		expect(brief?.points[0].lines[0]).toContain('wrote the parser')
		expect(brief?.points[1].lines.join(' ')).toContain('verify on staging')
	})

	it('should ask about the day you have just had when the meeting is in the evening', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T10:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'LEAP-12: the migration', minutes: 60 })
		const m = await cmd.saveMeeting({ ...standup, name: 'Wrap-up', kind: 'scrum', time: '18:00' })

		at('2026-10-12T17:56:00')
		const brief = await cmd.meetingBrief(m.id)
		expect(brief?.when).toBe('evening')
		expect(brief?.date).toBe('2026-10-12')
		expect(brief?.points[0].heading).toBe('What I did today')
		expect(brief?.points[0].lines[0]).toContain('LEAP-12')
	})

	it('should follow a meeting that moved, and leave its slot alone when it is called off', async () => {
		at('2026-10-12T09:00:00')
		// A long interval, so the only thing that speaks here is the meeting.
		await cmd.saveSettings({ promptInterval: 240 })
		await cmd.confirmAttendance('in')
		const m = await cmd.saveMeeting({ ...standup, time: '09:45', logMinutes: 15 })

		await cmd.moveMeeting(m.id, '11:30')
		at('2026-10-12T09:41:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull() // not at the old time

		at('2026-10-12T11:26:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toMatchObject({ kind: 'meeting', title: 'Standup' })
		expect((await cmd.overlayState()).pending?.body).toContain('11:30')

		// Called off: nothing is said, and tomorrow it is back without anyone
		// having to remember.
		await cmd.callOffMeeting(m.id)
		expect((await cmd.meetings()).find((x) => x.id === m.id)?.skippedOn).toBe('2026-10-12')
		await cmd.restoreMeeting(m.id)
		const back = (await cmd.meetings()).find((x) => x.id === m.id)
		expect(back?.skippedOn).toBeUndefined()
		expect(back?.movedOn).toBeUndefined()
	})

	it('should stop ringing the moment it is answered', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.saveMeeting(standup)
		at('2026-10-12T09:40:00')
		await engine.tick()
		expect(ui.ringing).toBe(true)

		await cmd.dismiss()
		expect(ui.ringing).toBe(false)
	})

	it('should take the card away once the meeting is well under way', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.saveMeeting(standup)
		at('2026-10-12T09:40:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('meeting')

		at('2026-10-12T10:10:00') // 25 minutes after it started
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).not.toBe('meeting')
	})

	it('should not push a meeting card over something already owed', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.saveMeeting(standup)
		await cmd.logNow() // a prompt is already on the screen
		at('2026-10-12T09:40:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('prompt')
	})

	it('should mute one from the card itself', async () => {
		at('2026-10-12T09:00:00')
		const m = await cmd.saveMeeting(standup)
		await cmd.muteMeeting(m.id)
		expect((await cmd.meetings())[0].enabled).toBe(false)
		expect((await cmd.overlayState()).pending).toBeNull()
		at('2026-10-12T09:40:00')
		await engine.tick()
		expect(ui.notes.some((n) => n.startsWith('meeting-'))).toBe(false)
	})

	it('should prove the whole chain on demand', async () => {
		at('2026-10-13T15:00:00') // nowhere near the meeting
		const m = await cmd.saveMeeting(standup)
		const before = ui.chimes
		await cmd.testMeeting(m.id)
		expect((await cmd.overlayState()).pending).toMatchObject({ kind: 'meeting', title: 'Standup' })
		expect(ui.notes.some((n) => n.startsWith('meeting-'))).toBe(true)
		expect(ui.chimes).toBe(before + 1)
	})
})

describe('changing where the backup goes', () => {
	beforeEach(async () => {
		await cmd.saveSettings({ syncRepo: 'me/first', syncPath: 'workpulse', syncBranch: '' })
		await cmd.saveSyncToken('tok')
	})

	it('should treat every file as new when the repository changes', async () => {
		// Pretend a push to the old repository recorded its hashes.
		const data = await cmd.backup()
		const files = filesFor(data, 'workpulse', parseIst('2026-10-13T19:00:00'))
		await store.updateRuntime((r) => void (r.sync = { at: 1, target: syncTarget('me/first', '', 'workpulse'), files: digestsOf(files) }))

		// Nothing has changed, so a push to the same place would write nothing…
		let rt = await store.runtime()
		expect(changedFiles(files, rt.sync?.target === syncTarget('me/first', '', 'workpulse') ? rt.sync.files : {})).toEqual([])

		// …but to a different repository every file is missing, so every file goes.
		await cmd.saveSettings({ syncRepo: 'me/second' })
		rt = await store.runtime()
		const target = syncTarget('me/second', '', 'workpulse')
		expect(changedFiles(files, rt.sync?.target === target ? rt.sync.files : {})).toHaveLength(files.length)
	})

	it('should do the same when only the folder changes', async () => {
		const target = (path: string) => syncTarget('me/first', '', path)
		expect(target('workpulse')).not.toBe(target('notes'))
	})
})

describe('a repository that already holds your backup', () => {
	// A fresh install pointed at the repository you already use. Its first backup would otherwise write
	// this browser's empty copy over the one in the repository.
	const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
	const manifest = { version: 2, exportedAt: Date.parse('2026-10-20T13:30:00Z'), counts: { days: 40, entries: 300, learnings: 3, tickets: 2 }, shards: { meta: 'workpulse/data/meta.json', days: [], learnings: [], tickets: [] } }
	const github = (opts: { hasBackup: boolean }) => {
		const commits: string[][] = []
		vi.stubGlobal('fetch', (async (url: string, init?: RequestInit) => {
			const u = String(url)
			const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
			if (u.includes('/contents/workpulse/index.json') && init?.method !== 'PUT') return opts.hasBackup ? reply({ content: b64(JSON.stringify(manifest)), sha: 'm' }) : reply({}, 404)
			if (u.includes('/contents/workpulse/data/meta.json')) return reply({ content: b64('{}'), sha: 'x' })
			if (u.includes('/contents/')) return reply({}, 404)
			if (u.endsWith('/git/ref/heads/main')) return reply({ object: { sha: 'head' } })
			if (u.includes('/git/commits/head')) return reply({ tree: { sha: 'tree' } })
			if (u.endsWith('/git/trees')) {
				commits.push(JSON.parse(String(init!.body)).tree.map((t: { path: string }) => t.path))
				return reply({ sha: 'new-tree' })
			}
			if (u.endsWith('/git/commits')) return reply({ sha: 'new-commit' })
			if (u.includes('/git/refs/heads/main')) return reply({})
			return reply({ full_name: 'me/notes', private: true, permissions: { push: true }, default_branch: 'main' })
		}) as unknown as typeof fetch)
		return commits
	}
	beforeEach(async () => {
		await cmd.saveSettings({ syncRepo: 'me/notes', syncPath: 'workpulse', syncBranch: '' })
		await cmd.saveSyncToken('tok')
	})
	afterEach(() => vi.unstubAllGlobals())

	it('should say what is there, and refuse to write this browser over it', async () => {
		const commits = github({ hasBackup: true })
		expect(await cmd.existingBackup()).toEqual({ exists: true, exportedAt: manifest.exportedAt, counts: manifest.counts })
		await expect(cmd.pushBackup()).rejects.toThrow(/me\/notes already has a WorkPulse backup \(3 learnings, 2 tickets\)\. Restore it here first/)
		expect(commits).toEqual([])
	})

	it('should write over it only when asked to', async () => {
		const commits = github({ hasBackup: true })
		await cmd.pushBackup({ overwrite: true })
		expect(commits).toHaveLength(1)
	})

	it('should back up normally once it has been restored here', async () => {
		const commits = github({ hasBackup: true })
		await cmd.restoreBackup()
		expect(await cmd.existingBackup()).toEqual({ exists: false })
		await cmd.pushBackup()
		expect(commits).toHaveLength(1)
	})

	it('should not get in the way of a repository with no backup in it', async () => {
		const commits = github({ hasBackup: false })
		expect(await cmd.existingBackup()).toEqual({ exists: false })
		await cmd.pushBackup()
		expect(commits).toHaveLength(1)
	})
})

describe('a day of hourly logs, cut into timesheet rows', () => {
	it('should give each row the hour it belongs to, not a copy of the whole day', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ promptInterval: 60 })
		await cmd.confirmAttendance('in')

		const log = async (end: string, text: string) => {
			at(end)
			const ctx = await cmd.promptContext(true)
			await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text, minutes: 60 })
		}
		await log('2026-10-13T10:00:00', 'Daily meeting and release planning')
		await log('2026-10-13T11:00:00', 'Testing QA RC and the dependabot ticket')
		await log('2026-10-13T12:00:00', 'PII data in logs')
		await log('2026-10-13T13:00:00', 'Tested CRM QA RC PAY-2930')

		const review = await cmd.review('2026-10-13')
		const rows = splitRows(review.entries, review.jobs, 60)
		expect(rows.map((x) => [x.minutes, x.description])).toEqual([
			[60, 'Daily meeting and release planning'],
			[60, 'Testing QA RC and the dependabot ticket'],
			[60, 'PII data in logs'],
			[60, 'Tested CRM QA RC PAY-2930'],
		])
		// And as one row, it is the whole day — which is the other thing you want.
		expect(splitRows(review.entries, review.jobs, 0)).toHaveLength(1)
	})
})

describe('Match Zoho against a punch it cannot read', () => {
	const pageWith = (firstIn: string | null, lastOut: string | null = null) => ({ firstIn, lastOut, totalHours: '', missing: [] })

	it('should keep the morning check-in when the time cannot be read', async () => {
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		const before = (await cmd.state()).day.checkedInAt

		at('2026-10-13T14:00:00')
		// The page says something, and it is not a time this version understands.
		await store.updatePageSource((p) => void (p.read = { at: parseIst('2026-10-13T14:00:00'), data: pageWith('In progress'), source: 'page' }))
		await expect(cmd.matchZoho()).rejects.toThrow(/could not read it as a time/i)
		expect((await cmd.state()).day.checkedInAt).toBe(before)
	})

	it('should still clear the day when Zoho genuinely shows no punch', async () => {
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-13T14:00:00')
		await store.updatePageSource((p) => void (p.read = { at: parseIst('2026-10-13T14:00:00'), data: pageWith('-'), source: 'page' }))
		const { day } = await cmd.matchZoho()
		expect(day.checkedInAt).toBeUndefined()
	})
})

describe('Match Zoho with nothing fresh to match against', () => {
	it('should refuse rather than overwrite today from an old read', async () => {
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		await store.updatePageSource((p) => void (p.read = { at: parseIst('2026-10-13T09:05:00'), data: { firstIn: '-', lastOut: null, totalHours: '', missing: [] }, source: 'page' }))
		at('2026-10-13T14:00:00') // hours later
		await expect(cmd.matchZoho()).rejects.toThrow(/too old/i)
		expect((await cmd.state()).day.checkedInAt).toBe(parseIst('2026-10-13T09:00:00'))
	})
})

describe('finishing the day from the log card', () => {
	it('should stop asking once the check-out is recorded', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ promptInterval: 60 })
		await cmd.confirmAttendance('in')

		at('2026-10-13T10:05:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('prompt')

		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'wrote the parser', minutes: 65 })
		await cmd.confirmAttendance('out')

		at('2026-10-13T11:10:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull()
		// And an hour later it is still quiet, rather than asking about time after
		// the day was closed.
		at('2026-10-13T12:10:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull()
	})

	it('should not also raise a notification when the card says the same thing', async () => {
		at('2026-10-13T09:30:00') // past the shift start and the grace: the card is raised
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('checkin')
		// One surface per thing. A sticky toast beside the card is the bug people
		// report as "two different reminders", each needing its own dismissal.
		expect(ui.notes).not.toContain('checkin')
	})

	it('should word the log reminder from your own interval', async () => {
		await cmd.saveSettings({ promptInterval: 30 })
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-13T09:31:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('prompt')
		// The card is the reminder; nothing says "the last hour" at 30 minutes.
		expect(ui.notes).not.toContain('prompt')
	})
})

describe('the standup, written from the day you had', () => {
	it('should group yesterday by ticket and list today and blocked', async () => {
		at('2026-10-12T09:00:00')
		await cmd.saveSettings({ promptInterval: 60, workDays: [1, 2, 3, 4, 5] })
		await cmd.confirmAttendance('in')

		const log = async (end: string, text: string) => {
			at(end)
			const ctx = await cmd.promptContext(true)
			await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text, minutes: 60 })
		}
		await log('2026-10-12T10:00:00', 'PAY-2433: wrote the parser')
		await log('2026-10-12T11:00:00', 'PAY-2433 reviewed the PR')

		const waiting = await cmd.createTask({ title: 'Staging credentials' })
		await cmd.updateTask(waiting.uid, { blocked: true })
		await cmd.createTask({ title: 'Finish the review comments', key: 'PAY-2433' })

		at('2026-10-13T09:30:00') // the next morning
		const out = await cmd.standup()
		expect(out.date).toBe('2026-10-12')
		expect(out.data.yesterday.map((l) => [l.label, l.minutes])).toEqual([['PAY-2433', 120]])
		expect(out.text).toContain('• PAY-2433 · 2h — wrote the parser; reviewed the PR')
		expect(out.text).toContain('*Today*')
		expect(out.text).toContain('PAY-2433 — Finish the review comments')
		expect(out.text).toContain('*Blocked*')
		expect(out.text).toContain('Staging credentials')
	})

	it('should talk about Friday on a Monday', async () => {
		await cmd.saveSettings({ workDays: [1, 2, 3, 4, 5] })
		at('2026-10-12T09:30:00') // Monday
		expect((await cmd.standup()).date).toBe('2026-10-09') // Friday
	})
})

describe('the morning briefing and the end of the day', () => {
	const log = async (end: string, text: string, minutes = 60) => {
		at(end)
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text, minutes })
	}

	it('should carry tomorrow’s first task into tomorrow’s briefing', async () => {
		at('2026-10-12T09:00:00')
		await cmd.saveSettings({ workDays: [1, 2, 3, 4, 5], promptInterval: 60 })
		await cmd.confirmAttendance('in')
		await log('2026-10-12T10:00:00', 'PAY-2433 wrote the parser')

		// Closing the day sets what to start with.
		at('2026-10-12T18:40:00')
		await cmd.planTomorrow(['Address the review comments', 'Verify on staging'])

		at('2026-10-13T09:15:00')
		const b = await cmd.briefing()
		expect(b.about).toBe('2026-10-12')
		expect(b.yesterday.map((l) => l.label)).toEqual(['PAY-2433'])
		expect(b.suggested[0]).toEqual({ title: 'Address the review comments', why: 'You lined this up as your first task yesterday evening' })
		expect(b.planned).toEqual(['Address the review comments', 'Verify on staging'])
	})

	it('should offer to send a timesheet that never reached Zoho', async () => {
		at('2026-10-12T09:00:00')
		await cmd.saveSettings({ workDays: [1, 2, 3, 4, 5] })
		await cmd.confirmAttendance('in')
		await log('2026-10-12T10:00:00', 'work that was never pushed')

		at('2026-10-13T09:15:00')
		const b = await cmd.briefing()
		expect(b.suggested.some((s) => s.title.includes('time logs to Zoho'))).toBe(true)
	})

	it('should say what the day went on, and what never got logged', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ promptInterval: 60 })
		await cmd.confirmAttendance('in')
		await log('2026-10-13T10:00:00', 'PAY-2433 shipped the parser')

		at('2026-10-13T12:00:00') // three hours on the clock, one logged
		const r = await cmd.dayReview()
		expect(r.worked.map((l) => l.label)).toEqual(['PAY-2433'])
		expect(r.minutes).toBe(60)
		expect(r.unlogged).toBe(120)
	})

	it('should keep the goal and its verdict with the day', async () => {
		at('2026-10-13T09:00:00')
		await cmd.savePlan('2026-10-13', { goal: 'Get the retry fix verified' })
		expect((await cmd.briefing()).goal).toBe('Get the retry fix verified')
		await cmd.savePlan('2026-10-13', { verdict: 'partly' })
		expect(await cmd.dayReview()).toMatchObject({ goal: 'Get the retry fix verified', verdict: 'partly' })
	})
})

describe('eyes, water and posture', () => {
	beforeEach(async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ eyeEvery: 20, waterTarget: 8, waterEvery: 45, posture: false })
		await cmd.confirmAttendance('in')
	})

	it('should ask for an eye break after the interval, with a countdown', async () => {
		at('2026-10-13T09:25:00')
		await engine.tick()
		const p = (await cmd.overlayState()).pending
		expect(p).toMatchObject({ kind: 'health', nudge: 'eyes', seconds: 20, blocking: false })
		// The wording moves on each time it speaks — the kind and the countdown
		// are what this test is about; the variety has a test of its own.
		expect(p?.title).toBeTruthy()
	})

	it('should not ask for the eyes again before the interval is up', async () => {
		await cmd.saveSettings({ waterTarget: 0, posture: false }) // eyes only, so the test is about the eyes
		at('2026-10-13T09:25:00')
		await engine.tick()
		await cmd.dismiss()
		at('2026-10-13T09:30:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull()
		// …and again once it is.
		at('2026-10-13T09:50:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toMatchObject({ nudge: 'eyes' })
	})

	it('should not ask for a break a minute after you answered something else', async () => {
		// Reported: "I logged a minute back, and it's showing the water break."
		// Logging is an interruption you have just answered; a glass of water on
		// top of it is the app talking over itself.
		await cmd.saveSettings({ eyeEvery: 0, promptInterval: 30, waterEvery: 20 })
		at('2026-10-13T10:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'PAY-2433: the parser', minutes: 55 })
		at('2026-10-13T10:01:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull()

		// Ten quiet minutes later it is welcome again.
		at('2026-10-13T10:20:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toMatchObject({ nudge: 'water' })
	})

	it('should not greet you with a break the moment you sit down', async () => {
		// Reported: "I open my system and it says take a break — that is not
		// logically true." Being away from the keyboard *is* the break.
		// A long interval, so the only thing that could speak here is a break.
		await cmd.saveSettings({ eyeEvery: 20, moveEvery: 60, waterTarget: 0, posture: true, promptInterval: 240 })
		at('2026-10-13T11:00:00')
		idle = 1800 // away for half an hour
		await engine.tick()

		at('2026-10-13T11:31:00')
		idle = 0 // back at the desk
		await engine.tick()
		// The morning's eye clock says four hours; the half hour away says
		// otherwise, and the half hour away is the truth.
		expect((await cmd.overlayState()).pending).toBeNull()

		// It starts counting from when you came back, not from this morning.
		at('2026-10-13T11:52:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toMatchObject({ nudge: 'eyes' })
	})

	it('should ask about water on its own schedule, not the eyes’', async () => {
		await cmd.saveSettings({ eyeEvery: 0 })
		at('2026-10-13T10:00:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toMatchObject({ nudge: 'water' })
	})

	it('should stay quiet during a focus session', async () => {
		at('2026-10-13T09:05:00')
		await cmd.startFocus(60)
		at('2026-10-13T09:40:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).not.toBe('health')
	})

	it('should count water for today only, and stop at the target', async () => {
		expect(await cmd.logWater(1)).toBe(1)
		expect(await cmd.logWater(1)).toBe(2)
		expect(await cmd.logWater(-1)).toBe(1)
		expect(await cmd.water()).toEqual({ had: 1, target: 8 })
		at('2026-10-14T09:00:00')
		expect(await cmd.water()).toEqual({ had: 0, target: 8 }) // a new day
	})

	it('should say nothing at all when none of it is switched on', async () => {
		await cmd.saveSettings({ eyeEvery: 0, waterTarget: 0, posture: false })
		at('2026-10-13T11:00:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).not.toBe('health')
	})
})

describe('asking for support', () => {
	const useFor = async (days: number, wins: number) =>
		store.updateRuntime((r) => {
			r.use = { days: Array.from({ length: days }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`), wins }
		})

	it('should not ask a stranger', async () => {
		at('2026-10-13T11:00:00')
		await useFor(2, 0)
		expect((await cmd.supportAsk()).show).toBe(false)
	})

	it('should ask once it has filled timesheets over a stretch of days', async () => {
		at('2026-10-13T11:00:00')
		await useFor(20, 9)
		const ask = await cmd.supportAsk()
		expect(ask.show).toBe(true)
		expect(ask.text).toContain('9 timesheets')
		expect(ask.text).toContain('20 days')
	})

	it('should never ask while something is owed on screen', async () => {
		at('2026-10-13T11:00:00')
		await useFor(20, 9)
		await cmd.logNow()
		expect((await cmd.supportAsk()).show).toBe(false)
	})

	it('should take no for an answer, permanently', async () => {
		at('2026-10-13T11:00:00')
		await useFor(20, 9)
		await cmd.answerSupport('never')
		expect((await cmd.supportAsk()).show).toBe(false)
		at('2027-10-13T11:00:00') // a year later
		expect((await cmd.supportAsk()).show).toBe(false)
	})

	it('should wait a season after being put off', async () => {
		at('2026-10-13T11:00:00')
		await useFor(20, 9)
		await cmd.answerSupport('later')
		expect((await cmd.supportAsk()).show).toBe(false)
		at('2026-11-13T11:00:00') // a month later: still too soon
		expect((await cmd.supportAsk()).show).toBe(false)
		at('2027-02-13T11:00:00')
		expect((await cmd.supportAsk()).show).toBe(true)
	})

	it('should count a day of use once, however many ticks it takes', async () => {
		at('2026-10-13T09:00:00')
		await engine.tick()
		await engine.tick()
		at('2026-10-13T17:00:00')
		await engine.tick()
		expect((await store.runtime()).use?.days).toEqual(['2026-10-13'])
	})
})

describe('planning more than one thing for tomorrow', () => {
	it('should keep the order, make the first the suggestion, and create the tasks', async () => {
		at('2026-10-12T18:40:00')
		await cmd.saveSettings({ workDays: [1, 2, 3, 4, 5] })
		await cmd.planTomorrow(['Address the review comments', 'Verify on staging', 'Reply to the client'])

		const titles = (await cmd.tasks()).tasks.map((t) => t.title)
		expect(titles).toEqual(expect.arrayContaining(['Address the review comments', 'Verify on staging', 'Reply to the client']))

		at('2026-10-13T09:15:00')
		const b = await cmd.briefing()
		expect(b.planned).toEqual(['Address the review comments', 'Verify on staging', 'Reply to the client'])
		expect(b.suggested[0].title).toBe('Address the review comments')
	})

	it('should not make a second copy of something already on the list', async () => {
		at('2026-10-12T18:40:00')
		const existing = await cmd.createTask({ title: 'Verify on staging' })
		await cmd.planTomorrow(['Verify on staging'])
		const same = (await cmd.tasks()).tasks.filter((t) => t.title === 'Verify on staging')
		expect(same).toHaveLength(1)
		expect(same[0].uid).toBe(existing.uid)
	})

	it('should ignore blanks and keep the list sane', async () => {
		at('2026-10-12T18:40:00')
		await cmd.planTomorrow(['  ', 'Real one', ''])
		expect((await cmd.plan('2026-10-13')).todos).toEqual(['Real one'])
	})
})

describe('knowing whether it works, on the first run', () => {
	it('should say plainly that it is not reading Zoho yet', async () => {
		at('2026-10-13T09:30:00')
		const r = await cmd.readiness()
		expect(r.ready).toBe(false)
		expect(r.summary).toBe('Not reading your Zoho yet.')
		expect(r.steps.find((s) => s.id === 'read')?.detail).toBe('Nothing read back yet')
	})

	it('should say what it found once the page has been read', async () => {
		at('2026-10-13T09:30:00')
		await store.updatePageSource((p) => void (p.read = { at: parseIst('2026-10-13T09:29:00'), data: { firstIn: '09:02', lastOut: null, totalHours: '', missing: [] }, source: 'page' }))
		const r = await cmd.readiness()
		// It now says what it read and where from, not just that it read something.
		expect(r.steps.find((s) => s.id === 'read')).toMatchObject({ ok: true, detail: 'In 09:02 — still in, from the page' })
	})

	it('should stop counting a read once it is old', async () => {
		at('2026-10-13T09:30:00')
		await store.updatePageSource((p) => void (p.read = { at: parseIst('2026-10-13T08:00:00'), data: { firstIn: '09:02', lastOut: null, totalHours: '', missing: [] }, source: 'page' }))
		expect((await cmd.readiness()).ready).toBe(false)
	})

	it('should treat the shift as confirmed once you have touched it', async () => {
		at('2026-10-13T09:30:00')
		expect((await cmd.readiness()).steps.find((s) => s.id === 'shift')?.ok).toBe(false)
		await cmd.saveSettings({ shiftStart: '10:00' })
		expect((await cmd.readiness()).steps.find((s) => s.id === 'shift')?.ok).toBe(true)
	})

	it('should open Zoho and read it from one button', async () => {
		at('2026-10-13T09:30:00')
		await cmd.checkZoho()
		expect(ui.opened.some((u) => u.includes('zoho'))).toBe(true)
	})
})

describe('reconstructing an hour from what was open', () => {
	it('should say nothing at all when history was never allowed', async () => {
		at('2026-10-13T11:00:00')
		expect(await cmd.slotActivity(parseIst('2026-10-13T10:00:00'), parseIst('2026-10-13T11:00:00'))).toEqual({ groups: [], draft: '', tickets: [] })
	})

	it('should group the hour by ticket, and offer a draft', async () => {
		await cmd.saveSettings({ ticketPrefixes: ['PAY'] })
		const from = parseIst('2026-10-13T10:00:00')
		ui.history = [
			{ url: 'https://jira/browse/PAY-2433', title: 'PAY-2433 financing', at: from },
			{ url: 'https://github.com/a/b/pull/812', title: 'Financing button · PAY-2433', at: from + 10 * 60_000 },
			{ url: 'https://docs.acme.com/csv', title: 'CSV import guide', at: from + 40 * 60_000 },
		]
		const out = await cmd.slotActivity(from, from + 60 * 60_000)
		expect(out.groups.map((g) => [g.label, g.minutes])).toEqual([
			['PAY-2433', 40],
			['docs.acme.com', 20],
		])
		expect(out.draft).toBe('PAY-2433; CSV import guide')
		expect(out.tickets).toEqual(['PAY-2433'])
	})

	it('should respect the prefixes, so another team’s key is just a site', async () => {
		await cmd.saveSettings({ ticketPrefixes: ['PAY'] })
		const from = parseIst('2026-10-13T10:00:00')
		ui.history = [{ url: 'https://jira/browse/ABC-9', title: 'ABC-9 someone else', at: from }]
		expect((await cmd.slotActivity(from, from + 60 * 60_000)).groups[0].label).toBe('jira')
	})
})

describe('ending the day', () => {
	it('should know whether the day is already closed, so the card can say so', async () => {
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		expect((await cmd.dayReview()).checkedOut).toBe(false)
		at('2026-10-13T18:00:00')
		await cmd.confirmAttendance('out')
		expect((await cmd.dayReview()).checkedOut).toBe(true)
	})

	it('should stop every card once the day is closed', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ promptInterval: 60 })
		await cmd.confirmAttendance('in')
		at('2026-10-13T18:40:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).not.toBeNull()

		await cmd.confirmAttendance('out')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'the last hour', minutes: 60 })
		await cmd.markDone('2026-10-13')

		at('2026-10-13T19:40:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull()
	})
})

describe('the backup covering everything the app stores', () => {
	it('should carry the goals, plans and issues that were missing from it', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveGoal('week', 'Ship the retry fix')
		await cmd.saveGoal('month', 'Reliability')
		await cmd.savePlan('2026-10-13', { goal: 'Verify on staging' })
		await cmd.planTomorrow(['Address the review comments'])

		const b = await cmd.backup()
		expect(b.goals).toHaveLength(2)
		// Today's plan and tomorrow's — tomorrow's exists before the day does.
		expect((b.plans as { date: string }[]).map((p) => p.date).sort()).toEqual(['2026-10-13', '2026-10-14'])
	})

	it('should restore them over an empty machine', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveGoal('week', 'Ship the retry fix')
		await cmd.savePlan('2026-10-14', { todos: ['Address the review comments'], firstTask: 'Address the review comments' })
		const saved = await cmd.backup()

		// A fresh machine: nothing in it.
		const fresh = new Store(memoryKV())
		const other = new Commands(new Engine({ store: fresh, zoho, now: () => clock, idleSecs: async () => idle, ui }), zoho as unknown as ZohoClient)
		await (other as unknown as { applyBackup(b: unknown): Promise<unknown> }).applyBackup(saved)

		expect((await other.goal('week', '2026-10-13')).goal?.text).toBe('Ship the retry fix')
		expect((await other.plan('2026-10-14')).todos).toEqual(['Address the review comments'])
	})
})

describe('a card that sent you somewhere should not follow you there', () => {
	it('should take the wrap-up down and stay down while you deal with it', async () => {
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-13T19:10:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('wrapup')

		// "Review & send the timesheet" opens the page and closes the card.
		await cmd.goAndDo('review')
		expect((await cmd.overlayState()).pending).toBeNull()

		// And it does not come straight back while you are doing it.
		at('2026-10-13T19:20:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull()
	})
})

describe('standing up', () => {
	it('should ask after a long sit, and never while heads-down', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ eyeEvery: 0, moveEvery: 50, waterTarget: 0, posture: false })
		await cmd.confirmAttendance('in')

		at('2026-10-13T09:40:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull()

		at('2026-10-13T10:00:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toMatchObject({ kind: 'health', nudge: 'move', seconds: 120 })
	})
})

describe('why the timesheet cannot be pushed', () => {
	// The shape Zoho's own timesheet save has: the table and the mode are what
	// identify it.
	const save = {
		at: 1,
		method: 'POST',
		url: 'https://people.zoho.in/logiciel/TimeSheetAction.zp',
		body: 'zp_tableName=P_Timesheet&zp_mode=addRecord&Date=01-01-2026&Hours=01%3A00&Job=1&Description=x&isDraft=true',
		pinned: false,
	}

	it('should say when the mode is the thing stopping it', async () => {
		await cmd.saveSettings({ zohoMode: 'reminder' })
		const r = await cmd.review('2026-10-13')
		expect(r.canPush).toBe(false)
		expect(r.pushBlocked).toBe('mode')
	})

	it('should say when it has never seen a timesheet save', async () => {
		await cmd.saveSettings({ zohoMode: 'timelogs' })
		const r = await cmd.review('2026-10-13')
		expect(r.canPush).toBe(false)
		expect(r.pushBlocked).toBe('nosave')
	})

	it('should keep the captured save even after a thousand ordinary reads', async () => {
		await cmd.saveSettings({ zohoMode: 'timelogs' })
		await cmd.addCurl(`curl '${save.url}' --data-raw '${save.body}'`)
		expect((await cmd.review('2026-10-13')).canPush).toBe(true)

		// The reads that happen all day, far more than the list ever holds.
		for (let i = 0; i < 200; i++) {
			await cmd.noteRequest({ at: i, method: 'GET', url: `https://people.zoho.in/read?i=${i}`, pinned: false })
		}
		// The one request the push depends on is still there.
		expect((await cmd.review('2026-10-13')).canPush).toBe(true)
	})

	it('should pin a recorded save on sight, not only a pasted one', async () => {
		await cmd.saveSettings({ zohoMode: 'timelogs' })
		await cmd.noteRequest(save)
		for (let i = 0; i < 200; i++) {
			await cmd.noteRequest({ at: i, method: 'GET', url: `https://people.zoho.in/read?i=${i}`, pinned: false })
		}
		expect((await cmd.review('2026-10-13')).canPush).toBe(true)
	})
})

describe('Match Zoho saying what it read', () => {
	it('should hand back the times and where they came from', async () => {
		at('2026-10-13T20:00:00')
		await cmd.reportPageRead({ firstIn: '09:02', lastOut: '19:14', totalHours: '10:12', missing: [] }, 'endpoint')
		const r = await cmd.matchZoho()
		expect(r.read).toMatchObject({ firstIn: '09:02', lastOut: '19:14', source: 'endpoint' })
		expect(r.day.checkedInAt).toBe(parseIst('2026-10-13T09:02:00'))
		expect(r.day.checkedOutAt).toBe(parseIst('2026-10-13T19:14:00'))
	})

	it('should name what it could not find on the page', async () => {
		at('2026-10-13T20:00:00')
		await cmd.reportPageRead({ firstIn: null, lastOut: null, totalHours: null, missing: ['First In', 'Last Out'] }, 'page')
		const r = await cmd.matchZoho()
		expect(r.read.missing).toEqual(['First In', 'Last Out'])
		expect(r.read.firstIn).toBeNull()
	})
})

describe('every surface agreeing about the day', () => {
	it('should tell every page at once when the day is closed', async () => {
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-13T19:10:00')

		// The three things the open surfaces read.
		expect((await cmd.state()).day.checkedOutAt).toBeUndefined()
		expect((await cmd.dayReview()).checkedOut).toBe(false)
		expect((await cmd.readiness()).steps.length).toBeGreaterThan(0)

		const before = ui.changes
		await cmd.confirmAttendance('out')

		// One broadcast, and every surface now says the same thing.
		expect(ui.changes).toBeGreaterThan(before)
		expect((await cmd.state()).day.checkedOutAt).toBe(parseIst('2026-10-13T19:10:00'))
		expect((await cmd.dayReview()).checkedOut).toBe(true)
	})
})

describe('a Zoho read must not undo your check-out', () => {
	const read = (firstIn: string | null, lastOut: string | null, missing: string[] = []) => ({ firstIn, lastOut, totalHours: null, missing })

	it('should keep a check-out the reader simply could not see', async () => {
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-13T18:00:00')
		await cmd.confirmAttendance('out')

		// The background read five minutes later: Zoho's widget has not caught up,
		// so there is no Last Out on the page at all. This used to wipe it, which
		// restarted the whole day — the widget asked to check out again and the
		// hourly card came back.
		at('2026-10-13T18:05:00')
		await cmd.reportPageRead(read('09:00', null, ['Last Out']), 'endpoint')
		expect((await cmd.state()).day.checkedOutAt).toBe(parseIst('2026-10-13T18:00:00'))
	})

	it('should keep a check-out that happened after the read was taken', async () => {
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		// A read from this morning, which cannot know about this evening.
		await store.updatePageSource((p) => void (p.read = { at: parseIst('2026-10-13T09:05:00'), data: read('09:00', '-'), source: 'endpoint' }))
		at('2026-10-13T18:00:00')
		await cmd.confirmAttendance('out')

		at('2026-10-13T18:01:00')
		await cmd.reportPageRead(read('09:00', '-'), 'endpoint')
		// The fresh read genuinely says no punch-out, so this one is allowed to
		// undo it — the evidence is newer than the record.
		expect((await cmd.state()).day.checkedOutAt).toBeUndefined()
	})

	it('should refuse to empty a day that has work logged against it', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ promptInterval: 60 })
		await cmd.confirmAttendance('in')
		at('2026-10-13T15:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'six hours of real work', minutes: 360 })

		// Zoho is showing another day, so it reports no punch at all.
		await store.updatePageSource((p) => void (p.read = { at: parseIst('2026-10-13T15:00:00'), data: read('-', '-'), source: 'page' }))
		await expect(cmd.matchZoho()).rejects.toThrow(/time logged here/i)
		expect((await cmd.state()).day.checkedInAt).toBe(parseIst('2026-10-13T09:00:00'))
	})

	it('should still take a real punch-out from Zoho', async () => {
		at('2026-10-13T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-13T19:30:00')
		await cmd.reportPageRead(read('09:02', '19:14'), 'endpoint')
		expect((await cmd.state()).day.checkedOutAt).toBe(parseIst('2026-10-13T19:14:00'))
	})
})

describe('going quiet once the day’s hours are in', () => {
	it('should stop the hourly card after the target is logged, and not start again', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ promptInterval: 60, minHours: 5 })
		await cmd.confirmAttendance('in')

		at('2026-10-13T14:10:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('prompt')

		// Five hours written down: the day's question has been answered.
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'five hours of work', minutes: 300 })
		expect((await cmd.overlayState()).pending).toBeNull()

		for (const t of ['2026-10-13T15:20:00', '2026-10-13T16:30:00', '2026-10-13T17:40:00']) {
			at(t)
			await engine.tick()
			expect((await cmd.overlayState()).pending?.kind, t).not.toBe('prompt')
		}
	})

	it('should still let you log more when you ask', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ promptInterval: 60, minHours: 5 })
		await cmd.confirmAttendance('in')
		at('2026-10-13T14:10:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'five hours of work', minutes: 300 })

		at('2026-10-13T18:00:00')
		await cmd.logNow()
		expect((await cmd.overlayState()).pending?.kind).toBe('prompt')
	})
})

describe('the credit line under a reminder', () => {
	it('should stop everywhere once you say no, and stay stopped', async () => {
		expect((await cmd.supportAsk()).never).toBe(false)
		await cmd.answerSupport('never')
		expect((await cmd.supportAsk()).never).toBe(true)
		at('2027-10-13T11:00:00') // a year on
		expect((await cmd.supportAsk())).toMatchObject({ never: true, show: false })
	})
})

describe('closing the day when Zoho was filled by hand', () => {
	it('should put the wrap-up card down for good', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ promptInterval: 60, minHours: 5 })
		await cmd.confirmAttendance('in')
		at('2026-10-13T15:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'six hours of work', minutes: 360 })
		at('2026-10-13T19:10:00')
		await cmd.confirmAttendance('out')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('wrapup')

		// Filled in Zoho by hand: WorkPulse cannot see that, so you tell it.
		await cmd.markDone('2026-10-13')
		expect((await cmd.overlayState()).pending).toBeNull()

		// And it does not come back for the rest of the evening.
		for (const t of ['2026-10-13T19:40:00', '2026-10-13T21:00:00', '2026-10-13T23:30:00']) {
			at(t)
			await engine.tick()
			expect((await cmd.overlayState()).pending, t).toBeNull()
		}
	})
})

describe('setting Zoho up area by area', () => {
	const req = (url: string, body: string) => ({ at: 1, method: 'POST', url, body, contentType: 'application/x-www-form-urlencoded; charset=UTF-8', pinned: false })

	it('should know which of the four areas it has seen', async () => {
		expect(await cmd.wiring()).toMatchObject({ attendance: false, tasks: false, save: false })

		// Attendance Summary: the call behind the check-in times.
		await cmd.noteRequest(req('https://people.zoho.in/logiciel/AttendanceAction.zp', 'mode=getStatus&conreqcsr=t'))
		expect((await cmd.wiring()).attendance).toBe(true)

		// Time Tracker: the job list the hourly card offers.
		await cmd.noteRequest(req('https://people.zoho.in/logiciel/timesheet.zp', 'mode=getJobs&projectId=0&conreqcsr=t'))
		expect((await cmd.wiring()).tasks).toBe(true)

		// And the one it will ever replay: Zoho's own save.
		expect((await cmd.wiring()).save).toBe(false)
		await cmd.noteRequest(req('https://people.zoho.in/logiciel/addUpdateRecord.zp', 'zp_tableName=P_Timesheet&zp_mode=addRecord&Date=01-01-2026&loggedHrs=01%3A00'))
		expect((await cmd.wiring()).save).toBe(true)
	})

	it('should not mistake a read for the save it replays', async () => {
		await cmd.noteRequest(req('https://people.zoho.in/logiciel/AttendanceAction.zp', 'mode=getStatus'))
		await cmd.noteRequest(req('https://people.zoho.in/logiciel/timesheet.zp', 'mode=getJobs&projectId=0'))
		expect((await cmd.wiring()).save).toBe(false)
	})
})

describe('an evening after the shift has ended', () => {
	it('should ask once at the end and then leave you alone', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ promptInterval: 60, minHours: 9, shiftEnd: '18:30' })
		await cmd.confirmAttendance('in')

		// The final partial slot, once.
		at('2026-10-13T18:35:00')
		await engine.tick()
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'the last stretch', minutes: 570 })
		await cmd.dismiss().catch(() => undefined)

		// …and then nothing hourly for the rest of the evening, whatever is left
		// unlogged — the wrap-up card is the evening's one reminder.
		for (const t of ['2026-10-13T19:40:00', '2026-10-13T20:50:00', '2026-10-13T22:00:00']) {
			at(t)
			await engine.tick()
			expect((await cmd.overlayState()).pending?.kind, t).not.toBe('prompt')
		}
	})
})

describe('the last few months, from Zoho', () => {
	const report = (date: string, firstIn: string, lastOut: string, totalHours: string) => ({ date, status: 'Present', firstIn, lastOut, totalHours })

	it('should keep the punches and the hours the report already carried', async () => {
		at('2026-10-13T10:00:00')
		await engine.keepReport(
			[report('2026-10-09', '09:05', '18:40', '08:30'), report('2026-10-12', '09:15', '19:00', '09:00')],
			'2026-10-13',
		)
		const nine = await store.day('2026-10-09')
		expect(nine.checkedInAt).toBe(parseIst('2026-10-09T09:05:00'))
		expect(nine.checkedOutAt).toBe(parseIst('2026-10-09T18:40:00'))
		expect(nine.zohoMinutes).toBe(510)

		// And the heatmap now has something to draw for a day it never saw.
		const [day] = await store.summaries(['2026-10-09'])
		expect(day).toMatchObject({ minutes: 510, fromZoho: true })
	})

	it('should never overwrite what you recorded yourself', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in') // you were there; Zoho's report is a copy
		at('2026-10-13T10:00:00')
		await engine.keepReport([report('2026-10-12', '11:30', '19:00', '07:30')], '2026-10-13')
		expect((await store.day('2026-10-12')).checkedInAt).toBe(parseIst('2026-10-12T09:00:00'))
		expect((await store.day('2026-10-12')).zohoMinutes).toBe(450)
	})

	it('should leave today alone, which the live sync owns', async () => {
		at('2026-10-13T10:00:00')
		await engine.keepReport([report('2026-10-13', '09:00', '-', '01:00')], '2026-10-13')
		expect((await store.day('2026-10-13')).zohoMinutes).toBeUndefined()
	})

	it('should prefer what you logged over what Zoho counted', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T12:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'three hours', minutes: 180 })
		at('2026-10-13T10:00:00')
		await engine.keepReport([report('2026-10-12', '09:00', '18:00', '09:00')], '2026-10-13')
		const [day] = await store.summaries(['2026-10-12'])
		expect(day).toMatchObject({ minutes: 180, fromZoho: false })
	})
})

describe('break cards that do not become wallpaper', () => {
	it('should word it differently each time it asks', async () => {
		at('2026-10-13T09:00:00')
		await cmd.saveSettings({ eyeEvery: 20, moveEvery: 0, waterTarget: 0, posture: false })
		await cmd.confirmAttendance('in')

		const titles: string[] = []
		for (const t of ['2026-10-13T09:25:00', '2026-10-13T09:50:00', '2026-10-13T10:15:00']) {
			at(t)
			await engine.tick()
			titles.push((await cmd.overlayState()).pending?.title ?? '')
			await cmd.dismiss()
		}
		expect(new Set(titles).size).toBe(3)
	})
})

describe('what you planned at check-out, the next morning', () => {
	it('should be there to find, even on a morning with nothing else in it', async () => {
		at('2026-10-13T19:00:00')
		await cmd.saveSettings({ workDays: [1, 2, 3, 4, 5] })
		await cmd.planTomorrow(['Address the review comments', 'Verify on staging'])

		at('2026-10-14T09:15:00')
		const b = await cmd.briefing()
		// Nothing logged yesterday, nothing carried: the plan is the only thing on
		// it, and it is exactly what the morning was for.
		expect(b.yesterday).toEqual([])
		expect(b.planned).toEqual(['Address the review comments', 'Verify on staging'])
		expect(b.suggested[0].title).toBe('Address the review comments')

		// And both are real tasks, so they are on the Tasks page too.
		const open = (await cmd.tasks()).tasks.filter((t) => t.status !== 'done').map((t) => t.title)
		expect(open).toEqual(expect.arrayContaining(['Address the review comments', 'Verify on staging']))
	})
})

describe('notes written at a break', () => {
	it('should come back once at the next break, then stop', async () => {
		at('2026-10-14T09:00:00')
		await cmd.saveSettings({ eyeEvery: 20, moveEvery: 0, waterTarget: 0, posture: false })
		await cmd.confirmAttendance('in')
		await cmd.saveHealthNote('Raise the screen a notch', { kind: 'eyes', showNext: true })

		at('2026-10-14T09:25:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.note).toBe('Raise the screen a notch')
		await cmd.dismiss()

		at('2026-10-14T09:50:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.note).toBeUndefined()
	})

	it('should keep the ones you only wanted kept', async () => {
		at('2026-10-14T09:00:00')
		await cmd.saveSettings({ eyeEvery: 20, moveEvery: 0, waterTarget: 0, posture: false })
		await cmd.confirmAttendance('in')
		await cmd.saveHealthNote('Eyes were tired all afternoon', { kind: 'eyes' })

		at('2026-10-14T09:25:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.note).toBeUndefined()
		expect((await cmd.healthNotes()).map((n) => n.text)).toEqual(['Eyes were tired all afternoon'])
	})

	it('should refuse an empty one and let you delete any of them', async () => {
		await expect(cmd.saveHealthNote('   ')).rejects.toThrow(/nothing/i)
		await cmd.saveHealthNote('Chair is too low')
		const [note] = await cmd.healthNotes()
		await cmd.deleteHealthNote(note.id)
		expect(await cmd.healthNotes()).toEqual([])
	})
})

describe('two tickets that turned out to be one', () => {
	const make = async (name: string, urls: string[]) => cmd.saveWorkspace({ name, tabs: urls.map((u) => ({ title: u, url: u })) })

	it('should fold one into the other, keeping the survivor’s name', async () => {
		at('2026-10-14T09:00:00')
		const monday = await make('PAY-2433', ['https://pr/1'])
		const thursday = await make('PAY-2433 financing', ['https://pr/1', 'https://stage/x'])
		await cmd.saveNote(thursday.id, { text: 'waiting on the flag' })
		await cmd.editLink(monday.id, 'https://pr/1', { note: 'merged on dev' })

		const out = await cmd.mergeTickets(thursday.id, monday.id)
		expect(out).toMatchObject({ name: 'PAY-2433', links: 1, notes: 1, duplicates: 1 })

		const list = await cmd.ticketList()
		expect(list).toHaveLength(1)
		const whole = await cmd.ticket(monday.id)
		expect(whole!.tabs.map((t) => t.url)).toEqual(['https://pr/1', 'https://stage/x'])
		expect(whole!.tabs[0].note).toBe('merged on dev') // the label survived
		expect(whole!.notes).toHaveLength(1)
	})

	it('should bring the learnings filed against the half that goes', async () => {
		const a = await make('PAY-1', ['https://a'])
		const b = await make('PAY-1 again', ['https://b'])
		const note = await cmd.saveLearning({ text: 'The retry is idempotent', ticketId: b.id })
		await cmd.mergeTickets(b.id, a.id)
		expect((await cmd.learnFor(a.id)).map((l) => l.id)).toEqual([note.id])
	})

	it('should refuse to merge a ticket into itself, or into one that is gone', async () => {
		const a = await make('PAY-1', ['https://a'])
		await expect(cmd.mergeTickets(a.id, a.id)).rejects.toThrow(/same ticket/i)
		await expect(cmd.mergeTickets(a.id, 'nope')).rejects.toThrow(/gone/i)
	})

	it('should move a link filed under the wrong one', async () => {
		const a = await make('PAY-1', ['https://a', 'https://wrong'])
		const b = await make('PAY-2', ['https://b'])
		await cmd.moveLink(a.id, b.id, 'https://wrong')
		expect((await cmd.ticket(a.id))!.tabs.map((t) => t.url)).toEqual(['https://a'])
		expect((await cmd.ticket(b.id))!.tabs.map((t) => t.url)).toEqual(['https://b', 'https://wrong'])
	})

	it('should archive a finished ticket without losing it', async () => {
		const a = await make('PAY-1', ['https://a'])
		await cmd.saveNote(a.id, { text: 'how it was fixed' })
		await cmd.archiveTicket(a.id)
		expect(await cmd.ticketList()).toEqual([])
		expect((await cmd.ticketList(true)).map((w) => w.archived)).toEqual([true])
		expect((await cmd.ticket(a.id))!.notes).toHaveLength(1)

		await cmd.archiveTicket(a.id, false)
		expect(await cmd.ticketList()).toHaveLength(1)
	})

	it('should start a new ticket from an old one’s links, leaving its notes behind', async () => {
		const checklist = await make('Release checklist · October', ['https://runbook', 'https://dashboard'])
		await cmd.saveNote(checklist.id, { text: 'October went fine' })
		const next = await cmd.duplicateTicket(checklist.id, 'Release checklist · November')
		expect(next.tabs.map((t) => t.url)).toEqual(['https://runbook', 'https://dashboard'])
		expect(next.notes ?? []).toEqual([])
	})
})

describe('a team, and what never leaves this machine', () => {
	/** Catches every write, so the test can read exactly what was published. */
	const capture = () => {
		const commits: { path: string; content: string }[][] = []
		const fetchFn = async (url: string, init?: RequestInit) => {
			const u = String(url)
			const body = init?.body ? JSON.parse(String(init.body)) : null
			if (u.endsWith('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: 'head' } }), { status: 200 })
			if (u.includes('/git/commits/head')) return new Response(JSON.stringify({ tree: { sha: 'tree' } }), { status: 200 })
			if (u.endsWith('/git/trees')) {
				commits.push(body.tree.map((t: { path: string; content: string }) => ({ path: t.path, content: t.content })))
				return new Response(JSON.stringify({ sha: 'new-tree' }), { status: 200 })
			}
			if (u.endsWith('/git/commits')) return new Response(JSON.stringify({ sha: 'new-commit' }), { status: 200 })
			if (u.includes('/git/refs/heads/main')) return new Response('{}', { status: 200 })
			if (u.includes('/issues')) return new Response(JSON.stringify({ number: 3, html_url: 'https://github.com/acme/team/issues/3' }), { status: 200 })
			if (u.endsWith('/user')) return new Response(JSON.stringify({ login: 'shantanu' }), { status: 200 })
			return new Response(JSON.stringify({ full_name: 'acme/team', private: true, permissions: { push: true }, default_branch: 'main' }), { status: 200 })
		}
		vi.stubGlobal('fetch', fetchFn as unknown as typeof fetch)
		return commits
	}

	const aDayOfWork = async () => {
		at('2026-10-12T09:00:00')
		await cmd.saveSettings({ promptInterval: 60, workDays: [1, 2, 3, 4, 5] })
		await cmd.confirmAttendance('in')
		at('2026-10-12T10:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'PAY-2433: wrote the parser', minutes: 60 })
		await cmd.saveLearning({ text: 'Resolve the division before the settings lookup #gotcha', kind: 'mistake' })
		await cmd.saveSettings({ teamRepo: 'acme/team', teamBranch: 'main', teamMember: 'shantanu' })
		await cmd.saveSyncToken('github_pat_secret')
	}

	afterEach(() => vi.unstubAllGlobals())

	it('should refuse to share when nothing has been turned on', async () => {
		await aDayOfWork()
		capture()
		await expect(cmd.pushTeam()).rejects.toThrow(/Nothing is shared yet/i)
	})

	it('should publish the hours alone when only hours are shared', async () => {
		await aDayOfWork()
		await cmd.saveSettings({ shareHours: true })
		const commits = capture()
		await cmd.pushTeam()

		const file = JSON.parse(commits[0][0].content)
		expect(commits[0][0].path).toBe('team/members/shantanu.json')
		expect(file.days[0]).toEqual({ date: '2026-10-12', minutes: 60, in: '09:00', out: undefined })
	})

	it('should publish what was worked on as the ticket, never the sentence', async () => {
		await aDayOfWork()
		await cmd.saveSettings({ shareWhat: true })
		const commits = capture()
		await cmd.pushTeam()

		const file = JSON.parse(commits[0][0].content)
		expect(file.days[0].lines).toEqual([{ label: 'PAY-2433', minutes: 60 }])
		expect(commits[0][0].content).not.toContain('wrote the parser')
	})

	it('should never carry the token, the Zoho details or anything not asked for', async () => {
		await aDayOfWork()
		await cmd.saveSettings({ shareHours: true, shareWhat: true, shareLearnings: true })
		const commits = capture()
		await cmd.pushTeam()

		const written = commits.flat().map((f) => f.content).join('\n')
		expect(written).not.toContain('github_pat_secret')
		expect(written).not.toContain('zoho')
		expect(written).not.toContain('attendanceUrl')
		// What was asked for is there.
		expect(written).toContain('PAY-2433')
		expect(written).toContain('#gotcha')
	})

	it('should leave the team without leaving anything shared on', async () => {
		await aDayOfWork()
		await cmd.saveSettings({ shareHours: true, pageNotes: true })
		await cmd.leaveTeam()
		const s = await cmd.teamState()
		expect(s).toMatchObject({ repo: '', shareHours: false, pageNotes: false })
	})
})

describe('a note left on a page', () => {
	it('should hold the screenshot until the composer asks for it, then forget it', async () => {
		at('2026-10-13T11:00:00')
		await cmd.draftPageNote({ url: 'https://stage.acme.com/orders/12#row', title: 'Orders', shot: 'data:image/png;base64,iVBOR' })
		expect(await cmd.pageNoteDraft()).toMatchObject({ url: 'https://stage.acme.com/orders/12#row', shot: 'data:image/png;base64,iVBOR' })
		await cmd.clearPageNoteDraft()
		expect(await cmd.pageNoteDraft()).toBeNull()
	})

	it('should know nothing about pages when there is no team', async () => {
		expect(await cmd.noteCount('https://stage.acme.com/orders/12')).toEqual({ open: 0, closed: 0 })
		expect(await cmd.notesOnPage('https://stage.acme.com/orders/12')).toMatchObject({ open: 0, closed: 0, notes: [] })
	})
})

describe('a day Zoho says is not a working day', () => {
	const report = (date: string, status: string) => ({ date, status, firstIn: '', lastOut: '', totalHours: '' })

	it('should go quiet on approved leave rather than asking you to check in', async () => {
		at('2026-10-13T09:30:00')
		await engine.keepReport([report('2026-10-13', 'Paid Leave')], '2026-10-13')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull()
		expect((await store.day('2026-10-13')).offKind).toBe('leave')
	})

	it('should go quiet on a holiday', async () => {
		at('2026-10-13T09:30:00')
		await engine.keepReport([report('2026-10-13', 'Restricted Holiday')], '2026-10-13')
		await engine.tick()
		expect((await cmd.overlayState()).pending).toBeNull()
	})

	it('should not raise a regularisation issue against leave Zoho itself approved', async () => {
		// The old rule said "marked absent with no leave or holiday" — about a
		// leave that was in the very report it was reading.
		at('2026-10-14T09:30:00')
		zoho.report = [report('2026-10-13', 'Paid Leave'), report('2026-10-12', 'Week Off')]
		await engine.scan()
		expect((await store.issues()).map((i) => i.date)).not.toContain('2026-10-13')
	})

	it('should still flag an absence nobody approved', async () => {
		at('2026-10-14T09:30:00')
		zoho.report = [{ date: '2026-10-13', status: 'Absent', firstIn: '', lastOut: '', totalHours: '' }]
		await engine.scan()
		expect((await store.issues()).map((i) => i.kind)).toContain('absent')
	})

	it('should ask for half the hours on a half day', async () => {
		at('2026-10-13T09:00:00')
		await engine.keepReport([report('2026-10-13', 'Half Day')], '2026-10-13')
		await cmd.confirmAttendance('in')
		const day = await store.day('2026-10-13')
		expect(day.offKind).toBe('half')
		expect(day.isOff).toBe(false) // you were there for half of it

		// Four hours in, the day's hours are done rather than four short.
		at('2026-10-13T13:05:00')
		await engine.tick()
		expect(ui.notes).toContain('hoursdone')
	})

	it('should let you say it is a working day after all, and stay said', async () => {
		at('2026-10-13T09:30:00')
		await engine.keepReport([report('2026-10-13', 'Holiday')], '2026-10-13')
		expect((await store.day('2026-10-13')).isOff).toBe(true)

		await cmd.workingToday()
		expect((await store.day('2026-10-13')).isOff).toBe(false)
		// A later sync of the same report must not quietly mark it off again.
		await engine.keepReport([report('2026-10-13', 'Holiday')], '2026-10-13')
		expect((await store.day('2026-10-13')).isOff).toBe(false)
	})
})

describe('the six months you cannot remember', () => {
	const logDay = async (date: string, text: string, minutes = 60) => {
		at(`${date}T09:00:00`)
		await cmd.confirmAttendance('in')
		at(`${date}T10:00:00`)
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text, minutes })
	}

	it('should answer "what have you been working on" from what you typed', async () => {
		await logDay('2026-10-12', 'PAY-2433: wrote the parser')
		await logDay('2026-10-13', 'PAY-2433: the division lookup was wrong')
		await logDay('2026-10-14', 'LEAP-12: the migration')
		await cmd.saveWorkspace({ name: 'PAY-2433 financing button', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/1' }] })

		at('2026-10-15T09:00:00')
		const { report, text } = await cmd.period('month')
		expect(report.lines[0]).toMatchObject({ label: 'PAY-2433', minutes: 120, days: 2, name: 'PAY-2433 financing button' })
		expect(text).toContain('wrote the parser')
		expect(text).toContain('What it was mostly about')
	})

	it('should count only the days inside the period', async () => {
		await logDay('2026-10-12', 'PAY-2433: inside')
		at('2026-10-15T09:00:00')
		const { report } = await cmd.period('week', '2026-10-14', '2026-10-15')
		expect(report.lines).toEqual([])
	})
})

describe('how long things really take you', () => {
	it('should compare the estimate you gave with the hours that followed', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		const w = await cmd.saveWorkspace({ name: 'PAY-2433 financing', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/2' }] })
		await cmd.setEstimate(w.id, 120)

		at('2026-10-12T13:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'PAY-2433: longer than I thought', minutes: 240 })

		const { c, rows } = await cmd.calibration()
		expect(rows[0]).toMatchObject({ label: 'PAY-2433 financing', estimateMinutes: 120, actualMinutes: 240 })
		expect(c.count).toBe(1)
		expect(c.ready).toBe(false) // one ticket is an anecdote
	})

	it('should say nothing at all when no ticket has an estimate', async () => {
		const { c, line } = await cmd.calibration()
		expect(c.count).toBe(0)
		expect(line).toContain('5 more estimated tickets')
	})
})

describe('the hours you actually worked', () => {
	it('should count the clock over what was written down', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T19:30:00')
		await cmd.confirmAttendance('out')

		at('2026-10-12T19:31:00')
		const { o, line } = await cmd.hours('week')
		expect(o.minutes).toBe(630) // 10h30 on the clock, nothing logged
		expect(o.over).toBe(150)
		expect(line).toContain('2h 30m more than the 8h')
	})

	it('should expect nothing of a day Zoho called a holiday', async () => {
		await engine.keepReport([{ date: '2026-10-12', status: 'Holiday', firstIn: '', lastOut: '', totalHours: '' }], '2026-10-12')
		at('2026-10-12T11:00:00')
		await cmd.workingToday('2026-10-12') // came in anyway
		await cmd.confirmAttendance('in')
		at('2026-10-12T15:00:00')
		await cmd.confirmAttendance('out')

		const { o } = await cmd.hours('week')
		expect(o.expected).toBe(0)
		expect(o.offDaysWorked).toEqual([{ date: '2026-10-12', minutes: 240 }])
	})
})

describe('cover for me', () => {
	it('should hand over the links, the notes and the gotchas', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		const w = await cmd.saveWorkspace({ name: 'PAY-2433 financing', tabs: [{ title: 'PR #812', url: 'https://github.com/acme/api/pull/812' }] })
		await cmd.editLink(w.id, 'https://github.com/acme/api/pull/812', { note: 'the PR, waiting on review' })
		await cmd.saveNote(w.id, { date: '2026-10-12', text: 'Behind the flag on stage, not switched on' })
		await cmd.saveLearning({ text: 'PAY-2433 the division must resolve first', kind: 'mistake', ticketId: w.id })
		await cmd.capture({ text: 'PAY-2433 verify on staging' })

		at('2026-10-12T10:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'PAY-2433: wrote the parser', minutes: 60 })

		const { text } = await cmd.handover()
		expect(text).toContain('PAY-2433 financing')
		expect(text).toContain('[the PR, waiting on review](https://github.com/acme/api/pull/812)')
		expect(text).toContain('the division must resolve first')
		expect(text).toContain('Behind the flag on stage')
		expect(text).toContain('verify on staging')
	})

	it('should say so when there is nothing to hand over', async () => {
		const { text } = await cmd.handover()
		expect(text).toContain('Nothing open. Enjoy it.')
	})
})

describe('where did I write that down', () => {
	it('should look in the entries, the notes, the learnings and the links at once', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		const w = await cmd.saveWorkspace({ name: 'PAY-2433 financing', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/812' }] })
		await cmd.editLink(w.id, 'https://github.com/acme/api/pull/812', { note: 'the division fix' })
		await cmd.saveNote(w.id, { date: '2026-10-12', text: 'Division has to resolve before the settings lookup' })
		await cmd.saveLearning({ text: 'Null pointer came from a missing division', kind: 'mistake' })
		at('2026-10-12T10:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'PAY-2433: the division lookup threw', minutes: 60 })

		const { hits, kinds } = await cmd.findAll('division')
		expect(new Set(hits.map((h) => h.kind))).toEqual(new Set(['entry', 'note', 'learning', 'link']))
		expect(kinds.length).toBeGreaterThan(1)
	})

	it('should not answer a single letter', async () => {
		expect((await cmd.findAll('a')).hits).toEqual([])
	})
})

describe('the day you forgot to close', () => {
	it('should ring hours after the shift, while it is still one click', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T19:30:00')
		await engine.tick()
		await cmd.snooze() // the ordinary wrap-up, pushed away

		at('2026-10-12T22:10:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('wrapup')
		// It rings, because the whole problem is that you stopped looking.
		expect(ui.ringing).toBe(true)
		expect(ui.notes).toContain('wrapup')
	})

	it('should say it once, not every minute until midnight', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T22:10:00')
		await engine.tick()
		await cmd.dismiss().catch(() => undefined)
		const rings = ui.rings
		at('2026-10-12T22:40:00')
		await engine.tick()
		expect(ui.rings).toBe(rings)
	})

	it('should catch it the next morning when nothing was running to ring', async () => {
		at('2026-10-12T09:05:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T17:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'PAY-2433: the parser', minutes: 60 })
		// The lid goes down. Nothing runs until the morning.
		at('2026-10-13T09:30:00')
		await engine.tick()

		const p = (await cmd.overlayState()).pending
		expect(p).toMatchObject({ kind: 'closeout', date: '2026-10-12', blocking: true })
		// And it arrives with the time already worked out, not a question.
		expect(p?.leftAt).toBe(parseIst('2026-10-12T17:00:00'))
		expect(p?.leftWhy).toContain('last entry')
	})

	it('should close it at the time you choose and write the sentence Zoho wants', async () => {
		at('2026-10-12T09:05:00')
		await cmd.confirmAttendance('in')
		at('2026-10-13T09:30:00')
		await engine.tick()

		const { note } = await cmd.closeOpenDay('2026-10-12', parseIst('2026-10-12T19:42:00'))
		expect((await store.day('2026-10-12')).checkedOutAt).toBe(parseIst('2026-10-12T19:42:00'))
		expect(note).toContain('Worked until about 19:42')
		expect((await cmd.overlayState()).pending).toBeNull()
	})

	it('should never close a day before it started, or after the day ended', async () => {
		at('2026-10-12T09:05:00')
		await cmd.confirmAttendance('in')
		await cmd.closeOpenDay('2026-10-12', parseIst('2026-10-12T03:00:00'))
		expect((await store.day('2026-10-12')).checkedOutAt).toBeGreaterThan(parseIst('2026-10-12T09:05:00'))
	})

	it('should take "I did check out" as the end of it', async () => {
		at('2026-10-12T09:05:00')
		await cmd.confirmAttendance('in')
		at('2026-10-13T09:30:00')
		await engine.tick()
		await cmd.closeOpenDay('2026-10-12', parseIst('2026-10-12T19:00:00'), 'already')
		expect((await cmd.openDays())).not.toContain('2026-10-12')
	})

	it('should not ask about a day off, or a day that was closed properly', async () => {
		at('2026-10-12T09:05:00')
		await cmd.confirmAttendance('in')
		at('2026-10-12T18:00:00')
		await cmd.confirmAttendance('out')
		at('2026-10-13T09:30:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).not.toBe('closeout')
	})
})

describe('a block with one thing in it', () => {
	it('should hold its intent, and keep everything else quiet', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.saveSettings({ promptInterval: 30, eyeEvery: 20 })
		await cmd.startFocus(50, undefined, 'the retry bug')

		at('2026-10-12T09:45:00')
		await engine.tick()
		// Forty-five minutes in: neither the hourly card nor a break speaks.
		expect((await cmd.overlayState()).pending).toBeNull()
		const f = await cmd.focusNow()
		expect(f?.session.intent).toBe('the retry bug')
		expect(f?.left).toBe(5)
	})

	it('should ask what came of it when the block ends', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.startFocus(25, undefined, 'the migration')
		at('2026-10-12T09:26:00')
		await engine.tick()
		expect((await cmd.overlayState()).pending?.kind).toBe('prompt')
	})

	it('should hand the block’s own words to the question it asks at the end', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.startFocus(25, undefined, 'the retry bug')
		at('2026-10-12T09:26:00')
		await engine.tick()

		// You wrote that line twenty-five minutes ago. Asking again with an empty
		// box is the app forgetting the one thing you told it.
		expect((await cmd.promptContext(true)).focusIntent).toBe('the retry bug')
	})

	it('should count the ten more minutes, so 25 does not quietly become three hours', async () => {
		at('2026-10-12T09:00:00')
		await cmd.startFocus(25)
		await cmd.extendFocus(10)
		await cmd.extendFocus(10)
		const f = await cmd.focusNow()
		expect(f?.session.extended).toBe(2)
		expect(f?.left).toBe(45)
	})

	it('should say something the first time you wander, and nothing the second', async () => {
		at('2026-10-12T09:00:00')
		await cmd.startFocus(50, undefined, 'the retry bug')
		at('2026-10-12T09:12:00')
		const first = await cmd.noteStray('https://old.reddit.com/r/all')
		expect(first?.line).toBe('reddit.com — you are 38 minutes into “the retry bug”.')
		// The second time you open the same tab you have already had the thought.
		expect(await cmd.noteStray('https://www.reddit.com/r/programming')).toBeNull()
	})

	it('should say nothing about a site you work on, or when no block is running', async () => {
		at('2026-10-12T09:00:00')
		await cmd.startFocus(50)
		expect(await cmd.noteStray('https://github.com/acme/api/pull/812')).toBeNull()
		await cmd.endFocus(false)
		expect(await cmd.noteStray('https://reddit.com')).toBeNull()
	})

	it('should keep what the week came to, finished or not', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.startFocus(50, undefined, 'the retry bug')
		at('2026-10-12T09:51:00')
		await engine.tick() // ran to the end
		await cmd.dismiss().catch(() => undefined)

		at('2026-10-12T11:00:00')
		await cmd.startFocus(50, undefined, 'the migration')
		at('2026-10-12T11:20:00')
		await cmd.endFocus(false) // stopped early

		const { stats, line } = await cmd.deepWork('week')
		expect(stats).toMatchObject({ sessions: 2, finished: 1, longest: 50 })
		expect(stats.minutes).toBe(70)
		expect(line).toContain('1h 10m of focus across 2 blocks')
	})

	it('should not keep a false start as a block', async () => {
		at('2026-10-12T09:00:00')
		await cmd.startFocus(25)
		at('2026-10-12T09:02:00')
		await cmd.endFocus(false)
		expect((await cmd.deepWork('week')).stats.sessions).toBe(0)
	})
})

describe('a note on a page, on your own', () => {
	it('should keep one with no GitHub, no team and nothing set up', async () => {
		at('2026-10-12T14:00:00')
		await cmd.noteOnPage({ url: 'https://stage.acme.com/orders/12#row', title: 'Orders', text: 'The total ignores the discount' })

		// It comes back on the same page, however the address was copied.
		const found = await cmd.notesOnPage('https://stage.acme.com/orders/12?utm_source=slack')
		expect(found.open).toBe(1)
		expect(found.notes[0]).toMatchObject({ author: 'You', source: 'me', text: 'The total ignores the discount' })
		expect(await cmd.noteCount('https://stage.acme.com/orders/12')).toEqual({ open: 1, closed: 0 })
	})

	it('should keep a note dealt with rather than losing it', async () => {
		at('2026-10-12T14:00:00')
		const n = await cmd.noteOnPage({ url: 'https://stage.acme.com/a', text: 'Check the rounding' })
		await cmd.noteDone(n.id)
		expect((await cmd.noteCount('https://stage.acme.com/a'))).toEqual({ open: 0, closed: 1 })
		expect((await cmd.notesOnPage('https://stage.acme.com/a')).notes[0].state).toBe('closed')
		await cmd.noteDone(n.id, false)
		expect((await cmd.noteCount('https://stage.acme.com/a')).open).toBe(1)
	})

	it('should list the pages you have written on, newest first', async () => {
		at('2026-10-12T10:00:00')
		await cmd.noteOnPage({ url: 'https://a.test/x', title: 'A', text: 'one' })
		at('2026-10-12T11:00:00')
		await cmd.noteOnPage({ url: 'https://b.test/y', title: 'B', text: 'two' })
		expect((await cmd.notedPages()).map((p) => p.title)).toEqual(['B', 'A'])
	})

	it('should carry the ticket into the filename of everything it owns', async () => {
		at('2026-10-16T14:00:00')
		const w = await cmd.saveWorkspace({ name: 'PAY-3092 master-key ACL', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/3033' }] })
		const n = await cmd.noteOnPage({ url: 'https://github.com/acme/api/pull/3033/changes', title: 'Demo image', text: 'working as expected', shot: 'data:image/jpeg;base64,/9j/AA' })
		await cmd.noteToTicket(n.id, w.id)

		await cmd.saveSettings({ syncPath: 'workpulse', backupShots: true })
		const data = await cmd.backup()
		const files = filesFor(data, 'workpulse', parseIst('2026-10-16T20:00:00'), true)
		// PAY-3092 now finds the note, the picture and the ticket in one search.
		expect(files.find((f) => f.path.includes('/shots/'))?.path).toContain('PAY-3092-2026-10-16-github-com-demo-image')
	})

	it('should refuse to share before there is anyone to share with', async () => {
		at('2026-10-12T14:00:00')
		const n = await cmd.noteOnPage({ url: 'https://stage.acme.com/a', text: 'Check the rounding' })
		await expect(cmd.shareNote(n.id)).rejects.toThrow(/No team yet/i)
		// And it is still yours, untouched.
		expect((await cmd.notesOnPage('https://stage.acme.com/a')).notes[0].number).toBeUndefined()
	})

	it('should throw nothing away when a note is deleted by hand', async () => {
		at('2026-10-12T14:00:00')
		const a = await cmd.noteOnPage({ url: 'https://stage.acme.com/a', text: 'one' })
		await cmd.noteOnPage({ url: 'https://stage.acme.com/a', text: 'two' })
		await cmd.deletePageNote(a.id)
		expect((await cmd.notesOnPage('https://stage.acme.com/a')).notes.map((n) => n.text)).toEqual(['two'])
	})
})

describe('a block you booked', () => {
	it('should offer itself once, at the minute it comes round', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.saveBlock({ time: '10:00', minutes: 90, days: [1, 2, 3, 4, 5], intent: 'the hard thing' })

		at('2026-10-12T09:40:00')
		await engine.tick()
		expect(ui.notes).not.toContain('block')

		at('2026-10-12T09:59:00')
		await engine.tick()
		expect(ui.notes).toContain('block')

		// Once. Not every minute for the next quarter of an hour.
		const said = ui.notes.filter((n) => n === 'block').length
		at('2026-10-12T10:05:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'block')).toHaveLength(said)
	})

	it('should start it, with its intent, when you take it up', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.saveBlock({ time: '10:00', minutes: 90, days: [1, 2, 3, 4, 5], intent: 'the hard thing' })
		at('2026-10-12T09:59:00')
		await engine.tick()

		await cmd.startBookedBlock()
		const f = await cmd.focusNow()
		expect(f?.session.intent).toBe('the hard thing')
		expect(f?.left).toBe(90)
	})

	it('should say nothing on a day off, or before you have checked in', async () => {
		await cmd.saveBlock({ time: '10:00', minutes: 90, days: [1, 2, 3, 4, 5] })
		at('2026-10-12T09:59:00')
		await engine.tick() // never checked in
		expect(ui.notes).not.toContain('block')
	})

	it('should offer what matters rather than an empty box', async () => {
		at('2026-10-12T09:00:00')
		await cmd.savePlan('2026-10-12', { goal: 'Ship the retry fix', todos: ['Verify on staging'] })
		await cmd.capture({ text: 'PAY-9 urgent one', priority: 'high' })
		const ideas = await cmd.blockIdeas()
		expect(ideas[0]).toMatchObject({ text: 'Ship the retry fix', why: "today's goal" })
		expect(ideas.map((i) => i.why)).toContain('marked high')
	})
})

describe('a team that keeps itself current', () => {
	it('should share once the day is closed, without being asked', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.saveSettings({ teamRepo: 'acme/team', shareHours: true, syncAfter: '19:00' })
		await cmd.saveSyncToken('github_pat_secret')

		at('2026-10-12T18:00:00')
		await engine.tick()
		expect(ui.shares).toBe(0) // the day is still open

		at('2026-10-12T18:30:00')
		await cmd.confirmAttendance('out')
		await engine.tick()
		expect(ui.shares).toBe(1)

		// Not once a minute.
		at('2026-10-12T18:33:00')
		await engine.tick()
		expect(ui.shares).toBe(1)

		// A push that never reports back is retried, but slowly — ten minutes,
		// not every tick for the rest of the evening.
		at('2026-10-12T18:41:00')
		await engine.tick()
		expect(ui.shares).toBe(2)
	})

	it('should send at once when the day is closed, rather than waiting out the timer', async () => {
		at('2026-10-12T09:00:00')
		await cmd.saveSettings({ teamRepo: 'acme/team', shareHours: true })
		await cmd.saveSyncToken('github_pat_secret')
		await cmd.confirmAttendance('in') // something the others would want to see
		await engine.tick()
		const before = ui.shares

		at('2026-10-12T09:01:00')
		await cmd.confirmAttendance('out')
		await engine.tick()
		expect(ui.shares).toBe(before + 1)
	})

	it('should share nothing at all when nothing was switched on', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.saveSettings({ teamRepo: 'acme/team' })
		at('2026-10-12T19:30:00')
		await cmd.confirmAttendance('out')
		await engine.tick()
		expect(ui.shares).toBe(0)
	})

	it('should not share for someone with no team', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.saveSettings({ shareHours: true })
		at('2026-10-12T19:30:00')
		await cmd.confirmAttendance('out')
		await engine.tick()
		expect(ui.shares).toBe(0)
	})
})

describe('putting it back', () => {
	it('should undo adding every tab in the window to the wrong ticket', async () => {
		at('2026-10-12T09:00:00')
		const w = await cmd.saveWorkspace({ name: 'PAY-2433 financing', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/1' }] })
		await cmd.addToWorkspace(w.id, Array.from({ length: 20 }, (_, i) => ({ title: `Tab ${i}`, url: `https://a.test/${i}` })))
		expect((await cmd.ticket(w.id))?.tabs).toHaveLength(21)

		expect((await cmd.undoable())?.label).toBe('Undo adding 20 links to PAY-2433 financing')
		await cmd.undo()
		// Exactly back as it was: the one you collected on purpose is still there.
		const back = await cmd.ticket(w.id)
		expect(back?.tabs).toHaveLength(1)
		expect(back?.tabs[0].url).toBe('https://github.com/acme/api/pull/1')
	})

	it('should put a deleted ticket back, notes and all', async () => {
		at('2026-10-12T09:00:00')
		const w = await cmd.saveWorkspace({ name: 'PAY-2433', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/1' }] })
		await cmd.saveNote(w.id, { date: '2026-10-12', text: 'Behind the flag' })
		await cmd.deleteWorkspace(w.id)
		expect(await cmd.ticket(w.id)).toBeNull()

		await cmd.undo()
		const back = await cmd.ticket(w.id)
		expect(back?.name).toBe('PAY-2433')
		expect(back?.notes).toHaveLength(1)
	})

	it('should unpick a merge, which removed one of them', async () => {
		at('2026-10-12T09:00:00')
		const a = await cmd.saveWorkspace({ name: 'PAY-2433', tabs: [{ title: 'A', url: 'https://a.test/1' }] })
		const b = await cmd.saveWorkspace({ name: 'PAY-2433 financing', tabs: [{ title: 'B', url: 'https://b.test/1' }] })
		await cmd.mergeTickets(b.id, a.id)
		expect(await cmd.ticket(b.id)).toBeNull()

		await cmd.undo()
		expect((await cmd.ticket(b.id))?.name).toBe('PAY-2433 financing')
		expect((await cmd.ticket(a.id))?.tabs).toHaveLength(1)
	})

	it('should stop offering after a while', async () => {
		at('2026-10-12T09:00:00')
		const w = await cmd.saveWorkspace({ name: 'PAY-1', tabs: [{ title: 'A', url: 'https://a.test/1' }] })
		await cmd.addToWorkspace(w.id, [{ title: 'B', url: 'https://b.test/1' }])
		at('2026-10-12T09:20:00')
		expect(await cmd.undoable()).toBeNull()
		expect(await cmd.undo()).toBeNull()
	})

	it('should take out the batch that went in together, long after the undo has gone', async () => {
		at('2026-10-12T09:00:00')
		const w = await cmd.saveWorkspace({ name: 'PAY-2433', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/1' }] })
		at('2026-10-12T11:00:00')
		await cmd.addToWorkspace(w.id, Array.from({ length: 12 }, (_, i) => ({ title: `Tab ${i}`, url: `https://a.test/${i}` })))

		// The next day: nothing to undo, but they still share a timestamp.
		at('2026-10-13T09:00:00')
		expect(await cmd.undoable()).toBeNull()
		const space = await cmd.ticket(w.id)
		const batch = addedTogether(space!.tabs)
		expect(batch?.urls).toHaveLength(12)

		await cmd.removeLinks(w.id, batch!.urls)
		const left = await cmd.ticket(w.id)
		expect(left?.tabs).toHaveLength(1)
		expect(left?.tabs[0].url).toBe('https://github.com/acme/api/pull/1')
	})
})

describe('a to-do that is due', () => {
	it('should ring, and keep ringing, until it is answered', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.capture({ text: 'Call the bank back', when: '2026-10-12T11:00' })

		at('2026-10-12T11:00:00')
		await engine.tick()
		const p = (await cmd.overlayState()).pending
		expect(p).toMatchObject({ kind: 'remind', blocking: true })
		const rang = ui.chimes

		// A reminder you did not hear is a reminder that did not happen.
		at('2026-10-12T11:02:00')
		await engine.tick()
		expect(ui.chimes).toBeGreaterThan(rang)
	})

	it('should stop the moment it is answered', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		const t = await cmd.capture({ text: 'Call the bank back', when: '2026-10-12T11:00' })
		at('2026-10-12T11:00:00')
		await engine.tick()

		await cmd.answerReminder(t.uid, 'done')
		expect((await cmd.overlayState()).pending).toBeNull()
		const quiet = ui.chimes
		at('2026-10-12T11:05:00')
		await engine.tick()
		expect(ui.chimes).toBe(quiet)
	})

	it('should give up ringing eventually rather than becoming a siren', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		await cmd.capture({ text: 'Call the bank back', when: '2026-10-12T11:00' })
		at('2026-10-12T11:00:00')
		await engine.tick()

		at('2026-10-12T11:25:00')
		const long = ui.chimes
		await engine.tick()
		expect(ui.chimes).toBe(long) // twenty minutes is enough
		// The card is still there, silently, because it still needs an answer.
		expect((await cmd.overlayState()).pending?.kind).toBe('remind')
	})
})

describe('work that is not moving', () => {
	it('should count what is finished and waiting on somebody else', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		const t = await cmd.capture({ text: 'PAY-3092 master-key ACL' })
		at('2026-10-12T13:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'PAY-3092: wrote it', minutes: 240 })
		await cmd.updateTask(t.uid, { blocked: true })

		// Three days later, at the desk the whole time.
		for (const d of ['2026-10-13', '2026-10-14', '2026-10-15']) {
			at(`${d}T09:00:00`)
			await cmd.confirmAttendance('in')
		}
		at('2026-10-15T15:00:00')
		const got = await cmd.notMoving()
		expect(got.waiting[0]).toMatchObject({ key: 'PAY-3092', minutes: 240 })
		expect(got.waiting[0].hereDays).toBe(4)
		expect(got.waitingLine).toContain('PAY-3092 has been waiting')
		// The only number in the app that is really about somebody else.
		expect(got.lostMinutes).toBeGreaterThan(0)
	})

	it('should find a ticket with material on it and nothing logged since', async () => {
		at('2026-09-20T09:00:00')
		await cmd.saveWorkspace({ name: 'PAY-2901 refunds', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/9' }] })
		at('2026-10-16T09:00:00')
		const got = await cmd.notMoving(40)
		expect(got.stale.map((t) => t.name)).toContain('PAY-2901 refunds')
		// And the PR link, which is the no-API half of "open for nine days".
		expect(got.quiet.map((q) => q.ticket)).toContain('PAY-2901 refunds')
	})

	it('should say nothing at all when everything is moving', async () => {
		at('2026-10-12T09:00:00')
		await cmd.confirmAttendance('in')
		const got = await cmd.notMoving()
		expect(got.waiting).toEqual([])
		expect(got.waitingLine).toBeNull()
	})
})

describe('where the week went', () => {
	it('should separate meetings from the rest of the work', async () => {
		at('2026-10-12T09:00:00')
		await cmd.saveSettings({ promptInterval: 60, workDays: [1, 2, 3, 4, 5] })
		await cmd.confirmAttendance('in')
		const m = await cmd.saveMeeting({ name: 'Standup', time: '09:45', days: [1, 2, 3, 4, 5], leadMinutes: 5, logMinutes: 15 })
		await cmd.logMeeting(m.id, 15)

		at('2026-10-12T13:00:00')
		const ctx = await cmd.promptContext(true)
		await cmd.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: 'PAY-3092: the parser', minutes: 180 })

		const { split, line } = await cmd.week('2026-10-12')
		expect(split.meetings).toBe(15)
		expect(split.logged).toBe(195)
		expect(line).toContain('in meetings')
		// No target invented, in either direction.
		expect(line).not.toMatch(/should|too much|target/)
	})

	it('should hand Friday’s line back on Monday', async () => {
		at('2026-10-16T18:30:00')
		await cmd.saveWeekIntention('Stop taking meetings before eleven')
		at('2026-10-19T09:30:00')
		expect((await cmd.weekReview()).lastIntention).toBe('Stop taking meetings before eleven')
	})

	it('should ask once, in the last working hour of the last working day', async () => {
		at('2026-10-16T09:00:00') // a Friday
		await cmd.saveSettings({ workDays: [1, 2, 3, 4, 5], shiftEnd: '19:00' })
		await cmd.confirmAttendance('in')
		at('2026-10-16T15:00:00')
		await engine.tick()
		expect(ui.notes).not.toContain('weekreview')

		at('2026-10-16T18:30:00')
		await engine.tick()
		expect(ui.notes).toContain('weekreview')

		const said = ui.notes.filter((n) => n === 'weekreview').length
		at('2026-10-16T18:45:00')
		await engine.tick()
		expect(ui.notes.filter((n) => n === 'weekreview')).toHaveLength(said)
	})

	it('should not ask on a Wednesday', async () => {
		at('2026-10-14T18:30:00')
		await cmd.saveSettings({ workDays: [1, 2, 3, 4, 5], shiftEnd: '19:00' })
		await cmd.confirmAttendance('in')
		await engine.tick()
		expect(ui.notes).not.toContain('weekreview')
	})
})

describe('the first hour', () => {
	it('should hold it a few minutes after the shift starts, on your days', async () => {
		at('2026-10-12T09:00:00')
		await cmd.saveSettings({ shiftStart: '09:30', workDays: [1, 2, 3, 4, 5] })
		expect(await cmd.firstHourHeld()).toBe(false)

		const b = await cmd.holdFirstHour(60)
		// Not on the dot: nobody sits down at exactly half past, and a block that
		// has already begun is one you ignore.
		expect(b.time).toBe('09:40')
		expect(b.days).toEqual([1, 2, 3, 4, 5])
		expect(await cmd.firstHourHeld()).toBe(true)
	})
})


describe('a page that names a ticket you have not saved', () => {
	const page = { title: '[PAY-3110] lightstream warning - Jira', url: 'https://jira.acme.com/browse/PAY-3110' }

	it('should say nothing when the page names no ticket', async () => {
		ui.page = { title: 'Hacker News', url: 'https://news.ycombinator.com/' }
		expect(await cmd.pageTicketOffer()).toBeNull()
	})

	it('should offer to start one from the key the page carries', async () => {
		ui.page = page
		const got = await cmd.pageTicketOffer()
		expect(got?.key).toBe('PAY-3110')
		expect(got?.saved).toBeNull()
	})

	it('should offer to add to the ticket when one already exists', async () => {
		ui.page = page
		const w = await cmd.saveWorkspace({ name: 'PAY-3110 lightstream', tabs: [{ title: 'PR', url: 'https://github.com/acme/api/pull/1' }] })
		const got = await cmd.pageTicketOffer()
		expect(got?.saved?.id).toBe(w.id)
	})

	it('should stop offering once this page is actually under it', async () => {
		ui.page = page
		await cmd.saveWorkspace({ name: 'PAY-3110 lightstream', tabs: [page] })
		expect(await cmd.pageTicketOffer()).toBeNull()
	})

	it('should offer somewhere else to put it, so the destination is confirmed', async () => {
		await cmd.saveWorkspace({ name: 'LEAP-19 webhook', tabs: [{ title: 'a', url: 'https://a.test/1' }] })
		await cmd.saveWorkspace({ name: 'PAY-2433 financing', tabs: [{ title: 'b', url: 'https://b.test/1' }] })
		ui.page = page
		const got = await cmd.pageTicketOffer()
		expect(got?.recent.map((r) => r.name)).toContain('PAY-2433 financing')
		expect(got?.recent.length).toBeLessThanOrEqual(3)
	})

	it('should never offer the ticket it is already telling you about', async () => {
		ui.page = page
		const w = await cmd.saveWorkspace({ name: 'PAY-3110 lightstream', tabs: [{ title: 'PR', url: 'https://x.test/1' }] })
		const got = await cmd.pageTicketOffer()
		expect(got?.recent.map((r) => r.id)).not.toContain(w.id)
	})
})
