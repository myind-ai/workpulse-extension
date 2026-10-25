import { describe, expect, it } from 'vitest'

import { quietLinks, startedAndStopped, waitingLine, waitingOn } from './waiting'
import { parseIst } from './time'

const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10)
const entry = (date: string, text: string, minutes = 60) => ({ date, text, minutes })

describe('what you are waiting on somebody else for', () => {
	const tasks = [
		{ uid: 't1', title: 'Master-key ACL', key: 'PAY-3092', status: 'open', blocked: true, blockedAt: parseIst('2026-10-12T17:00:00'), createdAt: 0 },
		{ uid: 't2', title: 'Ordinary work', status: 'open', createdAt: 0 },
		{ uid: 't3', title: 'Finished', key: 'LEAP-1', status: 'done', blocked: true, createdAt: 0 },
	]
	const input = {
		today: '2026-10-16',
		tasks,
		entries: [entry('2026-10-12', 'PAY-3092: wrote it', 300)],
		workedDays: ['2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12'],
		dateOf,
	}

	it('should count the days, and the days you were actually here', () => {
		// Three days blocked over a weekend is not the same complaint as three
		// days blocked at your desk.
		const [first] = waitingOn(input)
		expect(first).toMatchObject({ key: 'PAY-3092', days: 4, hereDays: 5, minutes: 300 })
	})

	it('should leave out what is not blocked, and what is finished', () => {
		expect(waitingOn(input)).toHaveLength(1)
	})

	it('should not count a weekend you were not here for', () => {
		const quiet = waitingOn({ ...input, workedDays: ['2026-10-16', '2026-10-12'] })
		expect(quiet[0].hereDays).toBe(2)
		expect(quiet[0].days).toBe(4)
	})

	it('should say the one thing worth saying, or nothing at all', () => {
		expect(waitingLine(waitingOn(input))).toBe('PAY-3092 has been waiting 5 working days.')
		expect(waitingLine([])).toBeNull()
	})
})

describe('what you started and stopped', () => {
	const tickets = [
		{ id: 'a', name: 'PAY-2901 refunds', at: parseIst('2026-09-20T09:00:00'), tabs: [{}, {}, {}], notes: [{}] },
		{ id: 'b', name: 'PAY-3092 ACL', at: parseIst('2026-10-15T09:00:00'), tabs: [{}] },
		{ id: 'c', name: 'Empty one', at: parseIst('2026-09-01T09:00:00'), tabs: [] },
		{ id: 'd', name: 'Archived', at: parseIst('2026-09-01T09:00:00'), tabs: [{}], archivedAt: 1 },
	]
	const input = { today: '2026-10-16', tickets, entries: [entry('2026-10-15', 'PAY-3092: carried on')], dateOf }

	it('should find the one with material on it and nothing logged since', () => {
		const stale = startedAndStopped(input)
		expect(stale.map((t) => t.id)).toEqual(['a'])
		expect(stale[0]).toMatchObject({ links: 3, notes: 1, minutes: 0 })
		expect(stale[0].quietDays).toBeGreaterThan(20)
	})

	it('should not call a name with nothing in it abandoned work', () => {
		// A ticket with nothing saved under it is a name, not a debt.
		expect(startedAndStopped(input).some((t) => t.id === 'c')).toBe(false)
		expect(startedAndStopped(input).some((t) => t.id === 'd')).toBe(false)
	})
})

describe('a link that has gone quiet', () => {
	const at = parseIst('2026-10-05T09:00:00')
	const tickets = [
		{
			id: 'a',
			name: 'PAY-3092 ACL',
			at,
			tabs: [
				{ title: 'Pull request', url: 'https://github.com/acme/api/pull/3033', note: 'the PR', addedAt: at },
				{ title: 'Design', url: 'https://figma.com/file/x', addedAt: at },
			],
		},
	]

	it('should notice the pull request, and leave the design alone', () => {
		// A doc sitting still is a doc. A PR sitting still is a question.
		const quiet = quietLinks({ today: '2026-10-16', tickets, entries: [], dateOf })
		expect(quiet).toHaveLength(1)
		expect(quiet[0]).toMatchObject({ ticket: 'PAY-3092 ACL', title: 'the PR', days: 11 })
	})

	it('should say nothing about a link saved this morning', () => {
		const fresh = [{ ...tickets[0], tabs: [{ ...tickets[0].tabs[0], addedAt: parseIst('2026-10-16T09:00:00') }] }]
		expect(quietLinks({ today: '2026-10-16', tickets: fresh, entries: [], dateOf })).toEqual([])
	})
})
