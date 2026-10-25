// Reading a time someone else wrote, in your own clock. "3pm PST", "15:00 UTC",
// "tomorrow 9:30 AM EST" — parsed, then converted.
//
// No tzdata ships with this: Intl already carries the zone rules, including the
// DST change dates, so the whole job is reading a zone's offset at an instant
// and inverting it. Pure, because an hour out is a missed meeting.

/** Abbreviations people actually type, mapped to the zone they mean. */
export const ZONE_NAMES: Record<string, string> = {
	UTC: 'UTC',
	GMT: 'Etc/GMT',
	Z: 'UTC',
	IST: 'Asia/Kolkata',
	PST: 'America/Los_Angeles',
	PDT: 'America/Los_Angeles',
	PT: 'America/Los_Angeles',
	MST: 'America/Denver',
	MDT: 'America/Denver',
	MT: 'America/Denver',
	CST: 'America/Chicago',
	CDT: 'America/Chicago',
	CT: 'America/Chicago',
	EST: 'America/New_York',
	EDT: 'America/New_York',
	ET: 'America/New_York',
	BST: 'Europe/London',
	CET: 'Europe/Berlin',
	CEST: 'Europe/Berlin',
	EET: 'Europe/Athens',
	EEST: 'Europe/Athens',
	MSK: 'Europe/Moscow',
	GST: 'Asia/Dubai',
	PKT: 'Asia/Karachi',
	BDT: 'Asia/Dhaka',
	ICT: 'Asia/Bangkok',
	SGT: 'Asia/Singapore',
	MYT: 'Asia/Kuala_Lumpur',
	HKT: 'Asia/Hong_Kong',
	PHT: 'Asia/Manila',
	JST: 'Asia/Tokyo',
	KST: 'Asia/Seoul',
	AEST: 'Australia/Sydney',
	AEDT: 'Australia/Sydney',
	AWST: 'Australia/Perth',
	NZST: 'Pacific/Auckland',
	NZDT: 'Pacific/Auckland',
	WAT: 'Africa/Lagos',
	CAT: 'Africa/Harare',
	EAT: 'Africa/Nairobi',
	SAST: 'Africa/Johannesburg',
	BRT: 'America/Sao_Paulo',
	ART: 'America/Argentina/Buenos_Aires',
	AST: 'America/Halifax',
	NST: 'America/St_Johns',
	AKST: 'America/Anchorage',
	HST: 'Pacific/Honolulu',
}

/** A short list to choose from, for people who do not know their IANA name. */
export const COMMON_ZONES = [
	'Asia/Kolkata',
	'Asia/Dubai',
	'Asia/Singapore',
	'Asia/Tokyo',
	'Australia/Sydney',
	'Europe/London',
	'Europe/Berlin',
	'Europe/Moscow',
	'America/New_York',
	'America/Chicago',
	'America/Denver',
	'America/Los_Angeles',
	'America/Sao_Paulo',
	'Africa/Johannesburg',
	'UTC',
]

const cache = new Map<string, Intl.DateTimeFormat>()

function parts(zone: string, at: number): Intl.DateTimeFormatPart[] | null {
	try {
		let f = cache.get(zone)
		if (!f) {
			f = new Intl.DateTimeFormat('en-US', {
				timeZone: zone,
				hourCycle: 'h23',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			})
			cache.set(zone, f)
		}
		return f.formatToParts(at)
	} catch {
		return null // not a zone this browser knows
	}
}

const pick = (p: Intl.DateTimeFormatPart[], type: string) => Number(p.find((x) => x.type === type)?.value ?? NaN)

/**
 * Minutes east of UTC for `zone` at that instant — so +330 for India, and -420
 * or -480 for Los Angeles depending on the date. `null` if the zone is unknown.
 */
export function zoneOffset(zone: string, at: number): number | null {
	const fixed = fixedOffset(zone)
	if (fixed != null) return fixed
	const p = parts(zone, at)
	if (!p) return null
	const asUtc = Date.UTC(pick(p, 'year'), pick(p, 'month') - 1, pick(p, 'day'), pick(p, 'hour'), pick(p, 'minute'))
	return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000)
}

/** "UTC+5:30", "GMT-8", "+0530" — an offset written out rather than named. */
export function fixedOffset(name: string): number | null {
	const m = name.trim().match(/^(?:UTC|GMT)?\s*([+-])(\d{1,2}):?(\d{2})?$/i)
	if (!m) return null
	const sign = m[1] === '-' ? -1 : 1
	const hours = Number(m[2])
	const mins = Number(m[3] ?? 0)
	return hours > 14 || mins > 59 ? null : sign * (hours * 60 + mins)
}

/** The zone an abbreviation, an IANA name or a written offset refers to. */
export function resolveZone(name: string): string | null {
	const t = (name ?? '').trim()
	if (!t) return null
	if (fixedOffset(t) != null) return t.toUpperCase().replace(/\s+/g, '')
	const abbrev = ZONE_NAMES[t.toUpperCase()]
	if (abbrev) return abbrev
	return parts(t, 0) ? t : null
}

