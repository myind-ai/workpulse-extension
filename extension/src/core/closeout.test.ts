import { describe, expect, it } from 'vitest'

import { checkoutAlarmDue, lastCallDue, leftAt, needsClosing, regularisationNote, workEndsAt } from './closeout'
import { parseIst } from './time'

const at = (hhmm: string) => parseIst(`2026-10-15T${hhmm}:00`)
const base = { checkedInAt: at('09:05'), away: [] as [number, number][], shiftEnd: at('19:00'), now: parseIst('2026-10-16T09:30:00') }

describe('when did you actually stop', () => {
	it('should take the moment the machine went quiet', () => {
		const l = leftAt({ ...base, away: [[at('13:00'), at('13:40')], [at('19:42'), parseIst('2026-10-16T09:00:00')]] })
		expect(l.at).toBe(at('19:42'))
		expect(l.why).toContain('machine went quiet')
		expect(l.guessed).toBe(false)
	})

	it('should ignore a short break as a leaving time', () => {
		// Ten minutes away is a coffee, not the end of the day.
		const l = leftAt({ ...base, away: [[at('18:50'), at('19:00')]], lastEntryEnd: at('18:30') })
		expect(l.at).toBe(at('18:30'))
		expect(l.why).toContain('last entry')
	})

	it('should fall back to the last tick when nothing was written down', () => {
		const l = leftAt({ ...base, lastTick: at('19:20') })
		expect(l.at).toBe(at('19:20'))
	})

	it('should not turn a laptop left open into an overtime claim', () => {
		// Still ticking at 2am: the guess is capped a few hours after the shift.
		const l = leftAt({ ...base, lastTick: parseIst('2026-10-16T02:00:00') })
		expect(l.at).toBeLessThanOrEqual(at('23:00'))
	})

	it('should admit when it is guessing', () => {
		const l = leftAt(base)
		expect(l.at).toBe(at('19:00'))
		expect(l.guessed).toBe(true)
		expect(l.why).toContain('nothing else to go on')
	})

	it('should never guess a time before you checked in', () => {
		const l = leftAt({ ...base, lastEntryEnd: at('08:00') })
		expect(l.at).toBeGreaterThanOrEqual(base.checkedInAt)
	})
})

describe('which days are owed a check-out', () => {
	it('should want one for a day that started and never finished', () => {
		expect(needsClosing({ checkedInAt: 1 })).toBe(true)
		expect(needsClosing({ checkedInAt: 1, checkedOutAt: 2 })).toBe(false)
		expect(needsClosing({})).toBe(false)
		expect(needsClosing({ checkedInAt: 1, isOff: true })).toBe(false)
	})
})

describe('the last call before it becomes a regularisation', () => {
	const s = { shiftEnd: at('19:00'), checkedIn: true, checkedOut: false, told: false, isOff: false }

	it('should wait three hours past the shift, then ring', () => {
		expect(lastCallDue({ ...s, now: at('21:00') })).toBe(false)
		expect(lastCallDue({ ...s, now: at('22:05') })).toBe(true)
	})

	it('should say nothing once it has been said, or once you are out', () => {
		expect(lastCallDue({ ...s, now: at('22:05'), told: true })).toBe(false)
		expect(lastCallDue({ ...s, now: at('22:05'), checkedOut: true })).toBe(false)
		expect(lastCallDue({ ...s, now: at('22:05'), isOff: true })).toBe(false)
	})

	it('should write the sentence the form wants', () => {
		expect(regularisationNote('2026-10-15', '19:42', 'when the machine went quiet')).toContain('Worked until about 19:42')
	})
})

describe('the check-out alarm', () => {
	const s = { checkedInAt: at('09:00'), minHours: 8, shiftEnd: at('19:00'), isOff: false, workingLate: false, inMeeting: false }

	it('should end the day at the hours or the shift end, whichever comes first', () => {
		expect(workEndsAt(at('09:00'), 8, at('19:00'))).toBe(at('17:00'))
		expect(workEndsAt(at('12:00'), 8, at('19:00'))).toBe(at('19:00'))
	})

	it('should ring from the end of the working day, and keep ringing', () => {
		expect(checkoutAlarmDue({ ...s, now: at('16:59') })).toBe(false)
		expect(checkoutAlarmDue({ ...s, now: at('17:00') })).toBe(true)
		expect(checkoutAlarmDue({ ...s, now: at('21:30') })).toBe(true)
	})

	it('should ring at shift end after a late start', () => {
		expect(checkoutAlarmDue({ ...s, checkedInAt: at('12:00'), now: at('18:59') })).toBe(false)
		expect(checkoutAlarmDue({ ...s, checkedInAt: at('12:00'), now: at('19:00') })).toBe(true)
	})

	it('should stop for a check-out, working late, a meeting or a day off', () => {
		const now = at('17:30')
		expect(checkoutAlarmDue({ ...s, now, checkedOutAt: at('17:20') })).toBe(false)
		expect(checkoutAlarmDue({ ...s, now, workingLate: true })).toBe(false)
		expect(checkoutAlarmDue({ ...s, now, inMeeting: true })).toBe(false)
		expect(checkoutAlarmDue({ ...s, now, isOff: true })).toBe(false)
		expect(checkoutAlarmDue({ ...s, now, checkedInAt: undefined })).toBe(false)
	})
})
