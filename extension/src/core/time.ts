// IST time helpers. India has no DST, so a fixed +05:30 offset is exact and
// every function works the same whatever the computer's own time zone is.

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
export const IST_OFFSET = 330 * MIN

const pad = (n: number) => String(n).padStart(2, '0')

/** A Date whose UTC fields read as IST wall-clock fields. */
const shifted = (ms: number) => new Date(ms + IST_OFFSET)

export function istDate(ms: number): string {
	const d = shifted(ms)
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function istTime(ms: number): string {
	const d = shifted(ms)
	return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function istDateTime(ms: number): string {
	const d = shifted(ms)
	return `${istDate(ms)}T${istTime(ms)}:${pad(d.getUTCSeconds())}`
}

/** 1 = Monday … 7 = Sunday, in IST. */
export function istWeekday(ms: number): number {
	const w = shifted(ms).getUTCDay()
	return w === 0 ? 7 : w
}

/** Epoch ms for a wall-clock IST date and "HH:MM". */
export function atIst(date: string, hhmm: string): number {
	const [y, m, d] = date.split('-').map(Number)
	const [h, mi] = hhmm.split(':').map(Number)
	return Date.UTC(y, m - 1, d, h, mi) - IST_OFFSET
}

/** Parses "YYYY-MM-DDTHH:MM[:SS]" as IST. */
export function parseIst(s: string): number {
	const [date, time = '00:00'] = s.split('T')
	const [hh, mm, ss = '0'] = time.split(':')
	return atIst(date, `${hh}:${mm}`) + Number(ss) * 1000
}

export function addDays(date: string, n: number): string {
	return istDate(atIst(date, '12:00') + n * DAY)
}

export function isHHMM(s: string): boolean {
	return /^([01]\d|2[0-3]):[0-5]\d$/.test(s.trim())
}

/** "Mon 12 Oct" */
export function prettyDate(date: string): string {
	const ms = atIst(date, '12:00')
	const d = shifted(ms)
	const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
	return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`
}

/** 95 → "1h 35m" */
/**
 * Minutes as Zoho writes them: "02:00", "00:50". Both the API's `hours` field
 * and the web app's `loggedHrs` accept this, and unlike decimal hours it is
 * exact — 50 minutes is 00:50, not 0.83 of an hour.
 */
export function hhmm(min: number): string {
	const m = Math.max(0, Math.round(min))
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function fmtMinutes(min: number): string {
	const m = Math.max(0, Math.round(min))
	const h = Math.floor(m / 60)
	const r = m % 60
	if (h === 0) return `${r}m`
	return r === 0 ? `${h}h` : `${h}h ${r}m`
}
