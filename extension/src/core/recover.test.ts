import { describe, expect, it } from 'vitest'

import { arrivedAt, beforeAfter, departedAt, headline, recoverable, recoveryFor, sealed, sealsIn, type DayEvidence } from './recover'

const MIN = 60_000
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`)
const D = '2026-10-13'

const day = (over: Partial<DayEvidence> = {}): DayEvidence => ({
	date: D,
	entries: [],
	away: [],
	shiftStart: at(D, '09:00'),
	shiftEnd: at(D, '18:30'),
	...over,
})

const now = at('2026-10-16', '10:00')

describe('the day that shows zero', () => {
	it('should leave a day off alone, however it looks', () => {
		expect(recoveryFor(day({ isOff: true, entries: [{ slotStart: at(D, '09:00'), slotEnd: at(D, '10:00') }] }), now)).toBeNull()
	})

	it('should never propose a punch for a day nobody worked', () => {
		// Asking somebody to file a claim for a day they did not work is a far
		// worse failure than missing one.
		expect(recoveryFor(day(), now)).toBeNull()
	})

	it('should leave a day that already has both punches', () => {
		expect(recoveryFor(day({ checkedInAt: at(D, '09:00'), checkedOutAt: at(D, '18:00') }), now)).toBeNull()
	})

	it('should catch a day with a check-in and no check-out', () => {
		const r = recoveryFor(day({ checkedInAt: at(D, '09:05'), entries: [{ slotStart: at(D, '09:00'), slotEnd: at(D, '17:00') }] }), now)
		expect(r?.fault).toBe('no-checkout')
		expect(r?.left?.why).toBe('the end of your last entry')
		expect(r?.arrived).toBeUndefined()
	})

	it('should catch a day with neither punch, which nothing else ever noticed', () => {
		const r = recoveryFor(day({ entries: [{ slotStart: at(D, '09:30'), slotEnd: at(D, '17:30') }] }), now)
		expect(r?.fault).toBe('neither')
		expect(r?.arrived?.at).toBe(at(D, '09:30'))
		expect(r?.left?.at).toBe(at(D, '17:30'))
	})

	it('should show a half-punched day as zero, because that is what Zoho shows', () => {
		const r = recoveryFor(day({ checkedInAt: at(D, '09:00'), entries: [{ slotStart: at(D, '09:00'), slotEnd: at(D, '17:00') }] }), now)
		// An in with no out is not "some hours". It is an absence.
		expect(r?.beforeMinutes).toBe(0)
		expect(r?.afterMinutes).toBe(8 * 60)
	})

	it('should prefer what you wrote down over what it merely observed', () => {
		const d = day({ entries: [{ slotStart: at(D, '09:40'), slotEnd: at(D, '12:00') }], lastTick: at(D, '08:10') })
		expect(arrivedAt(d).why).toBe('the start of your first entry')
		expect(arrivedAt(d).guessed).toBe(false)
	})

	it('should admit when it had nothing to go on', () => {
		const p = arrivedAt(day({ checkedInAt: at(D, '09:00') }))
		expect(p.guessed).toBe(true)
		expect(p.why).toContain('nothing else to go on')
	})

	it('should take the machine going quiet over the last entry, when it is later', () => {
		const d = day({
			entries: [{ slotStart: at(D, '09:00'), slotEnd: at(D, '16:00') }],
			away: [[at(D, '17:40'), at(D, '23:00')]],
		})
		expect(departedAt(d).why).toBe('when the machine went quiet')
		expect(departedAt(d).at).toBe(at(D, '17:40'))
	})

	it('should not treat a laptop left open all night as overtime', () => {
		const d = day({ entries: [{ slotStart: at(D, '09:00'), slotEnd: at(D, '10:00') }], lastTick: at('2026-10-14', '02:00') })
		// Past the shift end plus four hours, so the tick is not usable.
		expect(departedAt(d).at).toBeLessThanOrEqual(at(D, '22:30'))
	})
})

describe('the deadline that is not ours', () => {
	it('should count down from the day itself, not from now', () => {
		expect(sealsIn('2026-10-16', at('2026-10-16', '12:00'))).toBe(7)
		expect(sealsIn('2026-10-10', at('2026-10-16', '12:00'))).toBe(1)
	})

	it('should treat an already-locked day as sealed', () => {
		expect(sealed('2026-10-01', at('2026-10-16', '12:00'))).toBe(true)
		expect(sealed('2026-10-15', at('2026-10-16', '12:00'))).toBe(false)
	})

	it('should put the day closest to sealing first', () => {
		const list = recoverable(
			[
				day({ date: '2026-10-15', entries: [{ slotStart: at('2026-10-15', '09:00'), slotEnd: at('2026-10-15', '17:00') }], shiftStart: at('2026-10-15', '09:00'), shiftEnd: at('2026-10-15', '18:30') }),
				day({ date: '2026-10-10', entries: [{ slotStart: at('2026-10-10', '09:00'), slotEnd: at('2026-10-10', '17:00') }], shiftStart: at('2026-10-10', '09:00'), shiftEnd: at('2026-10-10', '18:30') }),
			],
			now,
		)
		expect(list.map((r) => r.date)).toEqual(['2026-10-10', '2026-10-15'])
	})
})

describe('what it says out loud', () => {
	it('should count days, not punches, because a day missing both is still one day', () => {
		const list = recoverable([day({ entries: [{ slotStart: at(D, '09:00'), slotEnd: at(D, '17:00') }] })], now)
		expect(headline(list)).toContain('1 day')
		expect(headline(list)).toContain('8 hours')
	})

	it('should say so plainly when there is nothing wrong', () => {
		expect(headline([])).toContain('intact')
	})

	it('should show the payoff rather than describe it', () => {
		const r = recoveryFor(day({ entries: [{ slotStart: at(D, '09:00'), slotEnd: at(D, '16:30') }] }), now)!
		expect(beforeAfter(r)).toBe('0 hours → 7.5 hours')
	})
})
