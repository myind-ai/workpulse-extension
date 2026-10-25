import { describe, expect, it } from 'vitest'

import { assessPrompt, ASSESS_SYSTEM, checkCitations, evidenceFrom, scopeGrowth } from './assess'
import type { PeriodLine, PeriodReport } from './period'

const line = (label: string, minutes: number, said: string[] = ['did a thing'], over: Partial<PeriodLine> = {}): PeriodLine => ({
	label, minutes, days: 3, said, first: '2026-04-01', last: '2026-09-30', ...over,
})
const report = (lines: PeriodLine[]): PeriodReport => ({
	from: '2026-04-01', to: '2026-09-30', span: 'half', lines, minutes: lines.reduce((a, l) => a + l.minutes, 0),
	daysWorked: 120, learnings: [], finished: [], headline: lines.slice(0, 3),
})

describe('numbering the evidence', () => {
	it('should leave out work too small to argue anything from', () => {
		// Forty minutes across six months is noise, and including it invites the
		// model to make something of it.
		const got = evidenceFrom(report([line('LEAP-19', 600), line('TINY-1', 40)]))
		expect(got.map((e) => e.label)).toEqual(['LEAP-19'])
	})

	it('should number from one, because people read these', () => {
		const got = evidenceFrom(report([line('A', 600), line('B', 600)]))
		expect(got.map((e) => e.n)).toEqual([1, 2])
	})

	it('should carry the ticket name when one is known', () => {
		expect(evidenceFrom(report([line('LEAP-19', 600, ['x'], { name: 'Webhook retry' })]))[0].label).toBe('LEAP-19 — Webhook retry')
	})

	it('should put your own lines into the prompt, because they are the evidence', () => {
		const p = assessPrompt(evidenceFrom(report([line('LEAP-19', 600, ['fixed the retry', 'reviewed it'])])), '2026-04-01', '2026-09-30')
		expect(p).toContain('[1] LEAP-19')
		expect(p).toContain('· fixed the retry')
		expect(p).toContain('10 hours over 3 days')
	})

	it('should make the citation rule absolute in the instructions', () => {
		expect(ASSESS_SYSTEM).toContain('EVERY sentence that makes a claim must end with a citation')
		expect(ASSESS_SYSTEM).toContain('Never invent a number')
		expect(ASSESS_SYSTEM).toContain('Do not reach')
	})
})

describe('cite, or do not claim', () => {
	it('should pass a draft where every claim points at real evidence', () => {
		const got = checkCitations('## Webhooks\nRebuilt the retry path over ten hours [1].\nReviewed the change with the team [1,2].', 2)
		expect(got.ok).toBe(true)
		expect(got.uncited).toEqual([])
	})

	it('should catch the sentence the model reached for', () => {
		const got = checkCitations('## Impact\nThis reduced customer complaints significantly.\nRebuilt the retry path [1].', 2)
		expect(got.ok).toBe(false)
		expect(got.uncited).toEqual(['This reduced customer complaints significantly.'])
	})

	it('should catch a citation pointing at evidence that was never given', () => {
		const got = checkCitations('Did the work [7].', 2)
		expect(got.bogus).toEqual([7])
		expect(got.ok).toBe(false)
	})

	it('should not demand a citation from a heading or a rule', () => {
		expect(checkCitations('## Payments\n---\nBuilt the thing [1].', 1).ok).toBe(true)
	})

	it('should not demand a citation from a fragment that is not a claim', () => {
		expect(checkCitations('## Work\n- Payments\nRebuilt the retry path [1].', 1).ok).toBe(true)
	})

	it('should be honest that it only proves a sentence points somewhere', () => {
		// A claim that misreads its own evidence still passes. Nothing mechanical
		// can catch that, which is why the draft is shown beside its sources.
		expect(checkCitations('Single-handedly rescued the quarter [1].', 1).ok).toBe(true)
	})
})

describe('what changed, which is what a raise is argued on', () => {
	const then = report([line('LEAP-19', 600), line('OLD-1', 600)])
	const now = report([line('LEAP-19', 1200), line('PAY-2433', 900)])

	it('should name what is new without spinning it', () => {
		const g = scopeGrowth(then, now)
		expect(g.gained).toEqual(['PAY-2433'])
		expect(g.line).toContain('PAY-2433')
		expect(g.line).not.toMatch(/growth|impressive|strong/i)
	})

	it('should say what has gone, which is just as true and usually unsaid', () => {
		expect(scopeGrowth(then, now).left).toEqual(['OLD-1'])
	})

	it('should show the hours either side of what was kept', () => {
		expect(scopeGrowth(then, now).kept).toEqual([{ label: 'LEAP-19', then: 10, now: 20 }])
	})

	it('should say nothing when nothing is new', () => {
		expect(scopeGrowth(now, now).line).toBeNull()
	})
})