export interface FoundDate {
	year?: number
	month: number
	day: number
}

export interface FoundTime {
	/** What was matched, as written. */
	text: string
	hour: number
	minute: number
	/** The zone as written, when one was given. */
	zone?: string
	/** "tomorrow" → 1, "yesterday" → -1. Ignored when a date was given. */
	dayOffset: number
	/** The date it was written against, when there was one. */
	date?: FoundDate
}

const MONTHS: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
	january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

const DATES = [
	/\b(\d{4})-(\d{2})-(\d{2})\b/, // 2026-10-12
	// `(?!\d)` stops "Oct 2026" from reading as the 20th of October.
	/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:,?\s*(\d{4}))?/, // Oct 12, 2026
	/\b(\d{1,2})(?:st|nd|rd|th)?(?!\d)\s+([A-Za-z]{3,9})\.?(?:,?\s*(\d{4}))?/, // 12 Oct 2026
	/\b(\d{1,2})[/](\d{1,2})[/](\d{4})\b/, // 12/10/2026, only when one part settles it
]

/** A date with where it sat in the text, so the time scan can skip over it. */
export type DatedMatch = FoundDate & { index: number; length: number }

/** The date a time was written against, with the text it took up. */
export function findDate(text: string): DatedMatch | null {
	const src = text ?? ''
	for (const [i, re] of DATES.entries()) {
		const m = src.match(re)
		if (!m || m.index == null) continue
		const found = readDate(i, m)
		if (found) return { ...found, index: m.index, length: m[0].length }
	}
	return null
}

function readDate(kind: number, m: RegExpMatchArray): FoundDate | null {
	const num = (x?: string) => (x == null ? undefined : Number(x))
	if (kind === 0) return { year: num(m[1]), month: num(m[2])!, day: num(m[3])! }
	if (kind === 1 || kind === 2) {
		const name = (kind === 1 ? m[1] : m[2]).toLowerCase()
		const month = MONTHS[name]
		const day = num(kind === 1 ? m[2] : m[1])!
		return month && day >= 1 && day <= 31 ? { year: num(m[3]), month, day } : null
	}
	// 12/10/2026 is read day-first in most of the world and month-first in the
	// US, so it is only trusted when one of the two numbers cannot be a month.
	const a = num(m[1])!
	const b = num(m[2])!
	if (a > 12 && b <= 12) return { year: num(m[3]), month: b, day: a }
	if (b > 12 && a <= 12) return { year: num(m[3]), month: a, day: b }
	return null
}

// A bare "5" is not a time, so one of these has to be there: minutes after a
// colon, am/pm, or a zone. Otherwise every price and page number would light up.
// `17.44` counts only when am/pm or a zone follows it, so a version number does
// not read as half past five.
const TIME =
	/(\d{1,2})(?:([:.])(\d{2})(?::\d{2})?)?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:((?:UTC|GMT)\s?[+\-\u2212]\d{1,2}(?::?\d{2})?|[+\-\u2212]\d{2}:?\d{2})|\(?\b(UTC|GMT|Z|[A-Z]{2,5})\b\)?)?/gi

export function findTime(text: string): FoundTime | null {
	const src = (text ?? '').trim()
	if (!src) return null

	// The date is taken out of the way first: "Oct 12, 17:44" would otherwise
	// offer "12" as the time and stop there.
	const date = findDate(src)
	const rest = date ? `${src.slice(0, date.index)}${' '.repeat(date.length)}${src.slice(date.index + date.length)}` : src

	TIME.lastIndex = 0
	for (let m = TIME.exec(rest); m; m = TIME.exec(rest)) {
		const found = readTime(m, src, date)
		if (found) return found
		if (m.index === TIME.lastIndex) TIME.lastIndex++ // never spin on an empty match
	}
	return null
}

function readTime(m: RegExpMatchArray, src: string, date: DatedMatch | null): FoundTime | null {
	const [all, h, sep, min, ampm, offset, named] = m
	const zoneText = (offset ?? named)?.replace(/\u2212/g, '-')
	const zone = zoneText ? (resolveZone(zoneText) ?? undefined) : undefined
	const clock = sep === ':' && min != null
	if (!clock && !ampm && !zone) return null
	if (sep === '.' && !ampm && !zone) return null // a version number, not a time

	let hour = Number(h)
	if (hour > 23 || Number(min ?? 0) > 59) return null
	if (ampm) {
		if (hour > 12) return null
		hour = ampm.toLowerCase().startsWith('p') ? (hour % 12) + 12 : hour % 12
	}

	const lower = src.toLowerCase()
	const dayOffset = date ? 0 : lower.includes('tomorrow') ? 1 : lower.includes('yesterday') ? -1 : 0
	const written = date ? `${src.slice(date.index, date.index + date.length)} ${all.trim()}` : all.trim()
	return { text: written.replace(/\s+/g, ' '), hour, minute: Number(min ?? 0), zone: zoneText && zone ? zone : undefined, dayOffset, date: date ?? undefined }
}

