import { describe, expect, it } from 'vitest'

import { overtime, overtimeLine, type WorkedDay } from './overtime'

const day = (date: string, clock: number, logged = 0, expected = 480, off = false): WorkedDay => ({
	date,
	clockMinutes: clock,
	loggedMinutes: logged,
	expectedMinutes: expected,
	off,
})

describe('the hours you actually worked', () => {
	const week = [day('2026-10-12', 570), day('2026-10-13', 600), day('2026-10-14', 540), day('2026-10-15', 480), day('2026-10-16', 630)]

	it('should count the week and say what it came to', () => {
		const o = overtime(week, '2026-10-12', '2026-10-18')
		expect(o.minutes).toBe(2820)
		expect(o.expected).toBe(2400)
		expect(o.over).toBe(420)
		expect(o.longDays).toBe(4)
		expect(o.longest).toEqual({ date: '2026-10-16', minutes: 630 })
	})

	it('should take the clock over what was written down', () => {
		// A day you forgot to log is not a day you did not work.
		const o = overtime([day('2026-10-12', 540, 120)], '2026-10-12', '2026-10-12')
		expect(o.minutes).toBe(540)
	})

	it('should fall back to what was logged when there is no clock', () => {
		const o = overtime([day('2026-10-12', 0, 300)], '2026-10-12', '2026-10-12')
		expect(o.minutes).toBe(300)
		expect(o.short).toBe(180)
	})

	it('should name a day worked that was not a working day', () => {
		const o = overtime([...week, day('2026-10-17', 240, 0, 0, true)], '2026-10-12', '2026-10-18')
		expect(o.offDaysWorked).toEqual([{ date: '2026-10-17', minutes: 240 }])
		expect(overtimeLine(o)).toContain('including a day off')
	})

	it('should leave a day nobody worked out of the count entirely', () => {
		const o = overtime([day('2026-10-12', 0, 0)], '2026-10-12', '2026-10-12')
		expect(o.days).toBe(0)
		expect(overtimeLine(o)).toBeNull()
	})

	it('should say nothing at all about an ordinary week', () => {
		const even = [day('2026-10-12', 480), day('2026-10-13', 490), day('2026-10-14', 470)]
		expect(overtimeLine(overtime(even, '2026-10-12', '2026-10-18'))).toBeNull()
	})

	it('should put the overtime in hours a person would say', () => {
		expect(overtimeLine(overtime(week, '2026-10-12', '2026-10-18'))).toContain('7h more than the 40h')
	})
})
