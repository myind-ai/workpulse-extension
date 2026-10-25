// Reads your own attendance off a Zoho People page you are already signed in
// to, for roles whose API access is blocked ("your role is not allowed to
// access api's"). Zoho's markup is not ours, so every value is best-effort:
// labels are matched by their visible text and the caller is told what was
// not found, the same way the setup helper reports fields it could not fill.

import { parseZohoDateTime } from './rules'
import { atIst } from './time'

export interface PageAttendance {
	firstIn: string | null
	lastOut: string | null
	totalHours: string | null
	/** Labels that were not found on the page, for the UI to show. */
	missing: string[]
}

/** "09:12", "09:12:05", "9:12 AM" — a clock time anywhere in a short string. */
const TIME = /\b(\d{1,2}:\d{2}(?::\d{2})?)\s*(AM|PM)?\b/i

const LABELS = [
	{ key: 'firstIn' as const, label: 'First In', match: /first\s*in\b/i },
	{ key: 'lastOut' as const, label: 'Last Out', match: /last\s*out\b/i },
	{ key: 'totalHours' as const, label: 'Total Hours', match: /total\s*(hours|hrs)\b/i },
]

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

const timeIn = (s: string): string | null => {
	const m = s.match(TIME)
	if (!m) return null
	return (m[2] ? `${m[1]} ${m[2].toUpperCase()}` : m[1]).trim()
}

/**
 * The value that belongs to `match`: in the label's own text ("First In 09:12"),
 * in the next element, or elsewhere under the nearest ancestor that holds both.
 */
export function valueFor(match: RegExp, root: ParentNode = document): string | null {
	const labels = [...root.querySelectorAll('*')].filter((el) => {
		const t = text(el)
		return t.length > 0 && t.length <= 80 && el.children.length <= 3 && match.test(t)
	})
	for (const el of labels) {
		const own = text(el).replace(match, ' ')
		const fromOwn = timeIn(own)
		if (fromOwn) return fromOwn
		const next = timeIn(text(el.nextElementSibling))
		if (next) return next
		let node: Element | null = el.parentElement
		for (let depth = 0; depth < 3 && node; depth++) {
			const around = timeIn(text(node).replace(match, ' '))
			if (around) return around
			node = node.parentElement
		}
	}
	return null
}

export function readAttendance(root: ParentNode = document): PageAttendance {
	const out: PageAttendance = { firstIn: null, lastOut: null, totalHours: null, missing: [] }
	for (const { key, label, match } of LABELS) {
		const v = valueFor(match, root)
		if (v) out[key] = v
		else out.missing.push(label)
	}
	return out
}

/** A page read is only worth storing if it found a check-in time. */
export const usable = (a: PageAttendance | null | undefined): boolean => !!a?.firstIn

// ── the endpoint path ───────────────────────────────────────────────────────
// Zoho's own web app calls its internal endpoints with the same field
// vocabulary as the documented API (firstIn / lastOut / totalHrs, or the
// capitalised report spelling), so the reply is searched by field name instead
// of a fixed shape: the endpoint can move or gain wrappers without this
// breaking. The caller still gets `missing` for whatever was not in there.

// Zoho's internal replies name the same things several ways (firstIn,
// punchInTime, checkIn…), so the key is matched loosely — and the value must
// look like a clock time, which keeps "punchInMode": "web" out of the result.
const FIELDS = [
	{ key: 'firstIn' as const, label: 'First In', match: /(first.?in|punch.?in|check.?in)/i },
	{ key: 'lastOut' as const, label: 'Last Out', match: /(last.?out|punch.?out|check.?out)/i },
	{ key: 'totalHours' as const, label: 'Total Hours', match: /(total.?(hours|hrs)|work(ed|ing).?(hours|hrs))/i },
]

const blankish = (v: unknown): boolean => typeof v !== 'string' || !v.trim() || v.trim() === '-' || v.trim() === '--' || !TIME.test(v)

/** yyyymmdd / ddmmyyyy / mmddyyyy — the keys a date-keyed reply uses. */
function keyIsDate(key: string, date: string): boolean {
	const [y, m, d] = date.split('-')
	const digits = key.replace(/\D/g, '')
	return digits === `${y}${m}${d}` || digits === `${d}${m}${y}` || digits === `${m}${d}${y}`
}