/**
 * The instant that time-of-day falls on, read in `from` and anchored to the day
 * `now` is in there. Offsets are applied twice: the first pass can land on the
 * wrong side of a DST change, and the second settles it.
 */
export function instantOf(found: Pick<FoundTime, 'hour' | 'minute' | 'dayOffset' | 'date'>, from: string, now: number): number | null {
	const p = parts(from, now) ?? (fixedOffset(from) != null ? parts('UTC', now + fixedOffset(from)! * 60_000) : null)
	if (!p) return null
	// A date that was written wins; a year that was not written is this one.
	const wall = found.date
		? Date.UTC(found.date.year ?? pick(p, 'year'), found.date.month - 1, found.date.day, found.hour, found.minute)
		: Date.UTC(pick(p, 'year'), pick(p, 'month') - 1, pick(p, 'day') + found.dayOffset, found.hour, found.minute)
	let at = wall - (zoneOffset(from, now) ?? 0) * 60_000
	const settled = zoneOffset(from, at)
	if (settled != null) at = wall - settled * 60_000
	return at
}

/** "4:30 PM" in that zone. */
export function timeIn(at: number, zone: string): string {
	const z = fixedOffset(zone) != null ? 'UTC' : zone
	const shift = fixedOffset(zone) != null ? fixedOffset(zone)! * 60_000 : 0
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: z, hour: 'numeric', minute: '2-digit' }).format(at + shift)
	} catch {
		return '—'
	}
}

/**
 * "Wed 15 Oct" in that zone — always, because the date is half the answer. The
 * year is added when it is not the one `reference` is in.
 */
export function dayIn(at: number, zone: string, reference?: number): string {
	const z = fixedOffset(zone) != null ? 'UTC' : zone
	const shift = fixedOffset(zone) != null ? fixedOffset(zone)! * 60_000 : 0
	try {
		const year = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: z, year: 'numeric' }).format(ms + shift)
		const far = reference != null && year(at) !== year(reference)
		// en-GB adds a comma once the year is in: "Mon, 4 Jan 2027". Not wanted.
		return new Intl.DateTimeFormat('en-GB', { timeZone: z, weekday: 'short', day: 'numeric', month: 'short', ...(far ? { year: 'numeric' } : {}) })
			.format(at + shift)
			.replace(',', '')
	} catch {
		return ''
	}
}

/** "+5h 30m behind/ahead" — how far apart two zones are at that instant. */
export function zoneGap(from: string, to: string, at: number): string {
	const a = zoneOffset(from, at)
	const b = zoneOffset(to, at)
	if (a == null || b == null) return ''
	const diff = b - a
	if (!diff) return 'same time'
	const h = Math.floor(Math.abs(diff) / 60)
	const m = Math.abs(diff) % 60
	return `${h ? `${h}h` : ''}${h && m ? ' ' : ''}${m ? `${m}m` : ''} ${diff > 0 ? 'ahead' : 'behind'}`
}

/** The zone this browser is set to, for the first run. */
export function localZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'
	} catch {
		return 'Asia/Kolkata'
	}
}

export interface ZoneRow {
	zone: string
	/** Short name for the zone: "Kolkata", "Los Angeles", "UTC+2". */
	label: string
	time: string
	/** The date there — "Mon 12 Oct", with the year when it is not this one. */
	day: string
	/** True when that is not the same day it is for you. */
	otherDay: boolean
	mine: boolean
}

export interface Conversion {
	/** What was read, as written: "3pm PST". */
	read: string
	/** The zone it was read in, and whether that was assumed. */
	from: string
	assumedZone: boolean
	at: number
	rows: ZoneRow[]
}

/** "Asia/Kolkata" → "Kolkata", "UTC+5:30" → "UTC+5:30". */
export function zoneLabel(zone: string): string {
	return zone.includes('/') ? zone.split('/').pop()!.replace(/_/g, ' ') : zone
}

/**
 * A selected time, in your zone and the zones you care about. A time written
 * without one is read as the writer's — which, lacking anything better, is
 * taken to be yours.
 */
export function explain(text: string, mine: string, others: string[], now: number): Conversion | null {
	const found = findTime(text)
	if (!found) return null
	const from = found.zone ?? mine
	const at = instantOf(found, from, now)
	if (at == null) return null
	const zones = [mine, ...others.filter((z) => z !== mine), ...(from !== mine && !others.includes(from) ? [from] : [])]
	return {
		read: found.text,
		from,
		assumedZone: !found.zone,
		at,
		rows: zones
			.filter((z) => zoneOffset(z, at) != null)
			.map((z) => ({ zone: z, label: zoneLabel(z), time: timeIn(at, z), day: dayIn(at, z, now), otherDay: dayIn(at, z, now) !== dayIn(at, mine, now), mine: z === mine })),
	}
}
