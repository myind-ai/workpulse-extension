import { describe, expect, it } from 'vitest'

import { board, memberPath, NO_TEAM, pollDue, shareDue, shareFile, shareMessage, slug, teamTotals, whoChanged, type SharedMember } from './team'

const SET = { ...NO_TEAM, repo: 'acme/team', member: 'shantanu' }
const DAY = {
	date: '2026-10-12',
	minutes: 420,
	in: '09:05',
	out: '18:30',
	lines: [{ label: 'PAY-2433', minutes: 300 }, { label: 'Standup', minutes: 30 }],
	learnings: [{ text: 'Check the division before the settings lookup', kind: 'mistake' }],
}

describe('what leaves this machine', () => {
	it('should share nothing at all until something is turned on', () => {
		const file = shareFile({ member: 'shantanu', now: 1, days: [DAY] }, SET)
		expect(file.days[0]).toEqual({ date: '2026-10-12' })
	})

	it('should share hours without what you were doing', () => {
		const file = shareFile({ member: 'shantanu', now: 1, days: [DAY] }, { ...SET, shareHours: true })
		expect(file.days[0]).toEqual({ date: '2026-10-12', minutes: 420, in: '09:05', out: '18:30' })
		expect(file.days[0].lines).toBeUndefined()
	})

	it('should share what you worked on without the hours', () => {
		const file = shareFile({ member: 'shantanu', now: 1, days: [DAY] }, { ...SET, shareWhat: true })
		expect(file.days[0].lines).toHaveLength(2)
		expect(file.days[0].minutes).toBeUndefined()
	})

	it('should keep learnings out unless they are asked for by name', () => {
		expect(shareFile({ member: 'me', now: 1, days: [DAY] }, { ...SET, shareHours: true, shareWhat: true }).days[0].learnings).toBeUndefined()
		expect(shareFile({ member: 'me', now: 1, days: [DAY] }, { ...SET, shareLearnings: true }).days[0].learnings).toHaveLength(1)
	})

	it('should give every member a file of their own, so two pushes cannot collide', () => {
		expect(memberPath('team', 'Shantanu B')).toBe('team/members/shantanu-b.json')
		expect(memberPath('/squad/', 'a@b.com')).toBe('squad/members/a-b.com.json')
		expect(slug('   ')).toBe('member')
	})
})

describe('the team board', () => {
	const files: SharedMember[] = [
		{ member: 'priya', at: 10, days: [{ date: '2026-10-12', minutes: 400, lines: [{ label: 'PAY-2433', minutes: 400 }] }] },
		{ member: 'shantanu', at: 20, days: [{ date: '2026-10-12', minutes: 420, lines: [{ label: 'PAY-2433', minutes: 120 }, { label: 'LEAP-12', minutes: 300 }] }] },
		{ member: 'alex', at: 30, days: [{ date: '2026-10-11', minutes: 60 }] },
	]

	it('should put you first and then go round by name', () => {
		expect(board(files, '2026-10-12', 'shantanu').map((r) => r.member)).toEqual(['shantanu', 'alex', 'priya'])
	})

	it('should say who has nothing down for the day rather than leaving them out', () => {
		const alex = board(files, '2026-10-12', 'shantanu').find((r) => r.member === 'alex')
		expect(alex?.quiet).toBe(true)
		expect(alex?.minutes).toBeUndefined()
	})

	it('should add the day up by ticket across everyone', () => {
		const totals = teamTotals(board(files, '2026-10-12', 'shantanu'))
		expect(totals).toMatchObject({ people: 3, logged: 2, minutes: 820 })
		expect(totals.tickets[0]).toEqual({ label: 'PAY-2433', minutes: 520 })
	})

	it('should name the share in the commit', () => {
		expect(shareMessage('Shantanu B', 3, '2026-10-12')).toBe('team: shantanu-b through 2026-10-12 (3 days)')
		expect(shareMessage('priya', 1, '2026-10-12')).toBe('team: priya through 2026-10-12')
	})
})

describe('pushed soon, not instantly', () => {
	const base = { on: true, now: 10 * 60_000, changedAt: 9 * 60_000 }

	it('should let a burst of changes gather into one push', () => {
		// A commit per saved entry is forty commits of noise a day across a team,
		// and four API calls each.
		expect(shareDue({ ...base, now: 9.5 * 60_000 })).toBe(false)
		expect(shareDue({ ...base, now: 11.5 * 60_000 })).toBe(true)
	})

	it('should go at once when the day is closed', () => {
		expect(shareDue({ ...base, now: 9.1 * 60_000, dayClosed: true })).toBe(true)
	})

	it('should do nothing when nothing has changed since the last push', () => {
		expect(shareDue({ ...base, lastPushAt: 9.5 * 60_000 })).toBe(false)
		expect(shareDue({ on: true, now: 10 * 60_000 })).toBe(false)
		expect(shareDue({ ...base, on: false })).toBe(false)
	})

	it('should back off after a failure rather than hammering GitHub', () => {
		const failed = { ...base, lastTryAt: 9.8 * 60_000, lastPushAt: 8 * 60_000 }
		expect(shareDue({ ...failed, now: 12 * 60_000 })).toBe(false)
		expect(shareDue({ ...failed, now: 25 * 60_000 })).toBe(true)
	})
})

describe('reading the others cheaply', () => {
	const listing = [
		{ name: 'priya.json', path: 'team/members/priya.json', sha: 'a1' },
		{ name: 'alex.json', path: 'team/members/alex.json', sha: 'b1' },
		{ name: 'README.md', path: 'team/members/README.md', sha: 'c1' },
	]

	it('should fetch only the files whose sha moved', () => {
		const { fetch } = whoChanged({ 'team/members/priya.json': 'a1', 'team/members/alex.json': 'b0' }, listing)
		expect(fetch).toEqual(['team/members/alex.json'])
	})

	it('should cost one request when nobody has pushed', () => {
		const seen = { 'team/members/priya.json': 'a1', 'team/members/alex.json': 'b1' }
		expect(whoChanged(seen, listing).fetch).toEqual([])
	})

	it('should fetch everything the first time, and ignore what is not a member', () => {
		const { fetch, shas } = whoChanged({}, listing)
		expect(fetch).toEqual(['team/members/priya.json', 'team/members/alex.json'])
		expect(Object.keys(shas)).toHaveLength(2)
	})

	it('should poll often while someone is looking and rarely when not', () => {
		// A minute while the board is open; a quarter of an hour when it is not.
		expect(pollDue({ now: 140_000, lastPollAt: 70_000, watching: true })).toBe(true)
		expect(pollDue({ now: 140_000, lastPollAt: 70_000, watching: false })).toBe(false)
		expect(pollDue({ now: 100_000, watching: false })).toBe(true) // never polled
	})
})
