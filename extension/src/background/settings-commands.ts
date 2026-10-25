// Settings, the Zoho connection, the stage-1 smoke test and the jobs cache.

import { istDate, istTime, MIN } from '@/core/time'
import { DEFAULT_SETTINGS, type Job, type Settings } from '@/core/types'
import { ZohoError } from '@/core/zoho-parse'

import { errText } from './engine'
import { ReviewCommands } from './review-commands'
import { validateSettings } from './settings'

export class SettingsCommands extends ReviewCommands {
	// ── settings and Zoho connection ───────────────────────────────────────
	async getSettings() {
		const auth = await this.store.auth()
		return {
			settings: await this.store.settings(),
			auth: auth ? { kind: auth.kind, renewable: auth.kind === 'oauth' ? auth.renewable : true } : null,
			redirectUrl: this.zoho.redirectUri(),
		}
	}

	async saveSettings(patch: Partial<Settings>): Promise<Settings> {
		const merged = validateSettings({ ...(await this.store.settings()), ...patch })
		await this.store.saveSettings(merged)
		// Touching the shift means it was looked at, which is all the readiness
		// check wants to know — it is the difference between your hours and ours.
		if (patch.shiftStart || patch.shiftEnd || patch.workDays) await this.store.setSetupFlags({ shift: true })
		this.env.ui.changed()
		return merged
	}

	/**
	 * Wipes a day's entries and attendance, for clearing out what a test day
	 * left behind. Deliberately one day at a time and never automatic.
	 */
	async clearDay(date: string): Promise<void> {
		await this.store.setEntries(date, [])
		await this.store.updateDay(date, { checkedInAt: undefined, checkedOutAt: undefined, isOff: false, timelogStatus: 'pending' })
		await this.store.updateRuntime((r) => {
			r.away = []
			r.awaiting = undefined
			r.snoozes = 0
		})
		await this.engine.clearPending()
		await this.engine.reconcile()
		this.env.ui.changed()
	}

	/** A file you can keep before reinstalling, and feed back afterwards. */
	async exportData() {
		return { version: 1, at: this.now(), data: await this.store.exportAll() }
	}

	async importData(text: string): Promise<number> {
		let parsed: { data?: Record<string, unknown> }
		try {
			parsed = JSON.parse(text) as { data?: Record<string, unknown> }
		} catch {
			throw new Error('That is not a WorkPulse backup file.')
		}
		const data = parsed?.data
		if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('That backup has no WorkPulse data in it.')
		const count = await this.store.importAll(data)
		this.env.ui.changed()
		return count
	}

	async signIn(): Promise<void> {
		await this.zoho.signIn(true)
		this.env.ui.changed()
	}

	async saveSelfClient(clientId: string, clientSecret: string, refreshToken: string): Promise<void> {
		await this.zoho.saveSelfClient(clientId, clientSecret, refreshToken)
		this.env.ui.changed()
	}

	async signOut(): Promise<void> {
		await this.zoho.signOut()
		this.env.ui.changed()
	}

	/** Stage 1 smoke test: today's attendance, jobs, and this month's report. */
	async testConnection() {
		const s = await this.store.settings()
		const today = istDate(this.now())
		// A role without API access is not a failure to report three times over:
		// it is the state the no-API page path exists for.
		const check = async (fn: () => Promise<string>) => {
			try {
				return { ok: true, detail: await fn(), blocked: false }
			} catch (e) {
				const blocked = e instanceof ZohoError && e.isRoleBlocked
				if (blocked) await this.store.updateRuntime((r) => void (r.roleBlocked = true))
				return { ok: false, blocked, detail: blocked ? 'No API access for your role yet — WorkPulse reads your own Zoho pages instead.' : errText(e) }
			}
		}
		return {
			attendance: await check(async () => {
				const a = await this.zoho.attendance(today)
				return a.checkedIn ? `Checked in (first in ${a.firstIn ?? '?'})${a.checkedOut ? ', checked out' : ''}` : 'Not checked in today'
			}),
			jobs: await check(async () => {
				const jobs = await this.zoho.jobs(s.email)
				await this.store.saveJobs(jobs, this.now())
				return `${jobs.length} job${jobs.length === 1 ? '' : 's'}`
			}),
			report: await check(async () => {
				const days = await this.zoho.userReport(s.email, `${today.slice(0, 7)}-01`, today)
				return `${days.length} day${days.length === 1 ? '' : 's'} in this month's report`
			}),
		}
	}

	async jobs(force = false): Promise<Job[]> {
		const at = await this.store.jobsUpdatedAt()
		const stale = at == null || this.now() - at > 24 * 60 * MIN
		if ((force || stale) && (await this.zoho.hasAuth())) {
			try {
				await this.store.saveJobs(await this.zoho.jobs((await this.store.settings()).email), this.now())
			} catch (e) {
				if (force) throw e
			}
		}
		return this.store.jobs()
	}
}
