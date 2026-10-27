import { describe, expect, it } from 'vitest'

import { awayMinutes, awayNote, classify, classifyLocal, entryBlocks, groupEntries, hoursFromHHMM, parseZohoDateTime, rowsPerTask, scanRange, spanOf, splitRows, type DayReport } from './rules'
import { parseIst } from './time'
import type { Entry, Job } from './types'

const entry = (jobId: string | undefined, text: string, minutes: number, kind: Entry['kind'] = 'work'): Entry => ({
	uid: Math.random().toString(36),
	date: '2026-10-12',
	slotStart: parseIst('2026-10-12T09:00:00'),
	slotEnd: parseIst('2026-10-12T10:00:00'),
	text,
	jobId,
	minutes,
	kind,
	synced: false,
})

const report = (date: string, status: string, firstIn: string, lastOut: string, totalHours: string): DayReport => ({
	date,
	status,
	firstIn,
	lastOut,
	totalHours,
})
const WEEK = [1, 2, 3, 4, 5]

describe('groupEntries', () => {
	it('groups by job in order and dedupes text', () => {
		const rows = groupEntries(
			[
				entry('j1', 'webhook retries', 60),
				entry(undefined, 'standup', 30),
				entry('j1', 'webhook retries', 45),
				entry('j1', 'lunch', 60, 'break'),
				entry('j1', 'call', 0, 'skipped'),
			],
			[{ id: 'j1', name: 'Payments', project: '' }],
		)
		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({ jobName: 'Payments', minutes: 105, hours: 1.75, description: 'webhook retries' })
		expect(rows[1]).toMatchObject({ jobName: 'No job', hours: 0.5 })
	})

	it('falls back to the job id for unknown jobs', () => {
		const rows = groupEntries([entry('j9', 'x', 20)], [])
		expect(rows[0]).toMatchObject({ jobName: 'j9', hours: 0.33 })
	})
})

describe('classify', () => {
	it('flags the three regularisation cases and nothing else', () => {
		expect(classify(report('2026-10-05', 'Absent', '', '', '00:00'), 8, WEEK)?.kind).toBe('absent')
		expect(classify(report('2026-10-05', 'Present', '05-Oct-2026 09:10 AM', '-', '00:00'), 8, WEEK)?.kind).toBe('missing_checkout')
		expect(classify(report('2026-10-05', 'Present', '09:00', '15:30', '06:30'), 8, WEEK)).toEqual({ kind: 'short_hours', detail: '6.5h of 8h' })
		expect(classify(report('2026-10-05', 'Present', '09:00', '18:30', '09:30'), 8, WEEK)).toBeNull()
		expect(classify(report('2026-10-05', 'Sick', '', '', ''), 8, WEEK)).toBeNull()
		expect(classify(report('2026-10-05', 'Holiday', '', '', ''), 8, WEEK)).toBeNull()
		expect(classify(report('2026-10-10', 'Absent', '', '', ''), 8, WEEK)).toBeNull() // Saturday
	})
})

describe('scanRange', () => {
	it('reaches back to the previous month early in the month', () => {
		expect(scanRange('2026-10-20')).toEqual(['2026-10-01', '2026-10-19'])
		expect(scanRange('2026-10-03')).toEqual(['2026-09-01', '2026-10-02'])
		expect(scanRange('2026-01-01')).toEqual(['2025-12-01', '2025-12-31'])
	})
})

describe('hours and away spans', () => {
	it('parses both hour formats', () => {
		expect(hoursFromHHMM('08:30')).toBe(8.5)
		expect(hoursFromHHMM('7.25')).toBe(7.25)
		expect(hoursFromHHMM('')).toBe(0)
	})

	it('clips away spans to the slot and never double counts', () => {
		const t = parseIst
		const spans: [number, number][] = [
			[t('2026-10-12T12:40:00'), t('2026-10-12T14:05:00')],
			[t('2026-10-12T08:00:00'), t('2026-10-12T08:30:00')],
		]
		const from = t('2026-10-12T12:00:00')
		const to = t('2026-10-12T14:30:00')
		expect(awayMinutes(spans, from, to)).toBe(85)
		expect(awayNote(spans, from, to)).toBe('Away 12:40–14:05')
		expect(awayNote(spans, t('2026-10-12T15:00:00'), t('2026-10-12T16:00:00'))).toBeNull()
		const overlapping: [number, number][] = [
			[t('2026-10-12T12:00:00'), t('2026-10-12T13:00:00')],
			[t('2026-10-12T12:30:00'), t('2026-10-12T12:45:00')],
		]
		expect(awayMinutes(overlapping, from, to)).toBe(60)
	})
})

