import { describe, expect, it } from 'vitest'

import { MAX_DESCRIPTION, novelWords, parseDraft, promptFor, reasonPrompt, SYSTEM } from './draft'

describe('drafting a timesheet without drafting the hours', () => {
	it('should put the hours in the prompt but never ask for them back', () => {
		const p = promptFor([{ jobName: 'LEAP', minutes: 90, description: 'webhook retry' }])
		expect(p).toContain('90 min')
		expect(SYSTEM).toContain('Rewrite ONLY the description')
		expect(SYSTEM).toContain('JSON array of strings')
	})

	it('should forbid invention in the instructions, not only in review', () => {
		expect(SYSTEM).toContain('Add nothing.')
		expect(SYSTEM).toContain('Never invent')
		expect(SYSTEM).toContain('Do not improve the work, only the sentence.')
	})

	it('should name a row that has nothing written rather than leaving it blank', () => {
		expect(promptFor([{ jobName: 'X', minutes: 30, description: '' }])).toContain('(nothing written)')
	})

	it('should tolerate the code fence models add whatever you ask', () => {
		const r = parseDraft('```json\n["one","two"]\n```', 2)
		expect(r.ok && r.rows).toEqual(['one', 'two'])
	})

	it('should discard the whole draft when the row count is wrong', () => {
		const r = parseDraft('["only one"]', 3)
		// A row silently left as the original among rewritten rows is undetectable.
		expect(r.ok).toBe(false)
		expect(!r.ok && r.why).toContain('Nothing has been changed')
	})

	it('should discard a draft with an empty row rather than merge half of it', () => {
		const r = parseDraft('["fine", "   "]', 2)
		expect(r.ok).toBe(false)
	})

	it('should refuse anything that is not a list of strings', () => {
		expect(parseDraft('not json', 1).ok).toBe(false)
		expect(parseDraft('{"a":1}', 1).ok).toBe(false)
		expect(parseDraft('[1,2]', 2).ok).toBe(false)
	})

	it('should cap a description at a timesheet cell, not an essay', () => {
		const long = 'x'.repeat(500)
		const r = parseDraft(JSON.stringify([long]), 1)
		expect(r.ok && r.rows[0].length).toBe(MAX_DESCRIPTION)
	})

	it('should spot a ticket key that arrived from nowhere', () => {
		expect(novelWords('fixed the retry', 'Fixed retry on PAY-2433')).toContain('pay-2433')
	})

	it('should not cry invention over ordinary English', () => {
		expect(novelWords('webhook retry', 'Fixed the webhook retry')).toEqual([])
	})
})

describe('the regularisation sentence', () => {
	it('should forbid inventing a reason nobody gave', () => {
		expect(reasonPrompt({ date: '2026-10-13', missing: 'check-out', evidence: 'last entry ended 17:30', work: 'LEAP-19' })).toContain('check-out')
	})

	it('should leave out the lines it has nothing for', () => {
		const p = reasonPrompt({ date: '2026-10-13', missing: 'both punches', evidence: 'ticks', work: '' })
		expect(p).not.toContain('Work logged')
		expect(p).not.toContain('Recorded in')
	})
})
