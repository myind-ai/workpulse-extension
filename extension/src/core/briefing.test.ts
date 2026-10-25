import { describe, expect, it } from 'vitest'

import { briefing, dayReview, suggest, type BriefingInput } from './briefing'
import { parseIst } from './time'
import type { Entry, Issue, Task } from './types'

const NOW = parseIst('2026-10-13T09:30:00') // Tuesday morning

const entry = (date: string, from: string, text: string, minutes: number, jobId?: string): Entry => ({
	uid: `${date}${from}`,
	date,
	slotStart: parseIst(`${date}T${from}:00`),
	slotEnd: parseIst(`${date}T${from}:00`) + minutes * 60_000,
	text,
	jobId,
	minutes,
	kind: 'work',
	synced: false,
})

const task = (title: string, patch: Partial<Task> = {}): Task => ({
	uid: title,
	title,
	status: 'todo',
	createdAt: parseIst('2026-10-12T09:00:00'),
	spentMinutes: 0,
	...patch,
})

const input = (patch: Partial<BriefingInput> = {}): BriefingInput => ({
	today: '2026-10-13',
	about: '2026-10-12',
	now: NOW,
	entries: [entry('2026-10-12', '09:00', 'PAY-2433 wrote the parser', 120, 'j1'), entry('2026-10-12', '14:00', 'Reviewed the deploy', 45, 'j2')],
	jobs: [
		{ id: 'j1', name: 'Payments', project: 'Core' },
		{ id: 'j2', name: 'Platform', project: 'Core' },
	],
	tasks: [task('Finish the parser', { key: 'PAY-2433' }), task('Something else')],
	tickets: [{ name: 'PAY-2433 financing' }],
	pendingDays: [],
	issues: [],
	...patch,
})

describe('the morning briefing', () => {
	it('should say what the last worked day went on', () => {
		const b = briefing(input())
		expect(b.about).toBe('2026-10-12')
		expect(b.yesterday.map((l) => [l.label, l.minutes])).toEqual([
			['PAY-2433', 120],
			['Platform', 45],
		])
		expect(b.minutes).toBe(165)
	})

	it('should count as unfinished only what was already open yesterday', () => {
		const fresh = task('Added this morning', { createdAt: parseIst('2026-10-13T09:00:00') })
		const b = briefing(input({ tasks: [...input().tasks, fresh] }))
		expect(b.unfinished).toContain('PAY-2433 — Finish the parser')
		expect(b.unfinished).not.toContain('Added this morning')
	})

	it('should carry the goal you set', () => {
		expect(briefing(input({ plan: { date: '2026-10-13', goal: 'Get the retry fix verified' } })).goal).toBe('Get the retry fix verified')
	})
})

describe('what to start with', () => {
	const first = (patch: Partial<BriefingInput> = {}) => briefing(input(patch)).suggested

	it('should put what you decided last night above anything a computer noticed', () => {
		const out = first({ plan: { date: '2026-10-13', todos: ['Address the review comments', 'Verify on staging'] } })
		expect(out[0]).toEqual({ title: 'Address the review comments', why: 'You lined this up as your first task yesterday evening' })
	})

	it('should raise a reminder whose time has passed', () => {
		const out = first({ tasks: [task('Call the vendor', { remindAt: parseIst('2026-10-13T09:00:00') })] })
		expect(out[0].why).toMatch(/asked to be reminded/)
	})

	it('should offer to pick up what you spent yesterday on', () => {
		expect(first().some((s) => s.title === 'PAY-2433 — Finish the parser' && /2h on this yesterday/.test(s.why))).toBe(true)
	})

	it('should name an obligation with a deadline', () => {
		const out = first({ pendingDays: ['2026-10-12', '2026-10-09'] })
		expect(out.some((s) => s.title === 'Send 2 days of time logs to Zoho')).toBe(true)
		const one = first({ pendingDays: ['2026-10-12'] })
		expect(one.some((s) => s.title === 'Send yesterday’s time logs to Zoho')).toBe(true)
	})

	it('should mention regularisation when days are outstanding', () => {
		const issues: Issue[] = [{ date: '2026-10-09', kind: 'missing_checkout', detail: 'x', firstSeen: 1 }]
		expect(first({ issues }).some((s) => s.title === 'Fix 1 attendance day')).toBe(true)
	})

	it('should fall back to the most important thing still open', () => {
		const out = first({ entries: [], tasks: [task('Low thing', { priority: 'low' }), task('Big thing', { priority: 'high' })] })
		expect(out[0]).toEqual({ title: 'Big thing', why: 'Your highest-priority open task' })
	})

	it('should never offer more than three, or something blocked', () => {
		const many = first({
			plan: { date: '2026-10-13', todos: ['One'] },
			pendingDays: ['2026-10-12'],
			issues: [{ date: 'x', kind: 'absent', detail: '', firstSeen: 1 }],
			tasks: [task('Waiting on someone', { blocked: true, priority: 'high' })],
		})
		expect(many).toHaveLength(3)
		expect(many.some((s) => s.title === 'Waiting on someone')).toBe(false)
	})

	it('should not say the same thing twice', () => {
		const out = suggest(input({ plan: { date: '2026-10-13', todos: ['PAY-2433 — Finish the parser'] } }), [{ label: 'PAY-2433', minutes: 120, said: [] }], [task('Finish the parser', { key: 'PAY-2433' })])
		expect(out.filter((s) => s.title === 'PAY-2433 — Finish the parser')).toHaveLength(1)
	})

	it('should say nothing rather than invent something on a clean slate', () => {
		expect(first({ entries: [], tasks: [], pendingDays: [], issues: [] })).toEqual([])
	})
})

describe('the end-of-day review', () => {
	const base = {
		date: '2026-10-13',
		entries: [entry('2026-10-13', '09:00', 'PAY-2433 shipped the parser', 120, 'j1')],
		jobs: input().jobs,
		tickets: input().tickets,
		elapsed: 180,
		pendingDays: ['2026-10-13'],
	}

	it('should say what the day went on and what is still open', () => {
		const r = dayReview({ ...base, tasks: [task('Done thing', { status: 'done', doneAt: parseIst('2026-10-13T15:00:00') }), task('Open thing')] })
		expect(r.worked.map((l) => l.label)).toEqual(['PAY-2433'])
		expect(r.done).toEqual(['Done thing'])
		expect(r.open).toEqual(['Open thing'])
	})

	it('should show the time on the clock that never became an entry', () => {
		expect(dayReview({ ...base, tasks: [] }).unlogged).toBe(60)
		expect(dayReview({ ...base, tasks: [], elapsed: 90 }).unlogged).toBe(0) // never negative
	})

	it('should not count something finished on another day', () => {
		const old = task('Yesterday’s win', { status: 'done', doneAt: parseIst('2026-10-12T15:00:00') })
		expect(dayReview({ ...base, tasks: [old] }).done).toEqual([])
	})

	it('should carry the goal and its verdict', () => {
		const r = dayReview({ ...base, tasks: [], plan: { date: '2026-10-13', goal: 'Ship it', verdict: 'partly' } })
		expect(r).toMatchObject({ goal: 'Ship it', verdict: 'partly' })
	})
})