describe('parseZohoDateTime', () => {
	it('reads the punch formats Zoho uses', () => {
		const want = parseIst('2026-10-12T09:12:05')
		expect(parseZohoDateTime('12-10-2026 09:12:05')).toBe(want)
		expect(parseZohoDateTime('2026-10-12 09:12:05')).toBe(want)
		expect(parseZohoDateTime('12-Oct-2026 09:12 AM')).toBe(parseIst('2026-10-12T09:12:00'))
		expect(parseZohoDateTime('12-Oct-2026 06:45 PM')).toBe(parseIst('2026-10-12T18:45:00'))
		expect(parseZohoDateTime('-')).toBeNull()
	})
})

describe('how a day is cut into timesheet rows', () => {
	const jobs = [{ id: 'j1', name: 'Payment service', project: 'Checkout' }]
	const at = (hhmm: string) => parseIst(`2026-10-12T${hhmm}:00`)
	/** An hour of work, as the hourly prompt records it. */
	const hour = (from: string, text: string, minutes = 60, jobId: string | undefined = 'j1'): Entry => ({
		uid: from,
		date: '2026-10-12',
		slotStart: at(from),
		slotEnd: at(from) + minutes * 60_000,
		text,
		jobId,
		minutes,
		kind: 'work',
		synced: false,
	})

	const day = [
		hour('09:00', 'Daily meeting and release planning'),
		hour('10:00', 'Testing QA RC and the dependabot ticket'),
		hour('11:00', 'PII data in logs, found while testing the lender errors'),
		hour('12:00', 'Tested CRM QA RC PAY-2930'),
	]

	it('should leave one row when nothing needs cutting', () => {
		const out = splitRows(day, jobs, 0)
		expect(out).toHaveLength(1)
		expect(out[0].minutes).toBe(240)
	})

	it('should give each row the work that actually happened in it', () => {
		// The bug this replaced: four rows of an hour each, all carrying the same
		// merged description, which says everything and means nothing.
		const out = splitRows(day, jobs, 60)
		expect(out.map((r) => [r.minutes, r.description])).toEqual([
			[60, 'Daily meeting and release planning'],
			[60, 'Testing QA RC and the dependabot ticket'],
			[60, 'PII data in logs, found while testing the lender errors'],
			[60, 'Tested CRM QA RC PAY-2930'],
		])
	})

	it('should put both halves of an hour in the same row when the rows are longer', () => {
		const out = splitRows(day, jobs, 120)
		expect(out.map((r) => r.minutes)).toEqual([120, 120])
		expect(out[0].description).toBe('Daily meeting and release planning; Testing QA RC and the dependabot ticket')
		expect(out[1].description).toBe('PII data in logs, found while testing the lender errors; Tested CRM QA RC PAY-2930')
	})

	it('should keep a task longer than the cap as one row, never cut it into copies', () => {
		const out = splitRows([hour('09:00', 'Long debugging session', 90)], jobs, 60)
		expect(out.map((r) => [r.minutes, r.description])).toEqual([[90, 'Long debugging session']])
	})

	it('should never lose or invent a minute', () => {
		for (const [minutes, max] of [
			[245, 120],
			[100, 30],
			[61, 60],
			[7, 2],
		]) {
			const out = splitRows([hour('09:00', 'x', minutes), hour('15:00', 'y', 30)], jobs, max)
			expect(out.reduce((a, r) => a + r.minutes, 0)).toBe(minutes + 30)
			// Over the cap only when a single task is longer than it.
			expect(out.every((r) => r.minutes <= max || !r.description.includes(';'))).toBe(true)
		}
	})

	it('should start a new row when the next task would go over the cap', () => {
		const tasks = [hour('09:00', 'Review', 30), hour('09:30', 'Fix', 60), hour('10:30', 'Tests', 30)]
		expect(splitRows(tasks, jobs, 90).map((r) => [r.minutes, r.description])).toEqual([[90, 'Review; Fix'], [30, 'Tests']])
	})

	it('should cut each job separately, in the order they first appear', () => {
		const mixed = [hour('09:00', 'Payments work'), hour('10:00', 'Platform work', 60, 'j2'), hour('11:00', 'More payments')]
		const out = splitRows(mixed, [...jobs, { id: 'j2', name: 'Platform', project: 'Core' }], 60)
		expect(out.map((r) => [r.jobName, r.description])).toEqual([
			['Payment service', 'Payments work'],
			['Payment service', 'More payments'],
			['Platform', 'Platform work'],
		])
	})

	it('should leave breaks and empty entries out of the rows', () => {
		const withBreak: Entry[] = [hour('09:00', 'Work'), { ...hour('13:00', 'Lunch / break', 0), kind: 'break' }]
		expect(splitRows(withBreak, jobs, 60)).toHaveLength(1)
	})

	it('should say "No job" for work logged against none', () => {
		// Passing `undefined` would take the default, so the field is cleared.
		const noJob: Entry = { ...hour('09:00', 'Unassigned'), jobId: undefined }
		expect(splitRows([noJob], jobs, 60)[0].jobName).toBe('No job')
	})

	it('should give each task its own row when that is what you want', () => {
		const entries = [
			{ uid: 'a', date: '2026-10-12', slotStart: 1, slotEnd: 2, text: 'Reviewed the PR', minutes: 60, kind: 'work' as const, synced: false, jobId: 'j1' },
			{ uid: 'b', date: '2026-10-12', slotStart: 3, slotEnd: 4, text: 'Lunch', minutes: 0, kind: 'break' as const, synced: false },
			{ uid: 'c', date: '2026-10-12', slotStart: 5, slotEnd: 6, text: 'Fixed the retry bug', minutes: 45, kind: 'work' as const, synced: false, jobId: 'j1' },
		]
		const rows = rowsPerTask(entries, [{ id: 'j1', name: 'Payment service', project: 'Checkout' }])
		expect(rows.map((r) => [r.description, r.minutes])).toEqual([
			['Reviewed the PR', 60],
			['Fixed the retry bug', 45],
		])
	})
})