/** Breadth-first so the shallowest, least wrapped value wins. */
function search(root: unknown, found: Partial<Record<'firstIn' | 'lastOut' | 'totalHours', string>>): void {
	const queue: unknown[] = [root]
	while (queue.length) {
		const node = queue.shift()
		if (Array.isArray(node)) {
			queue.push(...node)
			continue
		}
		if (!node || typeof node !== 'object') continue
		for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
			const field = FIELDS.find((f) => f.match.test(k))
			if (field && !found[field.key] && !blankish(v)) found[field.key] = (v as string).trim()
			if (v && typeof v === 'object') queue.push(v)
		}
	}
}

/**
 * Pulls attendance out of whatever an internal endpoint returned. A reply keyed
 * by date (the report shape) is searched under today's key first, so a month of
 * days cannot answer for today.
 */
export function readJson(reply: unknown, date: string): PageAttendance {
	const found: Partial<Record<'firstIn' | 'lastOut' | 'totalHours', string>> = {}
	const today = [reply]
		.flatMap((r) => (r && typeof r === 'object' ? Object.entries(r as Record<string, unknown>) : []))
		.find(([k]) => keyIsDate(k, date))?.[1]
	// Today's own record is the only answer for today: falling back to the rest
	// of a month-long reply would borrow another day's check-out.
	search(today ?? reply, found)
	return {
		firstIn: found.firstIn ?? null,
		lastOut: found.lastOut ?? null,
		totalHours: found.totalHours ?? null,
		missing: FIELDS.filter((f) => !found[f.key]).map((f) => f.label),
	}
}

// ── the project and task catalogue ──────────────────────────────────────────
// Zoho lists jobs per project, which is why its own grid picks Project first
// and Task second. Both replies are searched by field name, like the
// attendance one, so a wrapper change does not break them.

export interface Named {
	id: string
	name: string
}

/** Every object under `reply` carrying both an id-ish and a name-ish key. */
function collect(reply: unknown, idKey: RegExp, nameKey: RegExp): Named[] {
	const out: Named[] = []
	const seen = new Set<string>()
	const queue: unknown[] = [reply]
	while (queue.length) {
		const node = queue.shift()
		if (Array.isArray(node)) {
			queue.push(...node)
			continue
		}
		if (!node || typeof node !== 'object') continue
		const entries = Object.entries(node as Record<string, unknown>)
		const id = entries.find(([k, v]) => idKey.test(k) && (typeof v === 'string' || typeof v === 'number'))
		const name = entries.find(([k, v]) => nameKey.test(k) && typeof v === 'string' && v.trim())
		if (id && name) {
			const key = String(id[1])
			if (!seen.has(key)) {
				seen.add(key)
				out.push({ id: key, name: (name[1] as string).trim() })
			}
		}
		for (const [, v] of entries) if (v && typeof v === 'object') queue.push(v)
	}
	return out
}

export const readProjects = (reply: unknown): Named[] => collect(reply, /^project_?id$/i, /^project_?name$/i)

export const readJobs = (reply: unknown): Named[] => collect(reply, /^job_?id$/i, /^job_?name$/i)

/**
 * Jobs with the project they belong to. Zoho sends the project name alongside
 * each job when asked with isClientDetailsNeeded, so one call with projectId=0
 * gives the whole "Project · Task" list the hourly prompt needs.
 */
export function readJobList(reply: unknown): { id: string; name: string; project: string }[] {
	const out: { id: string; name: string; project: string }[] = []
	const seen = new Set<string>()
	const queue: unknown[] = [reply]
	while (queue.length) {
		const node = queue.shift()
		if (Array.isArray(node)) {
			queue.push(...node)
			continue
		}
		if (!node || typeof node !== 'object') continue
		const o = node as Record<string, unknown>
		const entries = Object.entries(o)
		const id = entries.find(([k, v]) => /^job_?id$/i.test(k) && (typeof v === 'string' || typeof v === 'number'))
		const name = entries.find(([k, v]) => /^job_?name$/i.test(k) && typeof v === 'string' && v.trim())
		if (id && name && !seen.has(String(id[1]))) {
			seen.add(String(id[1]))
			const project = entries.find(([k, v]) => /^project_?name$/i.test(k) && typeof v === 'string' && v.trim())
			out.push({ id: String(id[1]), name: (name[1] as string).trim(), project: ((project?.[1] as string) ?? '').trim() })
		}
		for (const [, v] of entries) if (v && typeof v === 'object') queue.push(v)
	}
	return out
}

