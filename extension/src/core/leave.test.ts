import { describe, expect, it } from 'vitest'

import { dayKind, hoursFor, isOffKind, kindLabel, offDays } from './leave'

describe('what kind of day Zoho says it was', () => {
	it('should read the labels a company actually configures', () => {
		expect(dayKind('Holiday')).toBe('holiday')
		expect(dayKind('Restricted Holiday')).toBe('holiday')
		expect(dayKind('Paid Leave')).toBe('leave')
		expect(dayKind('Comp Off')).toBe('leave')
		expect(dayKind('Week Off')).toBe('weekend')
		expect(dayKind('Weekend')).toBe('weekend')
		expect(dayKind('Half Day')).toBe('half')
		expect(dayKind('Present')).toBe('work')
		expect(dayKind('')).toBe('work')
	})

	it('should never read an absence as leave', () => {
		// An absence nobody approved is the thing the regularisation page exists
		// for; quietly calling it leave would hide the day that costs you.
		expect(dayKind('Absent')).toBe('work')
		expect(isOffKind(dayKind('Absent'))).toBe(false)
	})

	it('should let a day you worked be a working day whatever it is labelled', () => {
		expect(dayKind('Present (Holiday)')).toBe('work')
	})

	it('should still treat a half day as a day you were there', () => {
		expect(isOffKind('half')).toBe(false)
		expect(hoursFor('half', 8)).toBe(4)
		expect(hoursFor('holiday', 8)).toBe(0)
		expect(hoursFor('work', 8)).toBe(8)
	})

	it('should name the day in words a person would use', () => {
		expect(kindLabel('leave')).toBe('On leave')
		expect(kindLabel('holiday')).toBe('Holiday')
	})

	it('should pick the days worth marking out of a month', () => {
		const report = [
			{ date: '2026-10-12', status: 'Present', firstIn: '09:00', lastOut: '18:00', totalHours: '09:00' },
			{ date: '2026-10-13', status: 'Paid Leave', firstIn: '', lastOut: '', totalHours: '' },
			{ date: '2026-10-17', status: 'Week Off', firstIn: '', lastOut: '', totalHours: '' },
		]
		expect(offDays(report)).toEqual([
			{ date: '2026-10-13', kind: 'leave', status: 'Paid Leave' },
			{ date: '2026-10-17', kind: 'weekend', status: 'Week Off' },
		])
	})
})
