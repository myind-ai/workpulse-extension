import { describe, expect, it } from 'vitest'

import { addDays, atIst, fmtMinutes, istDate, istDateTime, istTime, istWeekday, parseIst, prettyDate } from './time'

describe('IST time helpers', () => {
	it('round-trips IST wall-clock times regardless of the machine zone', () => {
		const ms = atIst('2026-10-12', '09:05')
		expect(new Date(ms).toISOString()).toBe('2026-10-12T03:35:00.000Z')
		expect(istDate(ms)).toBe('2026-10-12')
		expect(istTime(ms)).toBe('09:05')
		expect(istDateTime(ms)).toBe('2026-10-12T09:05:00')
		expect(parseIst('2026-10-12T09:05:30')).toBe(ms + 30_000)
	})

	it('handles the IST date boundary', () => {
		// 20:00 UTC is 01:30 the next day in IST.
		expect(istDate(Date.UTC(2026, 9, 11, 20, 0))).toBe('2026-10-12')
	})

	it('knows weekdays and month edges', () => {
		expect(istWeekday(atIst('2026-10-12', '10:00'))).toBe(1) // Monday
		expect(istWeekday(atIst('2026-10-11', '10:00'))).toBe(7) // Sunday
		expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
		expect(prettyDate('2026-10-12')).toBe('Mon 12 Oct')
		expect(fmtMinutes(95)).toBe('1h 35m')
		expect(fmtMinutes(120)).toBe('2h')
		expect(fmtMinutes(20)).toBe('20m')
	})
})