/** Asks a captured getJobs call for every job you have, not one project's. */
export function allProjects(body: string | undefined): string | undefined {
	if (!body) return body
	const params = new URLSearchParams(body)
	if (!params.has('projectId')) return body
	params.set('projectId', '0')
	params.set('getCurUserJobs', 'true')
	return params.toString()
}

/**
 * Which recorded call is which, by the mode Zoho puts in the body. Lets one
 * recording wire every source at once instead of picking them out by hand.
 */
export function classifyRequest(url: string, body?: string): 'attendance' | 'projects' | 'jobs' | 'timesheet' | null {
	const text = `${url}\n${body ?? ''}`
	if (writeLooking(url, body)) return null
	if (/mode=getStatus/i.test(text) && /AttendanceAction/i.test(url)) return 'attendance'
	if (/mode=getTimesheetProjectList/i.test(text)) return 'projects'
	if (/mode=getJobs/i.test(text)) return 'jobs'
	if (/mode=getTimesheet\b/i.test(text)) return 'timesheet'
	return null
}

// ── molding a captured write into our own ───────────────────────────────────
// A captured timesheet save is a template, not something to replay: the fields
// that identify you and your org (zp_formId, User_Name, loginUserZUID,
// zp_tableName) are kept exactly as Zoho sent them, and everything describing
// the work is replaced with ours. Anything we do not understand is left alone,
// which is why this survives Zoho adding fields.

export interface TimelogRow {
	date: string // IST yyyy-MM-dd
	minutes: number
	workItem: string
	description: string
	jobId?: string
	projectId?: string
	/** Exactly as Zoho's own form sends it; left as the template had it when absent. */
	billableStatus?: string
}

/** The fields we own. Everything else in the template is passed through. */
const OURS: Record<string, (r: TimelogRow) => string | undefined> = {
	Date: (r) => dmy(r.date),
	loggedHrs: (r) => hhmmFrom(r.minutes),
	Work_Item: (r) => r.workItem,
	// Zoho's own save leaves Description empty when the work item says it all;
	// repeating the same sentence twice in the timesheet helps nobody.
	Description: (r) => (r.description.trim() === r.workItem.trim() ? '' : r.description),
	JobId: (r) => r.jobId,
	Project: (r) => r.projectId,
	Billable_Status: (r) => r.billableStatus,
}

const dmy = (date: string) => {
	const [y, m, d] = date.split('-')
	return `${d}-${m}-${y}`
}

