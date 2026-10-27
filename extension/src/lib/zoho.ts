// Zoho People client for the extension. Two ways in, both official OAuth:
//  1. "Sign in with Zoho": a Zoho Client-based application, token in the
//     redirect fragment (chrome.identity.launchWebAuthFlow), renewed silently.
//  2. Self Client: client id + secret + refresh token pasted in Settings.
// Writes are only ever called after `allowed()` in the caller.

import { API_ENABLED } from '@/core/features'
import type { DayReport } from '@/core/rules'
import { hhmm, istDateTime } from '@/core/time'
import type { Auth, DataCenter, Job } from '@/core/types'
import { findError, parseAttendance, parseJobs, parseTimelog, parseToken, parseUserReport, ZohoError, type Attendance } from '@/core/zoho-parse'

import type { Store } from './store'

export interface ZohoDeps {
	store: Store
	fetch: typeof fetch
	now: () => number
	/** chrome.identity.launchWebAuthFlow; returns the final redirect URL. */
	authFlow?: (url: string, interactive: boolean) => Promise<string>
	redirectUrl?: () => string
}

export const hosts = (dc: DataCenter) => ({
	api: `https://people.zoho.${dc}/people/api`,
	accounts: `https://accounts.zoho.${dc}`,
})

export interface ZohoApi {
	hasAuth(): Promise<boolean>
	attendance(date: string): Promise<Attendance>
	jobs(email: string): Promise<Job[]>
	userReport(email: string, from: string, to: string): Promise<DayReport[]>
	addTimelog(a: { email: string; date: string; jobId: string; minutes: number; description: string; billing: string; from?: string; to?: string }): Promise<string>
	punch(email: string, checkIn: boolean, at: number): Promise<void>
}

export class ZohoClient implements ZohoApi {
	constructor(private d: ZohoDeps) {}

	async hasAuth() {
		return API_ENABLED && (await this.d.store.auth()) != null
	}

	/** Interactive "Sign in with Zoho". Needs settings.oauthClientId. */
	async signIn(interactive = true): Promise<void> {
		const s = await this.d.store.settings()
		if (!s.oauthClientId) throw new ZohoError('Add your Zoho client id in Settings first.')
		if (!this.d.authFlow || !this.d.redirectUrl) throw new ZohoError('Sign-in is not available here.')
		const url = new URL(`${hosts(s.dataCenter).accounts}/oauth/v2/auth`)
		url.search = new URLSearchParams({
			response_type: 'token',
			client_id: s.oauthClientId,
			scope: s.scopes,
			redirect_uri: this.d.redirectUrl(),
		}).toString()
		const back = await this.d.authFlow(url.toString(), interactive)
		const frag = new URLSearchParams(new URL(back).hash.slice(1))
		const err = frag.get('error') ?? new URL(back).searchParams.get('error')
		if (err) throw new ZohoError(`Zoho sign-in failed: ${err}`)
		const accessToken = frag.get('access_token')
		if (!accessToken) throw new ZohoError('Zoho sign-in returned no token.')
		const expiresIn = Number(frag.get('expires_in')) || 3600
		await this.d.store.setAuth({
			kind: 'oauth',
			accessToken,
			expiresAt: this.d.now() + expiresIn * 1000,
			renewable: frag.get('granted_for_session') === 'true',
		})
	}

	async saveSelfClient(clientId: string, clientSecret: string, refreshToken: string): Promise<void> {
		if (!clientId.trim() || !clientSecret.trim() || !refreshToken.trim()) throw new ZohoError('Client id, secret and refresh token are all required.')
		await this.d.store.setAuth({ kind: 'self', clientId: clientId.trim(), clientSecret: clientSecret.trim(), refreshToken: refreshToken.trim() })
	}

	/**
	 * Self Client without curl: trades the code from the console's Generate Code
	 * tab for a refresh token and stores it. Codes expire within minutes.
	 */
	async exchangeSelfClientCode(clientId: string, clientSecret: string, code: string): Promise<void> {
		const [id, secret, c] = [clientId.trim(), clientSecret.trim(), code.trim()]
		if (!id || !secret || !c) throw new ZohoError('Client id, client secret and the generated code are all required.')
		const s = await this.d.store.settings()
		const body = new URLSearchParams({ grant_type: 'authorization_code', code: c, client_id: id, client_secret: secret })
		let v: any
		try {
			const res = await this.d.fetch(`${hosts(s.dataCenter).accounts}/oauth/v2/token`, { method: 'POST', body })
			v = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
		} catch (e) {
			throw new ZohoError(`Network: ${(e as Error).message}`)
		}
		const err = findError(v)
		if (err?.message === 'invalid_code') throw new ZohoError('That code expired or was already used. Generate a new one (choose 10 minutes) and paste it straight away.')
		if (err?.message === 'invalid_client') throw new ZohoError('Zoho does not recognise that client id and secret. Check you used the console for your data centre.')
		if (err) throw err
		if (!v.refresh_token) throw new ZohoError('Zoho returned no refresh token. Generate a new code and try again.')
		await this.d.store.setAuth({
			kind: 'self',
			clientId: id,
			clientSecret: secret,
			refreshToken: String(v.refresh_token),
			accessToken: v.access_token ? String(v.access_token) : undefined,
			expiresAt: v.access_token ? this.d.now() + (Number(v.expires_in) || 3600) * 1000 : undefined,
		})
	}

