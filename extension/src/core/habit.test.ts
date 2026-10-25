import { describe, expect, it } from 'vitest'

import { badgeFor, gapOf, hoursShort, isComplete, lastDays, lockLine, owedDays, streakOf, type DayState } from './habit'

const day = (date: string, logged: number, expected = 480, off = false, checkedIn = true): DayState => ({
	date,
	loggedMinutes: logged,
	expectedMinutes: off ? 0 : expected,
	checkedIn,
	off,
})

describe('a run of days that cannot be gamed', () => {
	it('should count complete days, not days you opened the app', () => {
		const days = [day('2026-10-12', 480), day('2026-10-13', 480), day('2026-10-14', 490)]
		expect(streakOf(days, '2026-10-15').days).toBe(3)
	})

	it('should step over leave and weekends instead of breaking on them', () => {
		// Away for a week. Being away is not a failure, and a streak that says it
		// is, is one you lose on a beach.
		const days = [day('2026-10-12', 480), day('2026-10-13', 0, 0, true), day('2026-10-14', 0, 0, true), day('2026-10-15', 480)]
		expect(streakOf(days, '2026-10-16').days).toBe(2)
	})

	it('should not count today until the day is actually finished', () => {
		const days = [day('2026-10-12', 480), day('2026-10-13', 120)]
		const s = streakOf(days, '2026-10-13')
		expect(s.days).toBe(1)
		expect(s.atRisk).toBe(true)
	})

	it('should break on a day that was genuinely left with a gap', () => {
		const days = [day('2026-10-12', 480), day('2026-10-13', 120), day('2026-10-14', 480)]
		expect(streakOf(days, '2026-10-15').days).toBe(1)
	})

	it('should keep the best run, so one bad day is not the whole story', () => {
		const days = [day('2026-10-05', 480), day('2026-10-06', 480), day('2026-10-07', 480), day('2026-10-08', 60), day('2026-10-09', 480)]
		expect(streakOf(days, '2026-10-12').best).toBe(3)
	})

	it('should say which day it has been running since', () => {
		const days = [day('2026-10-12', 480), day('2026-10-13', 480)]
		expect(streakOf(days, '2026-10-14').since).toBe('2026-10-12')
	})
})

describe('the only deadline in the app it did not invent', () => {
	const weekdayOf = (d: string) => ((Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000) + 3) % 7) + 1

	it('should name the day Zoho stops taking it', () => {
		// 2026-10-12 is a Monday, so it locks on the 19th — a Monday.
		expect(lockLine('2026-10-12', '2026-10-15', weekdayOf)).toBe('locks on Monday')
	})

	it('should say tomorrow when it is tomorrow', () => {
		expect(lockLine('2026-10-12', '2026-10-18', weekdayOf)).toBe('locks tomorrow')
	})

	it('should admit when it is already too late', () => {
		expect(lockLine('2026-10-01', '2026-10-15', weekdayOf)).toContain('already')
	})

	it('should put the day that locks first above the day with more missing', () => {
		const days = [day('2026-10-13', 60), day('2026-10-09', 420)]
		expect(owedDays(days, '2026-10-15').map((d) => d.date)).toEqual(['2026-10-09', '2026-10-13'])
	})

	it('should leave out a day nobody worked', () => {
		expect(owedDays([day('2026-10-13', 0, 480, false, false)], '2026-10-15')).toEqual([])
	})
})

describe('the badge, which is most of what anyone sees all day', () => {
	const base = { workday: true, checkedIn: true, gapMinutes: 0, issues: 0, owed: 0 }

	it('should show the hours still unaccounted for', () => {
		expect(badgeFor({ ...base, gapMinutes: 150 })).toEqual({ text: '2.5', colour: '#D97706' })
		expect(badgeFor({ ...base, gapMinutes: 45 })).toEqual({ text: '45m', colour: '#D97706' })
	})

	it('should show a tick when there is nothing owed', () => {
		expect(badgeFor({ ...base, gapMinutes: 20 }).text).toBe('✓')
	})

	it('should put a day that will lock above today’s gap', () => {
		expect(badgeFor({ ...base, gapMinutes: 300, owed: 2 })).toEqual({ text: '2', colour: '#DC2626' })
	})

	it('should ask you to check in before anything else', () => {
		expect(badgeFor({ ...base, checkedIn: false, gapMinutes: 300 }).text).toBe('IN')
	})

	it('should say nothing at all on a day off', () => {
		expect(badgeFor({ ...base, workday: false, gapMinutes: 480 }).text).toBe('')
	})

	it('should let an open card speak for itself', () => {
		expect(badgeFor({ ...base, pending: 'prompt', owed: 3 }).text).toBe('LOG')
	})

	it('should hand the badge to a focus block while one is running', () => {
		// The one number you are allowed to want to glance at.
		expect(badgeFor({ ...base, focusLeft: 23, gapMinutes: 300, owed: 2 })).toEqual({ text: '23', colour: '#7C3AED' })
		// And hand it straight back when the block is over.
		expect(badgeFor({ ...base, focusLeft: 0, owed: 2 }).text).toBe('2')
	})
})

describe('small things that have to be right', () => {
	it('should shorten hours to fit a 16px badge', () => {
		expect(hoursShort(30)).toBe('30m')
		expect(hoursShort(120)).toBe('2')
		expect(hoursShort(150)).toBe('2.5')
		expect(hoursShort(700)).toBe('12')
	})

	it('should fill the blanks in a fortnight strip', () => {
		const strip = lastDays([day('2026-10-14', 480)], '2026-10-15', 3)
		expect(strip.map((d) => d.date)).toEqual(['2026-10-13', '2026-10-14', '2026-10-15'])
		expect(strip[0].off).toBe(true) // never seen: not a failure
	})

	it('should count a day off as complete and owe nothing', () => {
		expect(isComplete(day('2026-10-12', 0, 0, true))).toBe(true)
		expect(gapOf(day('2026-10-12', 0, 0, true))).toBe(0)
	})
})
