// Everything the guided Zoho setup needs: the right URLs per data centre, the
// exact values for Zoho's "Client-based application" form, and Client ID /
// URL validation. Pure, so it is unit-tested.

import type { DataCenter, PendingKind } from './types'

export const consoleUrl = (dc: DataCenter) => `https://api-console.zoho.${dc}/`
export const peopleUrl = (dc: DataCenter) => `https://people.zoho.${dc}/`
export const accountsUrl = (dc: DataCenter) => `https://accounts.zoho.${dc}`

/** chrome.identity redirect for this extension: https://<id>.chromiumapp.org/ */
export const jsDomainFrom = (redirectUrl: string) => redirectUrl.replace(/\/+$/, '')

export interface FormValue {
	label: string
	value: string
	/** Matches the field's label text on Zoho's form (used by the page helper). */
	match: RegExp
}

export function clientFormValues(redirectUrl: string, dc: DataCenter): FormValue[] {
	return [
		{ label: 'Client Name', value: 'WorkPulse', match: /client\s*name/i },
		{ label: 'Homepage URL', value: peopleUrl(dc).replace(/\/$/, ''), match: /home\s*page\s*url/i },
		{ label: 'Authorized Redirect URIs', value: redirectUrl, match: /redirect\s*ur[il]/i },
		{ label: 'JavaScript Domain', value: jsDomainFrom(redirectUrl), match: /java\s*script\s*domain/i },
	]
}

/** Zoho client ids look like 1000.ABCDEF… (upper-case letters and digits). */
export const CLIENT_ID_RE = /\b1000\.[A-Z0-9]{20,40}\b/

export function findClientId(text: string): string | null {
	return text.match(CLIENT_ID_RE)?.[0] ?? null
}

export function isClientId(s: string): boolean {
	return new RegExp(`^${CLIENT_ID_RE.source}$`).test(s.trim())
}

/** Only a Zoho People page on an https Zoho host can be the attendance page. */
export function isPeopleUrl(url: string): boolean {
	try {
		const u = new URL(url)
		return u.protocol === 'https:' && /^people\.zoho\.(in|com|eu|com\.au)$/.test(u.hostname)
	} catch {
		return false
	}
}

export function dcFromHost(host: string): DataCenter | null {
	const m = host.match(/\.zoho\.(in|com|eu|com\.au)$/)
	return (m?.[1] as DataCenter) ?? null
}

/**
 * Pages where the forced overlay must not cover Zoho: the sign-in and API
 * console pages (setup happens there), and Zoho People for check-in and
 * wrap-up reminders (that is where you check in/out and fill the timesheet).
 */
export function overlayExempt(url: string | undefined, kind: PendingKind): boolean {
	let host = ''
	try {
		host = new URL(url ?? '').hostname
	} catch {
		return false
	}
	if (/^(accounts|api-console)\.zoho\.(in|com|eu|com\.au)$/.test(host)) return true
	if (!/^people\.zoho\.(in|com|eu|com\.au)$/.test(host)) return false
	// Zoho People, where you are already doing the thing. The hourly card is the
	// exception: it is the one that puts the words on the timesheet, so it is
	// wanted here — unless you are on the timesheet itself, filling it in, which
	// is the one page where a card saying "review your timesheet" is in the way.
	if (kind !== 'prompt') return true
	return /timetracker|timesheet|timelog/i.test(url ?? '')
}

// ── the Zoho pages WorkPulse needs to have seen ─────────────────────────────
// Zoho People keeps attendance and time logs in different places, under
// different tabs, with different calls behind them. Recording "your Zoho page"
// once therefore sets up whichever one happened to be open — and the other half
// quietly does nothing. These are the areas, named the way Zoho's own menu names
// them, so the setup can say which are done and which are not.

export type AreaId = 'attendance' | 'jobs' | 'save' | 'report'

export interface Area {
	id: AreaId
	/** Where it is, in Zoho's own words. */
	where: string
	/** What WorkPulse gets out of it. */
	gives: string
	/** What to do there, for someone who has never done it. */
	how: string
	/** True when this one is only ever read, so nothing is ever written. */
	readOnly: boolean
	/** Without this, what stops working. */
	without: string
}

export const ZOHO_AREAS: Area[] = [
	{
		id: 'attendance',
		where: 'Attendance → Attendance Summary',
		gives: 'Your check-in and check-out times for today',
		how: 'Open the tab and let the page finish loading. That is all — WorkPulse only reads it.',
		readOnly: true,
		without: 'WorkPulse cannot see whether you are checked in, so it keeps asking.',
	},
	{
		id: 'jobs',
		where: 'Time Tracker → Timesheet',
		gives: 'Your projects and the tasks under them',
		how: 'Open the tab and let the job list load, so the hourly card can offer the same names Zoho does.',
		readOnly: true,
		without: 'The hourly card has no jobs to log time against.',
	},
	{
		id: 'save',
		where: 'Time Tracker → Timesheet → add one row',
		gives: "Zoho's own save, which WorkPulse fills in with your rows",
		how: 'Add a single row by hand and save it, once. WorkPulse keeps that one call and replays it with your own times — it never invents one.',
		readOnly: false,
		without: 'Your timesheet can be copied into Zoho by hand, but not pushed.',
	},
	{
		id: 'report',
		where: 'Attendance → Regularization',
		gives: 'The days Zoho thinks are short, absent or missing a punch',
		how: 'Open the month view once so WorkPulse can see which days need fixing. Filing the regularisation is still yours to do in Zoho.',
		readOnly: true,
		without: 'Regularisation is worked out from WorkPulse’s own record instead, which only knows the days you used it.',
	},
]
