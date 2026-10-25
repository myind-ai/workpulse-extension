import { describe, expect, it } from 'vitest'

import { calibrate, calibrationLine, expect_, type Estimated } from './calibrate'

const t = (label: string, estimateMinutes: number, actualMinutes: number, at = 1): Estimated => ({ label, estimateMinutes, actualMinutes, at })

describe('how long things really take you', () => {
	it('should say nothing until there is enough behind it', () => {
		const c = calibrate([t('A', 60, 120), t('B', 60, 90)])
		expect(c.ready).toBe(false)
		expect(calibrationLine(c)).toContain('3 more estimated tickets')
	})

	it('should use the typical ticket, not the one disaster', () => {
		// Four honest tickets and one that went very wrong: the total ratio is
		// dragged, the median is not — and the median is what you plan with.
		const c = calibrate([t('A', 60, 66), t('B', 60, 60), t('C', 60, 72), t('D', 60, 60), t('E', 60, 1200)])
		expect(c.median).toBeCloseTo(1.1, 2)
		expect(c.ratio).toBeGreaterThan(4)
		expect(expect_(c, 120)).toBe(132)
	})

	it('should turn the number into something you can use at planning', () => {
		const c = calibrate([t('A', 60, 120), t('B', 60, 108), t('C', 60, 114), t('D', 60, 120), t('E', 60, 108)])
		const line = calibrationLine(c)!
		expect(line).toContain('1.9×')
		expect(line).toContain('Say two days, plan for 4 days')
	})

	it('should say so plainly when the estimates land', () => {
		const c = calibrate([t('A', 60, 60), t('B', 60, 62), t('C', 60, 58), t('D', 60, 60), t('E', 60, 61)])
		expect(calibrationLine(c)).toContain('Your estimates land')
	})

	it('should be able to say you are quicker than you think', () => {
		const c = calibrate([t('A', 120, 60), t('B', 120, 70), t('C', 120, 60), t('D', 120, 66), t('E', 120, 60)])
		expect(calibrationLine(c)).toContain('%')
		expect(c.median).toBeLessThan(1)
	})

	it('should ignore anything with half the numbers missing', () => {
		expect(calibrate([t('A', 0, 120), t('B', 60, 0)]).count).toBe(0)
		expect(calibrate([]).ratio).toBe(1)
	})

	it('should keep the best and the worst, because both are worth seeing', () => {
		const c = calibrate([t('A', 60, 30), t('B', 60, 240), t('C', 60, 60), t('D', 60, 60), t('E', 60, 60)])
		expect(c.under?.label).toBe('A')
		expect(c.over?.label).toBe('B')
	})
})
