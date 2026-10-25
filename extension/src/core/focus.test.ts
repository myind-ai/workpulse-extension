import { describe, expect, it } from 'vitest'

import { duplicates, focus, site, type OpenTab } from './focus'
import { parseIst } from './time'
import { DEFAULT_SETTINGS, type Day } from './types'

const base = {
	settings: { ...DEFAULT_SETTINGS, minHours: 8 },
	isWorkDay: true,
	loggedMinutes: 0,
	now: parseIst('2026-10-12T15:00:00'),
}
const day = (p: Partial<Day> = {}): Day => ({ date: '2026-10-12', timelogStatus: 'pending', isOff: false, ...p })
const IN_AT_9 = parseIst('2026-10-12T09:00:00')

describe('what the widget should ask for', () => {
	it('should ask you to check in before anything else', () => {
		expect(focus({ ...base, day: day() }).kind).toBe('checkin')
	})

	it('should wait for your confirmation once Zoho is open', () => {
		expect(focus({ ...base, day: day(), awaiting: 'in' })).toMatchObject({ kind: 'confirm', label: "I've checked in" })
	})

	it('should name the unlogged time, because that is what costs you', () => {
		const f = focus({ ...base, day: day({ checkedInAt: IN_AT_9 }), loggedMinutes: 240 })
		expect(f.elapsed).toBe(360)
		expect(f.gap).toBe(120)
		expect(f).toMatchObject({ kind: 'log', label: 'Log the last 2h' })
	})

	it('should round the gap the way a person would say it', () => {
		const at = (m: number) => focus({ ...base, day: day({ checkedInAt: IN_AT_9 }), loggedMinutes: 360 - m }).label
		expect(at(45)).toBe('Log the last 45m')
		expect(at(90)).toBe('Log the last 1h 30m')
		expect(at(120)).toBe('Log the last 2h')
	})

	it('should move on to the timesheet once the hours are in and all is logged', () => {
		const f = focus({ ...base, now: parseIst('2026-10-12T17:30:00'), day: day({ checkedInAt: IN_AT_9 }), loggedMinutes: 510 })
		expect(f.kind).toBe('wrapup')
		const logged = focus({ ...base, now: parseIst('2026-10-12T17:30:00'), day: day({ checkedInAt: IN_AT_9, timelogStatus: 'pushed' }), loggedMinutes: 510 })
		expect(logged.kind).toBe('checkout')
	})

	it('should go quiet when there is nothing owed', () => {
		expect(focus({ ...base, day: day({ checkedInAt: IN_AT_9 }), loggedMinutes: 360 }).kind).toBe('resting')
		expect(focus({ ...base, day: day({ isOff: true }) }).kind).toBe('off')
		expect(focus({ ...base, day: day(), isWorkDay: false }).kind).toBe('off')
	})

	it('should stop the clock at check-out and cap the bar at full', () => {
		const f = focus({
			...base,
			now: parseIst('2026-10-12T23:00:00'),
			day: day({ checkedInAt: IN_AT_9, checkedOutAt: parseIst('2026-10-12T19:00:00'), timelogStatus: 'pushed' }),
			loggedMinutes: 600,
		})
		expect(f.elapsed).toBe(600)
		expect(f.progress).toBe(1)
		expect(f.kind).toBe('resting')
	})
})

// The gap is what the dashboard's middle card shows, so it is worth pinning.
describe('the gap a real user is judged on', () => {
	const day = { date: '2026-10-12', timelogStatus: 'pending' as const, isOff: false, checkedInAt: parseIst('2026-10-12T09:00:00') }
	const at = (time: string, logged: number) =>
		focus({ now: parseIst(time), day, settings: { ...DEFAULT_SETTINGS, minHours: 8 }, loggedMinutes: logged, isWorkDay: true })

	it('should count only what is missing, never go negative', () => {
		expect(at('2026-10-12T12:00:00', 0).gap).toBe(180)
		expect(at('2026-10-12T12:00:00', 120).gap).toBe(60)
		expect(at('2026-10-12T12:00:00', 180).gap).toBe(0)
		expect(at('2026-10-12T12:00:00', 300).gap).toBe(0) // logged more than the clock
	})

	it('should stop growing once the day is closed', () => {
		const closed = { ...day, checkedOutAt: parseIst('2026-10-12T17:00:00') }
		const f = focus({ now: parseIst('2026-10-12T23:00:00'), day: closed, settings: { ...DEFAULT_SETTINGS, minHours: 8 }, loggedMinutes: 60, isWorkDay: true })
		expect(f.elapsed).toBe(480)
		expect(f.gap).toBe(420)
	})
})

describe('closing tabs without losing them', () => {
	const tab = (id: number, url: string, extra: Partial<OpenTab> = {}): OpenTab => ({ id, title: `Tab ${id}`, url, pinned: false, audible: false, active: false, ...extra })

	it('should find the same page opened twice, keeping the first', () => {
		const dupes = duplicates([tab(1, 'https://a.com/x'), tab(2, 'https://b.com'), tab(3, 'https://a.com/x')])
		expect(dupes.map((t) => t.id)).toEqual([3])
	})

	it('should treat a fragment link as the same page', () => {
		expect(duplicates([tab(1, 'https://docs.com/g'), tab(2, 'https://docs.com/g#install')]).map((t) => t.id)).toEqual([2])
	})

	it('should never offer the tab you are looking at, or a pinned one', () => {
		const dupes = duplicates([tab(1, 'https://a.com'), tab(2, 'https://a.com', { active: true }), tab(3, 'https://a.com', { pinned: true }), tab(4, 'https://a.com')])
		expect(dupes.map((t) => t.id)).toEqual([4])
	})

	it('should name the site the way a person would', () => {
		expect(site('https://www.zoho.com/people/api')).toBe('zoho.com')
		expect(site('https://people.zoho.in/logiciel/zp')).toBe('people.zoho.in')
		expect(site('not a url')).toBe('not a url')
	})
})
