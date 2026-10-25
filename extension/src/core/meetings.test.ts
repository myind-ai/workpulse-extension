import { describe, expect, it } from 'vitest'

import { dueMeetings, dueToLog, logsItself, meetingSlot, meetingSlots, meetingWhen, nextMeetingAt, timeOn, type Meeting } from './meetings'
import { parseIst } from './time'

const standup = (p: Partial<Meeting> = {}): Meeting => ({
	id: 'm1',
	name: 'Standup',
	time: '09:45',
	days: [1, 2, 3, 4, 5],
	leadMinutes: 5,
	enabled: true,
	...p,
})

// 2026-10-12 is a Monday, 2026-10-11 a Sunday.
describe('daily meeting reminders', () => {
	it('should say something once the lead time is reached, not before', () => {
		expect(dueMeetings([standup()], parseIst('2026-10-12T09:39:00'))).toEqual([])
		expect(dueMeetings([standup()], parseIst('2026-10-12T09:40:00'))).toHaveLength(1)
	})

	it('should stay quiet on a day it does not happen', () => {
		expect(dueMeetings([standup()], parseIst('2026-10-11T09:41:00'))).toEqual([]) // Sunday
		expect(dueMeetings([standup({ days: [7] })], parseIst('2026-10-11T09:41:00'))).toHaveLength(1)
	})

	it('should not announce a meeting the day has moved past', () => {
		expect(dueMeetings([standup()], parseIst('2026-10-12T10:04:00'))).toHaveLength(1)
		expect(dueMeetings([standup()], parseIst('2026-10-12T18:00:00'))).toEqual([]) // laptop opened in the evening
	})

	it('should say it once a day, and again tomorrow', () => {
		const said = standup({ notifiedOn: '2026-10-12' })
		expect(dueMeetings([said], parseIst('2026-10-12T09:44:00'))).toEqual([])
		expect(dueMeetings([said], parseIst('2026-10-13T09:44:00'))).toHaveLength(1)
	})

	it('should respect being switched off', () => {
		expect(dueMeetings([standup({ enabled: false })], parseIst('2026-10-12T09:44:00'))).toEqual([])
	})

	it('should take a lead time of zero as "when it starts"', () => {
		const m = standup({ leadMinutes: 0 })
		expect(dueMeetings([m], parseIst('2026-10-12T09:44:00'))).toEqual([])
		expect(dueMeetings([m], parseIst('2026-10-12T09:45:00'))).toHaveLength(1)
	})

	it('should word the nudge the way a person would', () => {
		const m = standup()
		expect(meetingWhen(m, parseIst('2026-10-12T09:40:00'))).toBe('in 5 minutes')
		expect(meetingWhen(m, parseIst('2026-10-12T09:44:00'))).toBe('in a minute')
		expect(meetingWhen(m, parseIst('2026-10-12T09:45:00'))).toBe('now')
		expect(meetingWhen(m, parseIst('2026-10-12T09:50:00'))).toBe('started')
	})
})

describe('when it will next speak', () => {
	const standup = (patch: Partial<Meeting> = {}): Meeting => ({ id: 'm', name: 'Standup', time: '09:45', days: [1, 2, 3, 4, 5], leadMinutes: 5, enabled: true, ...patch })

	it('should be today when today still has it', () => {
		const now = parseIst('2026-10-12T08:00:00') // Monday
		expect(nextMeetingAt(standup(), now)).toBe(parseIst('2026-10-12T09:40:00'))
	})

	it('should be the next working day once today’s has gone', () => {
		const now = parseIst('2026-10-12T11:00:00')
		expect(nextMeetingAt(standup(), now)).toBe(parseIst('2026-10-13T09:40:00'))
	})

	it('should skip the weekend for a Mon–Fri meeting', () => {
		const now = parseIst('2026-10-16T18:00:00') // Friday evening
		expect(nextMeetingAt(standup(), now)).toBe(parseIst('2026-10-19T09:40:00')) // Monday
	})

	it('should skip today when today has already been announced', () => {
		const now = parseIst('2026-10-12T09:00:00')
		expect(nextMeetingAt(standup({ notifiedOn: '2026-10-12' }), now)).toBe(parseIst('2026-10-13T09:40:00'))
	})

	it('should say nothing for a muted meeting', () => {
		expect(nextMeetingAt(standup({ enabled: false }), parseIst('2026-10-12T08:00:00'))).toBeNull()
	})
})

describe('a meeting that puts itself on the timesheet', () => {
	const standup = (patch: Partial<Meeting> = {}): Meeting => ({
		id: 'm',
		name: 'Daily standup',
		time: '09:45',
		days: [1, 2, 3, 4, 5],
		leadMinutes: 5,
		enabled: true,
		logMinutes: 30,
		...patch,
	})
	const free = () => false
	const at = (s: string) => parseIst(s)

	it('should know the slot it would take', () => {
		expect(meetingSlot(standup(), '2026-10-12')).toEqual({ from: at('2026-10-12T09:45:00'), to: at('2026-10-12T10:15:00') })
	})

	it('should ask once it has finished, not before', () => {
		expect(dueToLog([standup()], at('2026-10-12T10:00:00'), free)).toEqual([]) // still in it
		expect(dueToLog([standup()], at('2026-10-12T10:15:00'), free)).toHaveLength(1)
	})

	it('should not ask about this morning at midnight', () => {
		expect(dueToLog([standup()], at('2026-10-12T20:00:00'), free)).toEqual([])
	})

	it('should not ask twice, whatever the answer was', () => {
		expect(dueToLog([standup({ loggedOn: '2026-10-12' })], at('2026-10-12T10:30:00'), free)).toEqual([])
	})

	it('should stay quiet when you have already logged that time yourself', () => {
		const covered = (from: number, to: number) => from === at('2026-10-12T09:45:00') && to === at('2026-10-12T10:15:00')
		expect(dueToLog([standup()], at('2026-10-12T10:30:00'), covered)).toEqual([])
	})

	it('should leave alone a meeting that is only ever a nudge', () => {
		expect(dueToLog([standup({ logMinutes: 0 })], at('2026-10-12T10:30:00'), free)).toEqual([])
		expect(dueToLog([standup({ logMinutes: undefined })], at('2026-10-12T10:30:00'), free)).toEqual([])
	})

	it('should respect the days it happens on, and being muted', () => {
		expect(dueToLog([standup()], at('2026-10-11T10:30:00'), free)).toEqual([]) // Sunday
		expect(dueToLog([standup({ enabled: false })], at('2026-10-12T10:30:00'), free)).toEqual([])
	})
})