describe('a day whose times are wrong, not short', () => {
	const t = (at: number) => new Date(at).toISOString().slice(11, 16)

	it('should not report a check-out before the check-in as negative hours', () => {
		// Seen in the wild: "Short hours · -1h -35m of 8h on the clock".
		const day = { date: '2026-10-14', checkedInAt: parseIst('2026-10-14T10:35:00'), checkedOutAt: parseIst('2026-10-14T09:00:00'), isOff: false }
		const c = classifyLocal(day, 0, 8, [1, 2, 3, 4, 5], t)
		expect(c?.kind).toBe('missing_checkout')
		expect(c?.detail).toMatch(/before the .* check-in/)
		expect(c?.detail).not.toMatch(/-\d/) // never "-1h -35m"
	})

	it('should never print a negative duration anywhere', () => {
		const day = { date: '2026-10-14', checkedInAt: parseIst('2026-10-14T10:00:00'), checkedOutAt: parseIst('2026-10-14T10:30:00'), isOff: false }
		expect(classifyLocal(day, 0, 8, [1, 2, 3, 4, 5], t)?.detail).toBe('0h 30m of 8h on the clock')
	})

	it('should still call a genuinely short day short', () => {
		const day = { date: '2026-10-14', checkedInAt: parseIst('2026-10-14T09:00:00'), checkedOutAt: parseIst('2026-10-14T12:00:00'), isOff: false }
		expect(classifyLocal(day, 0, 8, [1, 2, 3, 4, 5], t)).toMatchObject({ kind: 'short_hours', detail: '3h of 8h on the clock' })
	})
})

