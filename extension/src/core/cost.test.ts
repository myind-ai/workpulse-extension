import { describe, expect, it } from 'vitest'

import { interrupted, meetingCosts, meetingLine, recoveryCost, WEEKS, type Interruption } from './cost'

const m = (id: string, name: string, logMinutes: number, days: number[], heads?: number) => ({ id, name, logMinutes, days, enabled: true, heads })

describe('which meeting, not how many', () => {
	it('should cost a meeting from how it is actually scheduled', () => {
		// Five standups a week at 15 minutes is the one nobody adds up.
		const [standup] = meetingCosts([m('1', 'Standup', 15, [1, 2, 3, 4, 5])])
		expect(standup.perWeek).toBe(75)
		expect(standup.perYear).toBe(Math.round(((75 * WEEKS) / 60) * 10) / 10)
	})

	it('should put the most expensive first, which is rarely the longest', () => {
		const got = meetingCosts([m('1', 'Sprint review', 60, [5]), m('2', 'Standup', 15, [1, 2, 3, 4, 5])])
		expect(got[0].name).toBe('Standup')
	})

	it('should multiply by the room when somebody said how big it is', () => {
		const [got] = meetingCosts([m('1', 'All hands', 60, [5], 30)])
		expect(got.teamPerYear).toBe(Math.round(got.perYear * 30))
	})

	it('should ignore a meeting that is off or logs no time', () => {
		expect(meetingCosts([{ id: '1', name: 'Off', logMinutes: 60, days: [1], enabled: false }])).toEqual([])
		expect(meetingCosts([m('2', 'No time', 0, [1])])).toEqual([])
	})

	it('should say nothing about a meeting that is genuinely small', () => {
		// Ten minutes once a week is 7.7 hours a year — real, but not something
		// to take to anybody. Note how little it takes to pass the bar: half an
		// hour weekly is already 23 hours, which is the point of annualising.
		expect(meetingLine(meetingCosts([m('1', 'Quick sync', 10, [1])]))).toBeNull()
		expect(meetingLine(meetingCosts([m('2', 'Weekly', 30, [1])]))).toContain('23 hours')
	})

	it('should name one meeting, not rank them all', () => {
		const line = meetingLine(meetingCosts([m('1', 'Standup', 15, [1, 2, 3, 4, 5]), m('2', 'Review', 60, [5])]))
		expect(line).toContain('Standup')
		expect(line).not.toContain('Review')
	})
})

describe('what broke the block', () => {
	const i = (what: Interruption['what'], intent = 'a'): Interruption => ({ what, at: 1, intent })

	it('should stay quiet until there is a pattern rather than an anecdote', () => {
		expect(interrupted([i('A message'), i('A person')], 4).line).toBeNull()
	})

	it('should name the thing, not the person', () => {
		const got = interrupted([i('A message'), i('A message'), i('A message'), i('A person')], 6)
		expect(got.line).toContain('a message broke 3')
		// No "try harder", no count of personal failure.
		expect(got.line).not.toMatch(/you were interrupted|try|focus better/i)
	})

	it('should single out the one interruption that is actually a decision', () => {
		const got = interrupted([i('Myself'), i('Myself'), i('Myself'), i('A person')], 5)
		expect(got.line).toContain('were you')
		expect(got.line).toContain('do something about')
	})

	it('should share out the blame proportionally', () => {
		const got = interrupted([i('A message'), i('A message'), i('A person'), i('A person')], 4)
		expect(got.by[0].share).toBe(50)
	})
})

describe('what restarting costs', () => {
	it('should stay conservative, because an inflated number is easy to dismiss', () => {
		expect(recoveryCost(4).minutes).toBe(60)
		expect(recoveryCost(4).line).toContain('1 hours')
	})

	it('should say nothing about one or two interruptions', () => {
		expect(recoveryCost(2).line).toBeNull()
	})
})