describe('a meeting that moved', () => {
	const standup: Meeting = { id: 'm1', name: 'Standup', kind: 'scrum', time: '09:45', days: [1, 2, 3, 4, 5], leadMinutes: 5, enabled: true, logMinutes: 15 }
	const at = (s: string) => parseIst(`2026-10-12T${s}:00`) // a Monday

	it('should speak at the time it moved to, not its usual one', () => {
		const moved = { ...standup, movedOn: { date: '2026-10-12', time: '10:30' } }
		expect(dueMeetings([moved], at('09:40'))).toEqual([])
		expect(dueMeetings([moved], at('10:25'))).toHaveLength(1)
	})

	it('should take its timesheet slot with it', () => {
		const moved = { ...standup, movedOn: { date: '2026-10-12', time: '10:30' } }
		expect(meetingSlot(moved, '2026-10-12').from).toBe(at('10:30'))
		// And tomorrow it is back where it belongs.
		expect(meetingSlot(moved, '2026-10-13')).toEqual({ from: parseIst('2026-10-13T09:45:00'), to: parseIst('2026-10-13T10:00:00') })
	})

	it('should turn up on a day that is not one of its own, if it was moved there', () => {
		const saturday = '2026-10-17'
		const moved = { ...standup, movedOn: { date: saturday, time: '11:00' } }
		expect(dueMeetings([moved], parseIst(`${saturday}T10:58:00`))).toHaveLength(1)
	})

	it('should say nothing on a day it was called off', () => {
		const off = { ...standup, skippedOn: '2026-10-12' }
		expect(dueMeetings([off], at('09:40'))).toEqual([])
		expect(timeOn(off, '2026-10-12')).toBeNull()
		// Tomorrow, without anyone remembering to put it back.
		expect(timeOn(off, '2026-10-13')).toBe('09:45')
	})

	it('should keep a called-off day out of the hourly card’s way', () => {
		expect(meetingSlots([{ ...standup, skippedOn: '2026-10-12' }], '2026-10-12')).toEqual([])
		expect(meetingSlots([standup], '2026-10-12')).toHaveLength(1)
	})

	it('should count down to the time it actually is', () => {
		const moved = { ...standup, movedOn: { date: '2026-10-12', time: '10:30' } }
		expect(meetingWhen(moved, at('10:25'))).toBe('in 5 minutes')
	})
})

describe('a meeting that puts itself on the timesheet', () => {
	const base = { id: 'm1', name: 'Standup', time: '09:45', days: [1, 2, 3, 4, 5], leadMinutes: 5, enabled: true }

	it('should log itself when a length is set, because that already said so', () => {
		expect(logsItself({ ...base, logMinutes: 15 })).toBe(true)
	})

	it('should ask first when it has no length — there is nothing to write', () => {
		expect(logsItself({ ...base })).toBe(false)
		expect(logsItself({ ...base, logMinutes: 0 })).toBe(false)
	})

	it('should let one meeting opt out without affecting the others', () => {
		// A one-to-one that often gets cancelled is a question worth asking.
		expect(logsItself({ ...base, logMinutes: 15, autoLog: false })).toBe(false)
		expect(logsItself({ ...base, logMinutes: 15, autoLog: true })).toBe(true)
	})
})

describe('when a meeting is still worth writing down', () => {
	const standup = { id: 'm1', name: 'Standup', time: '09:45', days: [1, 2, 3, 4, 5], leadMinutes: 5, enabled: true, logMinutes: 15 }
	const never = () => false
	// Monday 2026-10-19: 09:45 + 15m ends 10:00.
	const at = (hhmm: string) => Date.parse(`2026-10-19T${hhmm}:00+05:30`)

	it('should not offer to log one that has not finished', () => {
		expect(dueToLog([standup], at('09:50'), never)).toHaveLength(0)
	})

	it('should stop asking once the answer would be a guess', () => {
		expect(dueToLog([standup], at('13:00'), never)).toHaveLength(1)
		expect(dueToLog([standup], at('15:00'), never)).toHaveLength(0)
	})

	it('should still write one down in the afternoon, when nobody is being asked', () => {
		// Opening the laptop at two should record the morning's stand-up.
		expect(dueToLog([standup], at('15:00'), never, Number.POSITIVE_INFINITY)).toHaveLength(1)
	})

	it('should leave it alone when you logged that time yourself', () => {
		expect(dueToLog([standup], at('11:00'), () => true, Number.POSITIVE_INFINITY)).toHaveLength(0)
	})
})
