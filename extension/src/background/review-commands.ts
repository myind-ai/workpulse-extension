// Review, manual entries, timesheet push and the regularisation scan.

import { API_ENABLED } from '@/core/features'
import { groupEntries, type ReviewRow } from '@/core/rules'
import { addDays, atIst, isHHMM, istDate, istTime, MIN } from '@/core/time'
import type { Day, Entry, Issue, Job, Settings } from '@/core/types'
import { timesheetBody } from '@/core/zoho-page'
import { allowed, ZohoError } from '@/core/zoho-parse'

import { DayCommands, MIN_TEXT } from './commands'
import { errText } from './engine'

export interface Review {
	date: string
	day: Day
	rows: ReviewRow[]
	entries: Entry[]
	jobs: Job[]
	mode: Settings['zohoMode']
	canPush: boolean
	/** When it cannot push, the reason — so the fallback is not a mystery. */
	pushBlocked?: 'mode' | 'nosave' | 'noauth'
	attendanceMinutes: number | null
	loggedMinutes: number
	issue: Issue | null
	pendingDays: string[]
}

export type PushResult = { status: 'pushed' | 'skipped' | 'failed' | 'beyond' | 'pushing'; message?: string; done: number[] }

export class ReviewCommands extends DayCommands {
	// ── review and timesheet ───────────────────────────────────────────────
	async review(date?: string): Promise<Review> {
		const now = this.now()
		const d = date ?? istDate(now)
		const [s, entries, jobs, issues, auth] = await Promise.all([this.store.settings(), this.store.entries(d), this.store.jobs(), this.store.openIssues(), this.store.auth()])
		let day = await this.store.day(d)
		let attendanceMinutes: number | null = null
		// Opening the dashboard must not become a Zoho call: the tick already syncs
		// on its own cadence, and a refused role would retry on every render.
		const rt = await this.store.runtime()
		if (API_ENABLED && auth && !rt.roleBlocked && d === istDate(now)) {
			try {
				const a = await this.engine.syncAttendance(d)
				attendanceMinutes = Math.round(a.totalHours * 60)
				day = await this.store.day(d)
			} catch {
				// fall back to local times below
			}
		}
		if (attendanceMinutes == null && day.checkedInAt != null) attendanceMinutes = Math.round(((day.checkedOutAt ?? now) - day.checkedInAt) / MIN)
		const work = entries.filter((e) => e.kind === 'work')
		const unsynced = work.filter((e) => !e.synced)
		// Worked out once, so the button and the reason can never disagree.
		const hasSave = await this.canPushViaPage()
		const canPush = allowed(s.zohoMode, 'timelog') && ((API_ENABLED && auth != null) || hasSave)
		return {
			date: d,
			day,
			rows: groupEntries(unsynced.length ? unsynced : work, jobs),
			entries,
			jobs,
			mode: s.zohoMode,
			// A pasted timesheet save is a way to push too, so the button must not
			// depend on an OAuth connection the blocked role never gets to use.
			canPush,
			pushBlocked: canPush ? undefined : !allowed(s.zohoMode, 'timelog') ? 'mode' : hasSave ? 'noauth' : 'nosave',
			attendanceMinutes,
			loggedMinutes: work.reduce((a, e) => a + e.minutes, 0),
			issue: issues.find((i) => i.date === d) ?? null,
			pendingDays: await this.store.pendingDays(addDays(istDate(now), -7), istDate(now)),
		}
	}

	/** True once WorkPulse has a captured timesheet save to copy. */
	protected async canPushViaPage(): Promise<boolean> {
		const { seen } = await this.store.pageSource()
		return seen.some((r) => timesheetBody(r.body, { date: '2026-01-01', minutes: 0, workItem: '', description: '' }) != null)
	}

	async addManualEntry(a: { date: string; from: string; to: string; text: string; jobId?: string }): Promise<void> {
		if (!isHHMM(a.from) || !isHHMM(a.to)) throw new Error('Use HH:MM times.')
		const slotStart = atIst(a.date, a.from)
		const slotEnd = atIst(a.date, a.to)
		if (slotEnd <= slotStart) throw new Error('The end time must be after the start time.')
		const text = a.text.trim()
		if (text.length < MIN_TEXT) throw new Error(`Write at least ${MIN_TEXT} characters about what you did.`)
		await this.store.addEntry({ date: a.date, slotStart, slotEnd, text, jobId: a.jobId || undefined, minutes: Math.round((slotEnd - slotStart) / MIN), kind: 'work' })
		this.env.ui.changed()
	}

	async deleteEntry(date: string, entryUid: string): Promise<void> {
		const list = await this.store.entries(date)
		await this.store.setEntries(date, list.filter((e) => e.uid !== entryUid))
		this.env.ui.changed()
	}

	/** Reminder mode, or after copying rows into Zoho by hand. */
	async markDone(date: string): Promise<void> {
		const list = await this.store.entries(date)
		await this.store.setEntries(date, list.map((e) => (e.kind === 'work' ? { ...e, synced: true } : e)))
		await this.store.updateDay(date, { timelogStatus: 'pushed' })
		// A timesheet that reached Zoho is the clearest thing this did for you,
		// and the only reason it is ever entitled to ask for anything.
		await this.store.updateRuntime((r) => void (r.use = { ...r.use, wins: (r.use?.wins ?? 0) + 1 }))
		await this.engine.reconcile()
		this.env.ui.changed()
	}

