import { describe, expect, it } from 'vitest'

import { parseJsonl } from './bridge'
import { brainLearnings, fromBrain } from './bridge-learn'
import { repeats } from './learn'

const AT = Date.UTC(2026, 9, 25, 10, 0)
const line = (o: Record<string, unknown>) => JSON.stringify({ id: 'x', at: AT, kind: 'note', title: 't', ...o })

describe('Brain entries in the Learnings list', () => {
	const entries = parseJsonl(
		[
			line({ id: 'a', kind: 'mistake', title: 'Enter key path #forms', rootCause: 'fixed one path', ticket: 'PAY-1' }),
			line({ id: 'b', kind: 'learning', title: 'ETags are free #github' }),
			line({ id: 'c', kind: 'debug', title: 'CORS on preview' }),
			line({ id: 'd', kind: 'ticket', title: 'The whole ticket' }),
			line({ id: 'e', kind: 'report', title: 'Week' }),
		].join('\n'),
	)

	it('keeps learnings, mistakes and how-tos, and leaves tickets and reports on the Brain page', () => {
		const got = brainLearnings(entries)
		expect(got.map((l) => [l.id, l.kind])).toEqual([
			['brain:a', 'mistake'],
			['brain:b', 'learning'],
			['brain:c', 'howto'],
		])
		expect(got.every(fromBrain)).toBe(true)
	})

	it('puts the root cause in the line and links the ticket by its key', () => {
		const [m] = brainLearnings(entries, [{ id: 'w1', key: 'PAY-1' }])
		expect(m.text).toBe('Enter key path #forms — fixed one path')
		expect(m.ticketId).toBe('w1')
		expect(m.date).toBe('2026-10-25')
	})

	it('leaves out the copies of this browser’s own Learnings, which the list already holds', () => {
		const copy = parseJsonl(line({ id: 'journal:l1', kind: 'mistake', title: 'mine' }))
		expect(brainLearnings(copy)).toEqual([])
	})

	it('counts towards "keeps coming back" alongside local mistakes', () => {
		const local = { id: 'l1', date: '2026-10-24', at: AT - 86_400_000, kind: 'mistake' as const, text: 'again #forms', tags: ['forms'] }
		expect(repeats([local, ...brainLearnings(entries)], AT)).toEqual([expect.objectContaining({ tag: 'forms', count: 2 })])
	})
})
