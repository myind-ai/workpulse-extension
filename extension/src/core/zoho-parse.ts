// Zoho People: the write guard and response parsing (ported from
// src-tauri/src/zoho.rs, tested against the same fixtures).

import { blank, hoursFromHHMM, type DayReport } from './rules'
import type { Job, ZohoMode } from './types'

export type Write = 'attendance' | 'timelog'

/** The single gate for every Zoho write. `reminder` (the default) never posts. */
export function allowed(mode: ZohoMode | string, w: Write): boolean {
	if (mode === 'full') return true
	return mode === 'timelogs' && w === 'timelog'
}

export class ZohoError extends Error {
	constructor(message: string, public code?: number) {
		super(message)
	}
	get isOffDay() {
		return this.code === 8008 || this.message.includes('Weekend/Holidays/Leave')
	}
	get isBeyondAttendance() {
		return this.message.toLowerCase().includes('beyond attendance')
	}
	/**
	 * The API is not available to you right now, for a reason you cannot act on:
	 *   "Sorry!your role is not allowed to access api's."  (no API access)
	 *   "API access blocked since threshold limit exceeded." (Zoho's rate limit)
	 * Neither is a fault to put in front of you — WorkPulse reads your own Zoho
	 * pages instead, and picks the API back up the moment it answers again.
	 */
	get isRoleBlocked() {
		return /not allowed to access|threshold limit|rate limit|too many requests/i.test(this.message)
	}
	toString() {
		return this.code != null ? `Zoho error ${this.code}: ${this.message}` : this.message
	}
}

type J = Record<string, any>

const str = (v: J | undefined, k: string): string => {
	const x = v?.[k]
	return typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : ''
}

export function findError(v: J): ZohoError | null {
	const resp = v?.response ?? v
	const errors = resp?.errors ?? v?.errors
	// Zoho sends `errors` as an object or a list; a successful reply can carry an empty list.
	const e = Array.isArray(errors) ? errors[0] : errors
	if (e) {
		const code = e.code != null ? Number(e.code) : undefined
		return new ZohoError(str(e, 'message') || 'Zoho returned an error', Number.isNaN(code) ? undefined : code)
	}
	if (resp?.status === 1) return new ZohoError(str(resp, 'message') || 'Zoho returned an error')
	if (typeof v?.error === 'string') return new ZohoError(v.error)
	return null
}

export function parseToken(v: J): { accessToken: string; expiresIn: number } {
	const e = findError(v)
	if (e) throw e
	const accessToken = str(v, 'access_token')
	if (!accessToken) throw new ZohoError("No access_token in Zoho's reply")
	return { accessToken, expiresIn: Number(v.expires_in) || 3600 }
}

export interface Attendance {
	checkedIn: boolean
	checkedOut: boolean
	firstIn: string | null
	lastOut: string | null
	totalHours: number
	status: string
}

export function parseAttendance(v: J): Attendance {
	const e = findError(v)
	if (e) throw e
	const firstIn = blank(str(v, 'firstIn')) ? null : str(v, 'firstIn')
	const lastOut = blank(str(v, 'lastOut')) ? null : str(v, 'lastOut')
	const entries: J[] = Array.isArray(v.entries) ? v.entries : []
	const checkedIn = firstIn != null || entries.some((x) => !blank(str(x, 'checkIn')))
	const last = entries[entries.length - 1]
	const checkedOut = checkedIn && (last ? !blank(str(last, 'checkOut')) : lastOut != null)
	return { checkedIn, checkedOut, firstIn, lastOut, totalHours: hoursFromHHMM(str(v, 'totalHrs')), status: str(v, 'status') }
}

export function parseJobs(v: J): Job[] {
	const e = findError(v)
	if (e) throw e
	const list: J[] = v?.response?.result ?? []
	return list.filter((j) => str(j, 'jobId')).map((j) => ({ id: str(j, 'jobId'), name: str(j, 'jobName'), project: str(j, 'projectName') }))
}

/** Single-employee report is a date-keyed map; the multi-record form wraps it in result[].attendanceDetails. */
export function parseUserReport(v: J): DayReport[] {
	const e = findError(v)
	if (e) throw e
	const map: J = v?.result?.[0]?.attendanceDetails ?? v?.response?.result?.[0]?.attendanceDetails ?? v
	return Object.entries(map)
		.filter(([k, d]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && d && typeof d === 'object')
		.map(([date, d]) => ({
			date,
			status: str(d as J, 'Status'),
			firstIn: str(d as J, 'FirstIn'),
			lastOut: str(d as J, 'LastOut'),
			totalHours: str(d as J, 'TotalHours'),
		}))
		.sort((a, b) => a.date.localeCompare(b.date))
}

export function parseTimelog(v: J): string {
	const e = findError(v)
	if (e) throw e
	const id = v?.response?.result?.[0]?.timeLogId
	if (id == null) throw new ZohoError('Zoho did not return a timeLogId')
	return String(id)
}
