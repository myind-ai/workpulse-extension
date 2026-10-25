import { describe, expect, it } from 'vitest'

import { periodReport, periodText, spanFrom, type PeriodInput } from './period'
import { parseIst } from './time'

let n = 0
const entry = (date: string, text: string, minutes: number, jobId?: string) => ({
	uid: `e${n++}`,
	synced: false,
	date,
	slotStart: parseIst(`${date}T10:00:00`),
	slotEnd: parseIst(`${date}T11:00:00`),
	text,
	minutes,
	kind: 'work' as const,
	jobId,
})

const input: PeriodInput = {
	entries: [
		entry('2026-04-02', 'PAY-2433: wrote the parser', 180),
		entry('2026-04-03', 'PAY-2433: the division lookup was wrong', 240),
		entry('2026-04-03', 'LEAP-12: the migration', 60),
		entry('2026-05-11', 'PAY-2433: shipped behind the flag', 120),
		entry('2026-09-30', 'Standup', 30, 'j1'),
		entry('2026-02-01', 'PAY-1: before the period', 600),
	],
	jobs: [{ id: 'j1', name: 'Platform', project: 'Core' }],
	tasks: [
		{ uid: 't1', title: 'Verify on staging', key: 'PAY-2433', status: 'done', doneAt: parseIst('2026-05-12T17:00:00'), createdAt: 0, kind: 'task' },
		{ uid: 't2', title: 'Still going', status: 'open', createdAt: 0, kind: 'task' },
	] as PeriodInput['tasks'],
	tickets: [{ name: 'PAY-2433 financing button' }, { name: 'LEAP-12 migration' }],
	learnings: [
		{ date: '2026-04-03', text: 'Resolve the division before the settings lookup', kind: 'mistake' },
		{ date: '2026-01-01', text: 'Before the period', kind: 'learning' },
	],
}

const r = periodReport(input, '2026-04-01', '2026-09-30', 'half')

describe('the six months nobody can remember', () => {
	it('should group by what the work was about, biggest first', () => {
		expect(r.lines.map((l) => l.label)).toEqual(['PAY-2433', 'LEAP-12', 'Platform'])
		expect(r.lines[0].minutes).toBe(540)
	})

	it('should count the days a thing ran across, not just the hours', () => {
		expect(r.lines[0].days).toBe(3)
		expect(r.lines[0].first).toBe('2026-04-02')
		expect(r.lines[0].last).toBe('2026-05-11')
	})

	it('should keep the words you used, without repeating the key in every line', () => {
		expect(r.lines[0].said).toEqual(['wrote the parser', 'the division lookup was wrong', 'shipped behind the flag'])
	})

	it('should call a ticket by the name you gave it', () => {
		expect(r.lines[0].name).toBe('PAY-2433 financing button')
	})

	it('should leave out everything outside the period', () => {
		expect(r.lines.some((l) => l.label === 'PAY-1')).toBe(false)
		expect(r.learnings).toHaveLength(1)
		expect(r.minutes).toBe(630)
		expect(r.daysWorked).toBe(4)
	})

	it('should say what the period was mostly about', () => {
		expect(r.headline.map((l) => l.label)).toEqual(['PAY-2433', 'LEAP-12', 'Platform'])
	})

	it('should list what was finished, newest first', () => {
		expect(r.finished).toEqual([{ title: 'Verify on staging', key: 'PAY-2433', at: '2026-05-12' }])
	})

	it('should measure a span back from today, both ends included', () => {
		expect(spanFrom('2026-10-15', 'week')).toBe('2026-10-09')
		expect(spanFrom('2026-10-15', 'half')).toBe('2026-04-17')
	})
})

describe('the document you paste into the form', () => {
	const text = periodText(r, 'markdown', 'Shantanu')

	it('should lead with the shape, not the log', () => {
		expect(text.indexOf('What it was mostly about')).toBeLessThan(text.indexOf('Everything, by what it was about'))
	})

	it('should carry the hours, the days and the period itself', () => {
		expect(text).toContain('2026-04-01 to 2026-09-30')
		expect(text).toContain('10h 30m logged over 4 days')
	})

	it('should say every line in the words they were written in', () => {
		expect(text).toContain('wrote the parser')
		expect(text).toContain('Resolve the division before the settings lookup')
	})

	it('should cap the detail under one heading rather than printing a log', () => {
		const many = { ...input, entries: Array.from({ length: 10 }, (_, i) => entry('2026-04-02', `PAY-9: thing ${i}`, 30)) }
		const long = periodText(periodReport(many, '2026-04-01', '2026-09-30', 'half'))
		expect(long).toContain('…and 4 more entries')
	})

	it('should say nothing rather than invent, when nothing was logged', () => {
		const empty = periodText(periodReport({ ...input, entries: [] }, '2026-04-01', '2026-09-30', 'half'))
		expect(empty).toContain('Nothing logged in this period.')
	})
})
