import { describe, expect, it } from 'vitest'

import { deepLine, deepStats, dueBlock, hostOf, isStray, leftOf, progressOf, strayLine, strayMatch, suggestIntent, type Session } from './deepwork'
import { parseIst } from './time'

const started = parseIst('2026-10-15T10:00:00')
const session: Session = { startedAt: started, endsAt: started + 50 * 60_000, intent: 'the retry bug' }

describe('a block with one thing in it', () => {
	it('should count down and never go negative', () => {
		expect(leftOf(session, started + 10 * 60_000)).toBe(40)
		expect(leftOf(session, started + 90 * 60_000)).toBe(0)
	})

	it('should know how far through it is', () => {
		expect(progressOf(session, started + 25 * 60_000)).toBeCloseTo(0.5, 2)
		expect(progressOf(session, started - 1000)).toBe(0)
		expect(progressOf({ ...session, endsAt: started }, started)).toBe(1)
	})
})

describe('somewhere that is not the work', () => {
	it('should treat every face of a site as the same place', () => {
		expect(isStray('https://old.reddit.com/r/all')).toBe(true)
		expect(isStray('https://www.youtube.com/watch?v=x')).toBe(true)
		expect(hostOf('https://www.reddit.com/x')).toBe('reddit.com')
	})

	it('should not catch a site that merely ends in the same letters', () => {
		expect(isStray('https://notreddit.com')).toBe(false)
		expect(isStray('https://github.com/acme/api')).toBe(false)
	})

	it('should call every face of a site by the name on the list', () => {
		// Otherwise the nudge fires again on old.reddit.com, and then on
		// www.reddit.com, and then it gets switched off.
		expect(strayMatch('https://old.reddit.com/r/all')).toBe('reddit.com')
		expect(strayMatch('https://github.com')).toBeNull()
	})

	it('should take a list of your own', () => {
		expect(isStray('https://news.bbc.co.uk', ['bbc.co.uk'])).toBe(true)
		expect(isStray('https://reddit.com', ['bbc.co.uk'])).toBe(false)
	})

	it('should survive something that is not a URL', () => {
		expect(isStray('about:blank')).toBe(false)
		expect(hostOf('nonsense')).toBe('')
	})

	it('should say it once, plainly, without telling you off', () => {
		const line = strayLine(session, started + 12 * 60_000, 'reddit.com')
		expect(line).toBe('reddit.com — you are 38 minutes into “the retry bug”.')
	})
})

describe('what the week came to', () => {
	const list = [
		{ date: '2026-10-12', minutes: 50, finished: true },
		{ date: '2026-10-12', minutes: 25, finished: false },
		{ date: '2026-10-13', minutes: 90, finished: true },
		{ date: '2026-10-01', minutes: 50, finished: true },
	]

	it('should add up only the window asked for', () => {
		const s = deepStats(list, '2026-10-12', '2026-10-18')
		expect(s).toMatchObject({ minutes: 165, sessions: 3, finished: 2, longest: 90 })
	})

	it('should give a day a bar each, oldest first', () => {
		expect(deepStats(list, '2026-10-12', '2026-10-18').byDay).toEqual([
			{ date: '2026-10-12', minutes: 75 },
			{ date: '2026-10-13', minutes: 90 },
		])
	})

	it('should say nothing at all when there was no deep work', () => {
		expect(deepLine(deepStats([], '2026-10-12', '2026-10-18'))).toBeNull()
	})

	it('should report without inventing a target to miss', () => {
		const line = deepLine(deepStats(list, '2026-10-12', '2026-10-18'))!
		expect(line).toContain('2h 45m of focus across 3 blocks')
		expect(line).toContain('2 of 3 to the end')
		expect(line).not.toMatch(/should|target|goal/)
	})
})

describe('a block on the calendar rather than on your willpower', () => {
	const at = (time: string) => parseIst(`2026-10-12T${time}:00`) // a Monday
	const block = { id: 'b1', time: '10:00', minutes: 90, days: [1, 2, 3, 4, 5], enabled: true, intent: 'the hard thing' }

	it('should offer itself a couple of minutes before it starts', () => {
		expect(dueBlock([block], at('09:50'), at, '2026-10-12', 1)).toBeNull()
		expect(dueBlock([block], at('09:59'), at, '2026-10-12', 1)?.id).toBe('b1')
	})

	it('should still offer itself a few minutes late, and not an hour late', () => {
		expect(dueBlock([block], at('10:10'), at, '2026-10-12', 1)?.id).toBe('b1')
		expect(dueBlock([block], at('11:00'), at, '2026-10-12', 1)).toBeNull()
	})

	it('should speak once a day, and only on its own days', () => {
		expect(dueBlock([{ ...block, offeredOn: '2026-10-12' }], at('10:00'), at, '2026-10-12', 1)).toBeNull()
		expect(dueBlock([block], at('10:00'), at, '2026-10-17', 6)).toBeNull()
		expect(dueBlock([{ ...block, enabled: false }], at('10:00'), at, '2026-10-12', 1)).toBeNull()
	})
})

describe('what to spend the block on', () => {
	it('should put what is already running first, then the day’s goal', () => {
		const picks = suggestIntent({
			running: 'PAY-2433: the parser',
			goal: 'Ship the retry fix',
			planned: ['Verify on staging'],
			tasks: [{ title: 'Reply to the client', priority: 'normal' }],
		})
		expect(picks.map((p) => p.why)).toEqual(['the timer is already on it', "today's goal", 'you planned it last night', 'open'])
	})

	it('should put a task marked high above the rest', () => {
		const picks = suggestIntent({
			tasks: [
				{ title: 'Ordinary', priority: 'normal' },
				{ title: 'Urgent one', key: 'PAY-9', priority: 'high' },
			],
		})
		expect(picks[0]).toEqual({ text: 'PAY-9: Urgent one', why: 'marked high' })
	})

	it('should leave out anything blocked, and never repeat itself', () => {
		const picks = suggestIntent({
			goal: 'Ship the retry fix',
			planned: ['Ship the retry fix'],
			tasks: [{ title: 'Waiting on review', blocked: true, priority: 'high' }],
		})
		expect(picks).toHaveLength(1)
	})

	it('should offer nothing rather than noise when nothing is written down', () => {
		expect(suggestIntent({})).toEqual([])
	})
})
