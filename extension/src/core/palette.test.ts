import { describe, expect, it } from 'vitest'

import { canSubmit, footerFor, MODES, modeFor, nextMode } from './palette'

describe('the box on every page', () => {
	it('should take the prefixes people already know', () => {
		expect(modeFor('> fixed the retry bug', 'go')).toEqual({ mode: 'log', text: 'fixed the retry bug' })
		expect(modeFor('#never trust the cache', 'go')).toEqual({ mode: 'learn', text: 'never trust the cache' })
		expect(modeFor('@the total ignores the discount', 'go')).toEqual({ mode: 'page', text: 'the total ignores the discount' })
		expect(modeFor('/backup', 'log')).toEqual({ mode: 'go', text: 'backup' })
		expect(modeFor('! call the bank', 'go')).toEqual({ mode: 'task', text: 'call the bank' })
	})

	it('should leave ordinary words in whatever mode you are in', () => {
		expect(modeFor('the retry bug', 'log')).toEqual({ mode: 'log', text: 'the retry bug' })
	})

	it('should go round with Tab, and back with Shift+Tab', () => {
		expect(nextMode('go')).toBe('log')
		expect(nextMode('focus')).toBe('go')
		expect(nextMode('go', true)).toBe('focus')
	})

	it('should want words before a page note means anything', () => {
		expect(canSubmit('page', '', false)).toBe(false)
		expect(canSubmit('page', 'the total ignores the discount', false)).toBe(true)
	})

	it('should refuse Enter until there is something to do', () => {
		expect(canSubmit('log', '', false)).toBe(false)
		expect(canSubmit('log', 'a', false)).toBe(false)
		expect(canSubmit('log', 'the retry bug', false)).toBe(true)
		// Going somewhere needs a destination picked, not words typed.
		expect(canSubmit('go', 'backup', false)).toBe(false)
		expect(canSubmit('go', 'backup', true)).toBe(true)
		// A block needs nothing at all.
		expect(canSubmit('focus', '', false)).toBe(true)
	})

	it('should say what Enter will do, or what the mode is for', () => {
		expect(footerFor('learn', '', false)).toContain('worth remembering')
		expect(footerFor('learn', 'never trust the cache', false)).toContain('learnings')
		expect(footerFor('page', 'the total is wrong', false)).toContain('this page')
	})
})

describe('tab groups, from the box', () => {
	it('should take the * prefix straight to the group mode', () => {
		expect(modeFor('*payments review', 'go')).toEqual({ mode: 'group', text: 'payments review' })
	})

	it('should offer the group mode in the row of modes', () => {
		const spec = MODES.find((m) => m.id === 'group')
		expect(spec?.label).toBe('Tab group')
		// Both directions in one mode: no text still means something (your groups).
		expect(spec?.needsText).toBe(false)
	})

	it('should reach the group mode by tabbing round', () => {
		expect(MODES.map((m) => m.id)).toContain('group')
	})
})

describe('save context mode', () => {
	it('is reached with + and needs words', () => {
		expect(modeFor('+ retry fix half done', 'go')).toEqual({ mode: 'brain', text: 'retry fix half done' })
		expect(canSubmit('brain', 'x', false)).toBe(false)
		expect(canSubmit('brain', 'retry fix', false)).toBe(true)
	})
})