const hhmmFrom = (min: number) => {
	const m = Math.max(0, Math.round(min))
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * Turns the captured save into the one we want to make. Returns null when the
 * template is not a timesheet save, so a stray capture cannot be sent as one.
 */
export function timesheetBody(template: string | undefined, row: TimelogRow): string | null {
	if (!template) return null
	const params = new URLSearchParams(template)
	if (params.get('zp_tableName') !== 'P_Timesheet' || !/^(add|update)Record$/i.test(params.get('zp_mode') ?? '')) return null
	for (const [field, value] of Object.entries(OURS)) {
		const v = value(row)
		if (v !== undefined) params.set(field, v)
	}
	// A draft would not count towards your logged hours.
	params.set('isDraft', 'false')
	return params.toString()
}

/** Swaps the project a captured getJobs call asked about. */
export function withProject(body: string | undefined, projectId: string): string | undefined {
	if (!body) return body
	const params = new URLSearchParams(body)
	if (!params.has('projectId')) return body
	params.set('projectId', projectId)
	return params.toString()
}

/**
 * Zoho's web app drives attendance through one controller, where the mode makes
 * it read or punch (`AttendanceAction.zp?mode=punchIn`). WorkPulse must never
 * replay a write: every punch stays your own click, on this path too. Matched
 * against the URL *and* the body, since the mode often rides in the body.
 */
const WRITES = [
	/punch\s*(in|out)/i,
	/clock\s*(in|out)/i,
	/mark\s*attendance/i,
	/\w*(mode|action|operation)=(add|save|edit|update|modify|delete|remove|submit|approve|reject|cancel|import|punch)/i,
	/\/(add|save|update|delete|remove|submit|approve|reject|import)[A-Za-z]*(\.zp)?(\?|$)/i,
	/regulari[sz]/i,
]

/**
 * The punch endpoints, derived from the data centre rather than from a capture:
 * the reader may never replay a stored write, so the one write WorkPulse can do
 * is built here and used only from an explicit click.
 */
export const punchUrl = (dc: string, checkIn: boolean) => `https://people.zoho.${dc}/logiciel/AttendanceAction.zp?mode=punch${checkIn ? 'In' : 'Out'}`

/** The write pattern this request matches, for the UI to name, or null. */
export function writeLooking(url: string, body?: string): string | null {
	const text = `${url}\n${body ?? ''}`
	const hit = WRITES.find((re) => re.test(text))
	return hit ? (text.match(hit)?.[0] ?? 'a write').trim() : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Each date layout Zoho sends, with today written the same way. */
function layouts(date: string): [RegExp, string][] {
	const [y, m, d] = date.split('-')
	return [
		[/^\d{4}-\d{2}-\d{2}$/, `${y}-${m}-${d}`],
		[/^\d{2}-\d{2}-\d{4}$/, `${d}-${m}-${y}`],
		[/^\d{2}\/\d{2}\/\d{4}$/, `${d}/${m}/${y}`],
		[/^\d{4}\/\d{2}\/\d{2}$/, `${y}/${m}/${d}`],
		[/^\d{2}-[A-Za-z]{3}-\d{4}$/, `${d}-${MONTHS[+m - 1]}-${y}`],
	]
}

function redate(params: URLSearchParams, date: string): void {
	const shapes = layouts(date)
	for (const [k, v] of [...params]) {
		const hit = shapes.find(([shape]) => shape.test(v))
		if (hit) params.set(k, hit[1])
	}
}

/**
 * A captured request carries the day it was captured on. Rewrite every
 * date-looking value to `date`, keeping its layout, so one capture keeps
 * working daily. Epoch numbers are left alone: guessing what a bare number
 * means is worse than leaving it.
 */
export function datedUrl(url: string, date: string): string {
	let u: URL
	try {
		u = new URL(url)
	} catch {
		return url
	}
	redate(u.searchParams, date)
	return u.toString()
}

/** The same rewrite for a form-encoded body (where Zoho's POSTs keep the date). */
export function datedForm(body: string | undefined, date: string): string | undefined {
	if (!body || /[{[]/.test(body.trim()[0] ?? '')) return body
	const params = new URLSearchParams(body)
	redate(params, date)
	return params.toString()
}

/**
 * A page value is a clock time, not a date-time ("09:12 AM"), so it only means
 * something against a date. Full date-times (what the API returns) fall through
 * to the shared parser.
 */
export function timeOn(date: string, value: string | null | undefined): number | null {
	const t = (value ?? '').trim()
	const m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i)
	if (!m) return parseZohoDateTime(t)
	const ampm = m[3]?.toUpperCase()
	const h = ampm ? (ampm === 'PM' ? (+m[1] % 12) + 12 : +m[1] % 12) : +m[1]
	if (h > 23) return null
	return atIst(date, `${String(h).padStart(2, '0')}:${m[2]}`)
}

/**
 * Did Zoho accept the row?
 *
 * Its save answers HTTP 200 whether it worked or not — the verdict is in the
 * body: `{"pkId":"…","code":7000,"message":"Successfully Added"}`. Judging on
 * the status alone marks a refused row as logged, which is the worst outcome
 * there is: the timesheet is empty and WorkPulse says it is done.
 */
export function savedTimelog(status: number, body: string): { ok: boolean; message?: string } {
	if (status < 200 || status >= 300) return { ok: false, message: `HTTP ${status}` }
	const text = (body ?? '').trim()
	try {
		const json = JSON.parse(text) as { code?: number; message?: string }
		if (typeof json.code === 'number') {
			// 7000 is Zoho's own "Successfully Added" for this form.
			return json.code === 7000 ? { ok: true } : { ok: false, message: json.message ?? `Zoho code ${json.code}` }
		}
		if (json.message) return { ok: /success/i.test(json.message), message: json.message }
	} catch {
		// Not JSON: fall through to reading it as prose.
	}
	// An HTML error page, or a plain-text complaint.
	const refused = /error|invalid|not allowed|exceed|denied|fail/i.test(text.slice(0, 400))
	return refused ? { ok: false, message: text.slice(0, 160) } : { ok: true }
}
