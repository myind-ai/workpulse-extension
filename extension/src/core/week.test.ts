import { describe, expect, it } from 'vitest'

import { reviewDue, reviewText, shareOf, weekLine, weekSplit } from './week'
import { parseIst } from './time'

const entry = (date: string, text: string, minutes: number) => ({ date, text, minutes, slotStart: parseIst(`${date}T10:00:00`) })

const input = {
	from: '2026-10-12',
	to: '2026-10-16',
	entries: [entry('2026-10-12', 'PAY-3092', 300), entry('2026-10-13', 'Standup', 30), entry('2026-10-13', 'PAY-3092', 240)],
	meetingMinutes: 30,
	deepMinutes: 150,
	switches: { count: 3, things: 2, longest: 300 },
}

describe('where the week went', () => {
	it('should add up what happened, and nothing else', () => {
		expect(weekSplit(input)).toMatchObject({ logged: 570, meetings: 30, deep: 150, days: 2, switches: 3, things: 2 })
	})

	it('should never claim more meetings than there were minutes', () => {
		// A meeting that overran its slot must not make the week look mostly
		// meetings.
		expect(weekSplit({ ...input, meetingMinutes: 9999 }).meetings).toBe(570)
	})

	it('should say the share without inventing a target to miss', () => {
		const line = weekLine(weekSplit(input))!
		expect(line).toContain('9h 30m over 2 days')
		expect(line).toContain('30m in meetings (5%)')
		expect(line).toContain('2h 30m of deep work')
		expect(line).not.toMatch(/should|target|goal|too much/)
	})

	it('should leave out the parts that are not there', () => {
		const quiet = weekLine(weekSplit({ ...input, meetingMinutes: 0, deepMinutes: 0, switches: { count: 0, things: 0, longest: 0 } }))!
		expect(quiet).not.toContain('meetings')
		expect(quiet).not.toContain('deep work')
	})

	it('should say nothing about a week with nothing in it', () => {
		expect(weekLine(weekSplit({ ...input, entries: [] }))).toBeNull()
		expect(shareOf(5, 0)).toBe(0)
	})
})

describe('the five minutes on Friday', () => {
	const at = (s: string) => parseIst(`2026-10-16T${s}:00`)
	const base = { shiftEnd: at('19:00'), isLastWorkday: true, doneThisWeek: false, checkedIn: true }

	it('should come in the last working hour, not on Monday', () => {
		// A review of a week you cannot remember is a form.
		expect(reviewDue({ ...base, now: at('15:00') })).toBe(false)
		expect(reviewDue({ ...base, now: at('18:20') })).toBe(true)
	})

	it('should not come twice, or on a day that is not the last', () => {
		expect(reviewDue({ ...base, now: at('18:20'), doneThisWeek: true })).toBe(false)
		expect(reviewDue({ ...base, now: at('18:20'), isLastWorkday: false })).toBe(false)
		expect(reviewDue({ ...base, now: at('18:20'), checkedIn: false })).toBe(false)
	})

	it('should write the update somebody will ask for anyway', () => {
		const text = reviewText({
			from: '2026-10-12',
			to: '2026-10-16',
			split: weekSplit(input),
			worked: [{ label: 'PAY-3092', minutes: 540 }],
			finished: ['PAY-3092 shipped behind the flag'],
			learned: ['Resolve the division first'],
			waiting: ['PAY-2901 — review, 4 days'],
		})
		expect(text).toContain('*Week of 2026-10-12*')
		expect(text).toContain('• PAY-3092 · 9h')
		expect(text).toContain('*Waiting on somebody*')
	})
})