	/**
	 * Marks just the entries that went to Zoho, so a partial push is honest: the
	 * day only counts as done once nothing work-related is left unsynced.
	 */
	async markEntriesSynced(date: string, uids: string[]): Promise<void> {
		if (!uids.length) return
		const pushed = new Set(uids)
		const list = await this.store.entries(date)
		const next = list.map((e) => (pushed.has(e.uid) ? { ...e, synced: true } : e))
		await this.store.setEntries(date, next)
		const left = next.some((e) => e.kind === 'work' && !e.synced)
		await this.store.updateDay(date, { timelogStatus: left ? 'pending' : 'pushed' })
		await this.engine.reconcile()
		this.env.ui.changed()
	}

	async pushDay(date: string, rows: { jobId?: string; minutes: number; description: string; from?: number; to?: number }[], uids: string[] = []): Promise<PushResult> {
		const s = await this.store.settings()
		if (!allowed(s.zohoMode, 'timelog') || !(await this.zoho.hasAuth())) {
			throw new Error('Pushing needs Time-logs or Full mode and a Zoho connection. Use Copy + Mark as done instead.')
		}
		if (!s.email) throw new Error('Set your Zoho email in Settings first.')
		const bad = rows.findIndex((r) => !r.jobId || !(r.minutes > 0))
		if (bad >= 0) throw new Error(`Row ${bad + 1} needs a job and time above 0.`)
		const done: number[] = []
		for (const [i, r] of rows.entries()) {
			const log = { email: s.email, date, jobId: r.jobId!, minutes: Math.round(r.minutes), description: r.description, billing: s.billingStatus }
			// The real start and end, when the row is one stretch and its hours were
			// not edited (the times would then say something else than the hours).
			const timed = s.timelogTimes && r.from != null && r.to != null && r.to > r.from && Math.round((r.to - r.from) / 60_000) === Math.round(r.minutes)
			try {
				try {
					await this.zoho.addTimelog(timed ? { ...log, from: istTime(r.from!), to: istTime(r.to!) } : log)
				} catch (first) {
					// Some timesheets take hours only: send the same row as hours.
					// Not for a day off or "more than attendance", which hours would not fix.
					const z = first instanceof ZohoError ? first : new ZohoError(errText(first))
					if (!timed || z.isOffDay || z.isBeyondAttendance) throw first
					await this.zoho.addTimelog(log)
				}
				done.push(i)
			} catch (e) {
				const z = e instanceof ZohoError ? e : new ZohoError(errText(e))
				if (z.isOffDay) {
					await this.store.updateDay(date, { isOff: true, timelogStatus: 'skipped' })
					await this.engine.reconcile()
					return { status: 'skipped', message: 'Zoho says this is a weekend, holiday or leave day, so it was marked off.', done }
				}
				if (z.isBeyondAttendance) return { status: 'beyond', message: 'Zoho refused: logged time is more than your attendance hours. Trim the hours and push again.', done }
				await this.store.updateDay(date, { timelogStatus: 'failed' })
				this.env.ui.changed()
				return { status: 'failed', message: z.toString(), done }
			}
		}
		if (uids.length) await this.markEntriesSynced(date, uids)
		else await this.markDone(date)
		return { status: 'pushed', done }
	}

	/** Zoho's report when it answers, WorkPulse's own record when it does not. */
	async scanNow(): Promise<number> {
		return this.engine.scanBest()
	}

	/**
	 * The sentence a regularisation form asks for, built from what you actually
	 * logged that day — the thing you would otherwise try to remember a week later.
	 */
	async issueReason(date: string): Promise<string> {
		const [day, entries, jobs] = await Promise.all([this.store.day(date), this.store.entries(date), this.store.jobs()])
		const work = entries.filter((e) => e.kind === 'work')
		const span = day.checkedInAt != null ? `Worked ${istTime(day.checkedInAt)}–${day.checkedOutAt != null ? istTime(day.checkedOutAt) : istTime(work.at(-1)?.slotEnd ?? day.checkedInAt)}` : 'Worked'
		const minutes = work.reduce((a, e) => a + e.minutes, 0)
		const what = groupEntries(work, jobs)
			.map((r) => r.description)
			.join('; ')
		const why = day.checkedOutAt == null && day.checkedInAt != null ? ' Forgot to check out.' : ''
		return `${span} (${Math.floor(minutes / 60)}h ${minutes % 60}m logged).${why}${what ? ` ${what}` : ''}`.trim()
	}

	/** "I have sorted this in Zoho" — it leaves the list; the next scan confirms. */
	async resolveIssue(date: string): Promise<void> {
		const list = await this.store.issues()
		await this.store.saveIssues(list.map((i) => (i.date === date && i.resolvedAt == null ? { ...i, resolvedAt: this.now() } : i)))
		this.env.ui.changed()
	}
}
