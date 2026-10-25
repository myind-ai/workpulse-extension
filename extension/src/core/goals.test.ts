import { describe, expect, it } from 'vitest'

import { cleanupMinutes, datesIn, goalTitle, monthKey, plannedActual, progress, quickWins, startOfWeek, switchNote, switches, weekKey, type ProgressInput } from './goals'
import { parseIst } from './time'
import type { Entry } from './types'

const jobName = (id: string) => ({ j1: 'Payments', j2: 'Platform' })[id] ?? id

const entry = (date: string, from: string, text: string, minutes: number, jobId?: string): Entry => ({
	uid: `${date}${from}${text}`,
	date,
	slotStart: parseIst(`${date}T${from}:00`),
	slotEnd: parseIst(`${date}T${from}:00`) + minutes * 60_000,
	text,
	jobId,
	minutes,
	kind: 'work',
	synced: false,
})

describe('which week and month a day belongs to', () => {
	it('should start a week on Monday', () => {
		expect(startOfWeek('2026-10-13')).toBe('2026-10-12') // Tuesday → Monday
		expect(startOfWeek('2026-10-12')).toBe('2026-10-12')
		expect(startOfWeek('2026-10-11')).toBe('2026-10-05') // Sunday belongs to the week before
	})

	it('should give every day of the same week the same key', () => {
		expect(weekKey('2026-10-12')).toBe(weekKey('2026-10-16'))
		expect(weekKey('2026-10-12')).not.toBe(weekKey('2026-10-19'))
		expect(weekKey('2026-10-12')).toMatch(/^2026-W\d\d$/)
	})

	it('should take the month from the date', () => {
		expect(monthKey('2026-10-13')).toBe('2026-10')
	})

	it('should list the days of a week and of a month', () => {
		expect(datesIn('week', '2026-10-13')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'])
		expect(datesIn('month', '2026-10-13')).toHaveLength(31)
		expect(datesIn('month', '2026-02-10')).toHaveLength(28)
	})

	it('should name itself the way a person would', () => {
		expect(goalTitle('week', '2026-10-13')).toBe('Week of 12 Oct')
		expect(goalTitle('month', '2026-10-13')).toBe('October 2026')
	})
})

describe('what a stretch of days amounted to', () => {
	const input = (patch: Partial<ProgressInput> = {}): ProgressInput => ({
		dates: datesIn('week', '2026-10-13'),
		today: '2026-10-14',
		workDays: [1, 2, 3, 4, 5],
		entries: [
			entry('2026-10-12', '09:00', 'PAY-2433 parser', 120, 'j1'),
			entry('2026-10-13', '09:00', 'PAY-2433 review', 60, 'j1'),
			entry('2026-10-13', '11:00', 'deploy checks', 30, 'j2'),
			entry('2026-10-19', '09:00', 'next week', 60, 'j1'),
		],
		days: [{ date: '2026-10-12', checkedInAt: 1 }, { date: '2026-10-13', checkedInAt: 1 }, { date: '2026-10-19', checkedInAt: 1 }],
		pendingDays: ['2026-10-12', '2026-10-19'],
		jobName,
		...patch,
	})

	it('should count only the days in the period', () => {
		const p = progress(input())
		expect(p.minutes).toBe(210)
		expect(p.worked).toBe(2)
		expect(p.pending).toBe(1)
	})

	it('should count the work days that have been and gone, not all seven', () => {
		expect(progress(input()).elapsed).toBe(3) // Mon, Tue, Wed of a Mon–Fri week
		expect(progress(input({ today: '2026-10-18' })).elapsed).toBe(5)
	})

	it('should say what the time went on, biggest first', () => {
		expect(progress(input()).things).toEqual([
			{ label: 'PAY-2433', minutes: 180 },
			{ label: 'Platform', minutes: 30 },
		])
	})

	it('should not invent a percentage', () => {
		expect(Object.keys(progress(input()))).not.toContain('percent')
	})
})

describe('how scattered a day was', () => {
	const day = [
		entry('2026-10-13', '09:00', 'PAY-2433 parser', 60, 'j1'),
		entry('2026-10-13', '10:00', 'PAY-2433 more parser', 60, 'j1'),
		entry('2026-10-13', '11:00', 'deploy checks', 30, 'j2'),
		entry('2026-10-13', '12:00', 'PAY-2433 back to it', 30, 'j1'),
	]

	it('should count the times the thing changed, not the entries', () => {
		const s = switches(day, jobName)
		expect(s.count).toBe(2)
		expect(s.things).toBe(2)
	})

	it('should find the longest unbroken stretch and what it was on', () => {
		const s = switches(day, jobName)
		expect(s.longest).toBe(120)
		expect(s.longestOn).toBe('PAY-2433')
	})

	it('should say one thing all day when that is what happened', () => {
		expect(switchNote(switches(day.slice(0, 2), jobName))).toBe('One thing all day — PAY-2433.')
	})

	it('should read plainly rather than score you', () => {
		const note = switchNote(switches(day, jobName))
		expect(note).toBe('2 switches between 2 things. Longest stretch 2h on PAY-2433.')
		expect(note).not.toMatch(/score|bad|poor|focus rating/i)
	})

	it('should cope with a day that has nothing in it', () => {
		expect(switches([], jobName)).toMatchObject({ count: 0, things: 0 })
		expect(switchNote(switches([], jobName))).toBe('Nothing logged yet.')
	})
})

describe('the ten-minute cleanup', () => {
	const t = (title: string, patch: Record<string, unknown> = {}) => ({ uid: title, title, status: 'todo', createdAt: 1, spentMinutes: 0, ...patch })

	it('should take what you marked quick, and anything estimated at a quarter hour or less', () => {
		const out = quickWins([t('Approve the expense', { quick: true }), t('Big thing'), t('Reply to the client', { estimateMinutes: 5 })])
		expect(out.map((x) => x.title)).toEqual(['Reply to the client', 'Approve the expense'])
	})

	it('should show three at a time, because a list of twenty is what you are avoiding', () => {
		expect(quickWins(Array.from({ length: 9 }, (_, i) => t(`Small ${i}`, { quick: true })))).toHaveLength(3)
	})

	it('should leave out what is blocked, done, or a saved link', () => {
		const out = quickWins([t('Blocked', { quick: true, blocked: true }), t('Done', { quick: true, status: 'done' }), t('A link', { quick: true, kind: 'note' })])
		expect(out).toEqual([])
	})

	it('should say what the block would cost', () => {
		expect(cleanupMinutes(quickWins([t('A', { estimateMinutes: 5 }), t('B', { quick: true })]))).toBe(15)
	})
})

describe('planned against actual', () => {
	const t = (title: string, estimateMinutes: number | undefined, spentMinutes: number) => ({ uid: title, title, estimateMinutes, spentMinutes })

	it('should compare only where you said what you expected', () => {
		expect(plannedActual([t('Estimated', 60, 95), t('Never estimated', undefined, 120), t('Not started', 30, 0)])).toEqual([{ title: 'Estimated', planned: 60, actual: 95 }])
	})

	it('should put the biggest actual first', () => {
		expect(plannedActual([t('Small', 10, 15), t('Large', 60, 200)]).map((x) => x.title)).toEqual(['Large', 'Small'])
	})
})