describe('a meeting is its own line on the timesheet', () => {
	const e = (over: Partial<Entry>): Entry => ({
		uid: String(Math.random()), date: '2026-10-21', slotStart: 0, slotEnd: 0,
		text: 'x', minutes: 60, kind: 'work', synced: false, ...over,
	})
	const jobs = [{ id: 'J1', name: 'Engineering' } as Job]
	const standup = e({ text: 'Daily standup', minutes: 15, jobId: 'J1', auto: true, meetingId: 'm1', slotStart: 1 })
	const work = e({ text: 'LEAP-19 webhook retry', minutes: 120, jobId: 'J1', slotStart: 2 })

	it('should not swallow a meeting into the job it shares', () => {
		const rows = groupEntries([standup, work], jobs)
		expect(rows).toHaveLength(2)
		expect(rows.find((r) => r.description === 'Daily standup')?.minutes).toBe(15)
		expect(rows.find((r) => r.description === 'LEAP-19 webhook retry')?.minutes).toBe(120)
	})

	it('should keep the meeting on its job, so it still pushes to the right one', () => {
		const meeting = groupEntries([standup, work], jobs).find((r) => r.description === 'Daily standup')
		expect(meeting?.jobId).toBe('J1')
		expect(meeting?.jobName).toBe('Engineering')
	})

	it('should keep two different meetings apart from each other', () => {
		const other = e({ text: 'Sprint review', minutes: 60, jobId: 'J1', meetingId: 'm2' })
		expect(groupEntries([standup, other, work], jobs)).toHaveLength(3)
	})

	it('should still group ordinary work by job, as it always did', () => {
		const more = e({ text: 'more webhook', minutes: 30, jobId: 'J1' })
		const rows = groupEntries([work, more], jobs)
		expect(rows).toHaveLength(1)
		expect(rows[0].minutes).toBe(150)
	})

	it('should keep a meeting separate when the rows are split too', () => {
		const rows = splitRows([standup, work], jobs, 60)
		const meeting = rows.filter((r) => r.description === 'Daily standup')
		expect(meeting).toHaveLength(1)
		expect(meeting[0].minutes).toBe(15)
		expect(meeting[0].jobName).toBe('Engineering')
		// The 120 minutes on one task stay one row: the cap never cuts a task.
		expect(rows.filter((r) => r.description.includes('webhook')).map((r) => r.minutes)).toEqual([120])
	})
})

describe('the same task in several hours', () => {
	const jobs: Job[] = [{ id: 'j1', name: 'Payment service', project: 'Checkout' }, { id: 'j2', name: 'Internal', project: 'Ops' }]
	let n = 0
	const at = (time: string, text: string, jobId = 'j1', minutes = 60): Entry => ({
		uid: `u${n++}`, date: '2026-10-12', slotStart: parseIst(`2026-10-12T${time}:00`), slotEnd: parseIst(`2026-10-12T${time}:00`) + 3_600_000, text, jobId, minutes, kind: 'work', synced: false,
	})

	it('is one row whose time grows: 1 h, then 2 h, then 3 h', () => {
		const day = [at('09:00', 'LEAP-19 webhook retry')]
		expect(rowsPerTask(day, jobs).map((r) => [r.description, r.minutes])).toEqual([['LEAP-19 webhook retry', 60]])
		day.push(at('10:00', 'LEAP-19 webhook retry'))
		expect(rowsPerTask(day, jobs).map((r) => [r.description, r.minutes])).toEqual([['LEAP-19 webhook retry', 120]])
		day.push(at('11:00', 'leap-19  webhook retry.'))
		expect(rowsPerTask(day, jobs).map((r) => [r.description, r.hours])).toEqual([['LEAP-19 webhook retry', 3]])
	})

	it('counts "same" and "continued" as the task before, in the same job', () => {
		const day = [at('09:00', 'Payment retry fix'), at('10:00', 'Daily standup', 'j2', 30), at('10:30', 'same', 'j1', 30), at('11:00', 'continued')]
		expect(rowsPerTask(day, jobs).map((r) => [r.jobName, r.description, r.minutes])).toEqual([
			['Payment service', 'Payment retry fix', 150],
			['Internal', 'Daily standup', 30],
		])
	})

	it('keeps different tasks, and the same words under another job, apart, in the order started', () => {
		const day = [at('09:00', 'Code review'), at('10:00', 'Retry fix'), at('11:00', 'Code review'), at('12:00', 'Code review', 'j2')]
		expect(rowsPerTask(day, jobs).map((r) => [r.jobId, r.description, r.minutes])).toEqual([
			['j1', 'Code review', 120],
			['j1', 'Retry fix', 60],
			['j2', 'Code review', 60],
		])
	})

	it('names a repeated task once in a job row, and never writes "same"', () => {
		const day = [at('09:00', 'Retry fix'), at('10:00', 'Retry fix.'), at('11:00', 'same as last hour'), at('12:00', 'Tests')]
		expect(groupEntries(day, jobs)[0]).toMatchObject({ minutes: 240, description: 'Retry fix; Tests' })
		expect(splitRows(day, jobs, 0)[0]).toMatchObject({ minutes: 240, description: 'Retry fix; Tests' })
		// Capped at 2 h, the 3 h retry fix is still one row, never cut into copies.
		expect(splitRows(day, jobs, 120).map((r) => [r.description, r.minutes])).toEqual([['Retry fix', 180], ['Tests', 60]])
	})

	it('leaves "same" alone when nothing came before it', () => {
		expect(rowsPerTask([at('09:00', 'same')], jobs)[0].description).toBe('same')
	})
})

