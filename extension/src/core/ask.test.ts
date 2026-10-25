import { describe, expect, it } from 'vitest'

import { ASK_AT_MOST, askText, shouldAsk, type AskState } from './ask'
import { parseIst } from './time'

const NOW = parseIst('2026-10-13T11:00:00')
const state = (patch: Partial<AskState> = {}): AskState => ({ now: NOW, activeDays: 20, wins: 9, asked: 0, busy: false, ...patch })

describe('when it is fair to ask', () => {
	it('should ask once it has actually done something, over a stretch of days', () => {
		expect(shouldAsk(state())).toBe(true)
	})

	it('should not ask a stranger', () => {
		expect(shouldAsk(state({ activeDays: 3 }))).toBe(false)
		expect(shouldAsk(state({ wins: 1 }))).toBe(false)
	})

	it('should never interrupt something already on screen', () => {
		expect(shouldAsk(state({ busy: true }))).toBe(false)
	})

	it('should take no for an answer, permanently', () => {
		expect(shouldAsk(state({ dismissedForever: true }))).toBe(false)
		// Even years later, and even if it has done far more since.
		expect(shouldAsk(state({ dismissedForever: true, activeDays: 500, wins: 300, now: NOW + 5 * 365 * 86_400_000 }))).toBe(false)
	})

	it('should leave a season between asks', () => {
		expect(shouldAsk(state({ asked: 1, lastAskedAt: NOW - 30 * 86_400_000 }))).toBe(false)
		expect(shouldAsk(state({ asked: 1, lastAskedAt: NOW - 100 * 86_400_000 }))).toBe(true)
	})

	it('should stop asking after three times, whatever happens', () => {
		expect(shouldAsk(state({ asked: ASK_AT_MOST, lastAskedAt: NOW - 400 * 86_400_000 }))).toBe(false)
	})
})

describe('what it says', () => {
	it('should justify itself with what it did, not with a plea', () => {
		const text = askText({ wins: 12, activeDays: 40 })
		expect(text).toContain('12 timesheets')
		expect(text).toContain('40 days')
		expect(text).not.toMatch(/please|help us|support us so|we need/i)
	})

	it('should get the singular right', () => {
		expect(askText({ wins: 1, activeDays: 10 })).toContain('1 timesheet for you')
	})
})
