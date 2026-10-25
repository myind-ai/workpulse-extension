import { describe, expect, it } from 'vitest'

import { accountedFor, gapLabel, timeline, unaccounted } from './timeline'

const D = '2026-10-13'
const at = (hhmm: string) => Date.parse(`${D}T${hhmm}:00+05:30`)
const e = (a: string, b: string, text = 'work', kind: 'work' | 'break' | 'skipped' = 'work') => ({
	slotStart: at(a), slotEnd: at(b), text, kind, minutes: Math.round((at(b) - at(a)) / 60000),
})

describe('the day, including the parts nobody wrote anything for', () => {
	it('should name the stretch between two entries as a gap', () => {
		const segs = timeline({ from: at('09:00'), to: at('18:00'), entries: [e('09:00', '11:00'), e('15:00', '18:00')], away: [] })
		const gap = segs.find((s) => s.kind === 'gap')
		expect(gap?.from).toBe(at('11:00'))
		expect(gap?.to).toBe(at('15:00'))
		expect(gap?.minutes).toBe(240)
	})

	it('should find a gap at the start and at the end, not only in the middle', () => {
		const segs = timeline({ from: at('09:00'), to: at('18:00'), entries: [e('11:00', '15:00')], away: [] })
		expect(segs.filter((s) => s.kind === 'gap').map((s) => s.minutes)).toEqual([120, 180])
	})

	it('should not call a few minutes between two entries a gap', () => {
		const segs = timeline({ from: at('09:00'), to: at('11:05'), entries: [e('09:00', '10:00'), e('10:05', '11:05')], away: [] })
		expect(segs.some((s) => s.kind === 'gap')).toBe(false)
	})

	it('should let what you wrote beat what the idle detector saw', () => {
		// Away from the keyboard while thinking about a problem you then wrote
		// down is still work, and you are the better witness.
		const segs = timeline({ from: at('09:00'), to: at('12:00'), entries: [e('09:00', '12:00')], away: [[at('10:00'), at('11:00')]] })
		expect(segs.every((s) => s.kind !== 'away')).toBe(true)
	})

	it('should keep an away stretch where nothing was logged over it', () => {
		const segs = timeline({ from: at('09:00'), to: at('14:00'), entries: [e('09:00', '10:00'), e('13:00', '14:00')], away: [[at('10:30'), at('12:00')]] })
		expect(segs.find((s) => s.kind === 'away')?.minutes).toBe(90)
	})

	it('should leave a skipped hour as a gap rather than pretending it was logged', () => {
		const segs = timeline({ from: at('09:00'), to: at('11:00'), entries: [e('09:00', '10:00', 'x', 'skipped'), e('10:00', '11:00')], away: [] })
		expect(segs.find((s) => s.kind === 'gap')?.minutes).toBe(60)
	})

	it('should keep a break as a break, not as work and not as a gap', () => {
		const segs = timeline({ from: at('12:00'), to: at('13:00'), entries: [e('12:00', '13:00', 'lunch', 'break')], away: [] })
		expect(segs[0].kind).toBe('break')
	})

	it('should answer the one question somebody came with', () => {
		const segs = timeline({ from: at('09:00'), to: at('18:00'), entries: [e('09:00', '13:00'), e('15:00', '18:00')], away: [] })
		expect(unaccounted(segs)).toBe(120)
		expect(accountedFor(segs).share).toBe(78)
	})

	it('should say nothing is missing when nothing is', () => {
		expect(accountedFor([]).share).toBe(100)
	})

	it('should describe a gap by how much of the day it actually ate', () => {
		expect(gapLabel(200)).toContain('most of an afternoon')
		expect(gapLabel(60)).toContain('about an hour')
		expect(gapLabel(15)).toBe('A short gap')
	})
})