describe('real times and the day as blocks', () => {
	const jobs: Job[] = [{ id: 'j1', name: 'Payment service', project: 'Checkout' }]
	let n = 0
	const at = (time: string, text: string, minutes = 60, over: Partial<Entry> = {}): Entry => ({
		uid: `b${n++}`, date: '2026-10-12', slotStart: parseIst(`2026-10-12T${time}:00`), slotEnd: parseIst(`2026-10-12T${time}:00`) + 3_600_000, text, jobId: 'j1', minutes, kind: 'work', synced: false, ...over,
	})

	it('gives a row from and to when its hours are one unbroken, fully claimed stretch', () => {
		const day = [at('10:00', 'Retry fix'), at('11:00', 'Retry fix'), at('12:00', 'same as last hour')]
		const [row] = rowsPerTask(day, jobs)
		expect([row.minutes, row.from, row.to]).toEqual([180, parseIst('2026-10-12T10:00:00'), parseIst('2026-10-12T13:00:00')])
		expect(splitRows(day, jobs, 60)[0]).toMatchObject({ from: parseIst('2026-10-12T10:00:00'), to: parseIst('2026-10-12T13:00:00') })
	})

	it('gives no times across a gap, or when an hour is only partly claimed', () => {
		expect(spanOf([at('10:00', 'A'), at('12:00', 'A')])).toBeUndefined()
		expect(spanOf([at('10:00', 'A', 45)])).toBeUndefined()
		const gap = rowsPerTask([at('10:00', 'A'), at('14:00', 'A')], jobs)[0]
		expect([gap.minutes, gap.from]).toEqual([120, undefined])
	})

	it('shows back-to-back hours of one task as one line, and breaks it where the task changes', () => {
		const day = [
			at('10:00', 'Retry fix'), at('11:00', 'retry fix.'), at('12:00', 'same as last hour'),
			at('13:00', 'Lunch', 0, { kind: 'break' }),
			at('14:00', 'Retry fix'), at('15:00', 'Code review'),
			at('16:00', 'Code review', 60, { synced: true }),
		]
		expect(entryBlocks(day).map((b) => [b.text, b.uids.length, b.minutes])).toEqual([
			['Retry fix', 3, 180],
			['Lunch', 1, 0],
			['Retry fix', 1, 60],
			['Code review', 1, 60],
			['Code review', 1, 60],
		])
		expect(entryBlocks(day)[0].slotEnd).toBe(parseIst('2026-10-12T13:00:00'))
	})
})