	/** https://<extension-id>.chromiumapp.org/ — what Zoho must have as the redirect URI. */
	redirectUri(): string {
		return this.d.redirectUrl?.() ?? ''
	}

	signOut() {
		return this.d.store.setAuth(null)
	}

	private async token(): Promise<string> {
		const auth = await this.d.store.auth()
		if (!auth) throw new ZohoError('Zoho is not connected. Connect it in Settings.')
		if (auth.accessToken && auth.expiresAt && auth.expiresAt - 60_000 > this.d.now()) return auth.accessToken
		if (auth.kind === 'oauth') {
			if (!auth.renewable) throw new ZohoError('Zoho session expired. Sign in again in Settings.')
			await this.signIn(false).catch(() => {
				throw new ZohoError('Zoho session expired. Sign in again in Settings.')
			})
			return ((await this.d.store.auth()) as Auth & { accessToken: string }).accessToken
		}
		const s = await this.d.store.settings()
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: auth.refreshToken,
			client_id: auth.clientId,
			client_secret: auth.clientSecret,
		})
		const res = await this.d.fetch(`${hosts(s.dataCenter).accounts}/oauth/v2/token`, { method: 'POST', body })
		const { accessToken, expiresIn } = parseToken(await res.json().catch(() => ({ error: `HTTP ${res.status}` })))
		await this.d.store.setAuth({ ...auth, accessToken, expiresAt: this.d.now() + expiresIn * 1000 })
		return accessToken
	}

	private async forget() {
		const a = await this.d.store.auth()
		if (a) await this.d.store.setAuth({ ...a, accessToken: undefined, expiresAt: 0 } as Auth)
	}

	/** One API call; on 401 the token is dropped and refreshed once. */
	private async call(method: 'GET' | 'POST', path: string, params: Record<string, string>): Promise<any> {
		const s = await this.d.store.settings()
		const url = `${hosts(s.dataCenter).api}/${path}?${new URLSearchParams(params)}`
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = await this.token()
			let res: Response
			try {
				res = await this.d.fetch(url, { method, headers: { Authorization: `Zoho-oauthtoken ${token}` } })
			} catch (e) {
				throw new ZohoError(`Network: ${(e as Error).message}`)
			}
			if (res.status === 401 && attempt === 0) {
				await this.forget()
				continue
			}
			const text = await res.text()
			try {
				return JSON.parse(text)
			} catch {
				throw new ZohoError(`Zoho HTTP ${res.status}: reply is not JSON`)
			}
		}
		throw new ZohoError('Zoho rejected the access token.')
	}

	/** Without `emailId` Zoho answers for whoever owns the token, not the configured user. */
	async attendance(date: string) {
		const { email } = await this.d.store.settings()
		return parseAttendance(await this.call('GET', 'attendance/getAttendanceEntries', { date, dateFormat: 'yyyy-MM-dd', ...(email ? { emailId: email } : {}) }))
	}

	async jobs(email: string) {
		return parseJobs(await this.call('GET', 'timetracker/getjobs', { assignedTo: email || 'all', jobStatus: 'in-progress', limit: '200' }))
	}

	async userReport(email: string, from: string, to: string) {
		if (!email) throw new ZohoError('Set your Zoho email in Settings to scan attendance.')
		return parseUserReport(await this.call('GET', 'attendance/getUserReport', { sdate: from, edate: to, emailId: email, dateFormat: 'yyyy-MM-dd' }))
	}

	/** `minutes` is the truth; Zoho takes HH:MM, which keeps it exact. */
	/**
	 * Zoho takes either hours or a from–to pair ("Either Hour or From - To time
	 * or timer:start has to be sent", 24-hour `14:30` accepted). With `from` and
	 * `to` (IST, HH:mm) the log carries its real times; hours otherwise.
	 */
	async addTimelog(a: { email: string; date: string; jobId: string; minutes: number; description: string; billing: string; from?: string; to?: string }) {
		const when: Record<string, string> = a.from && a.to ? { fromTime: a.from, toTime: a.to } : { hours: hhmm(a.minutes) }
		return parseTimelog(
			await this.call('POST', 'timetracker/addtimelog', {
				user: a.email,
				workDate: a.date,
				dateFormat: 'yyyy-MM-dd',
				jobId: a.jobId,
				...when,
				description: a.description,
				billingStatus: a.billing,
			}),
		)
	}

	/** Check in/out at `at` (IST). Only called in `full` mode. */
	async punch(email: string, checkIn: boolean, at: number) {
		const [date, time] = istDateTime(at).split('T')
		const [y, m, d] = date.split('-')
		const v = await this.call('POST', 'attendance', {
			[checkIn ? 'checkIn' : 'checkOut']: `${d}/${m}/${y} ${time}`,
			dateFormat: 'dd/MM/yyyy HH:mm:ss',
			emailId: email,
		})
		const e = findError(v)
		if (e) throw e
	}
}

