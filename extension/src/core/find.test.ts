import { describe, expect, it } from 'vitest'

import { countKinds, findAll, type Haystack } from './find'

const hay: Haystack = {
	entries: [
		{ date: '2026-10-12', text: 'PAY-2433: the division lookup threw a null pointer', slotStart: 3 },
		{ date: '2026-10-13', text: 'LEAP-12: the migration', slotStart: 4 },
	],
	notes: [{ ticketId: 'w1', ticketName: 'PAY-2433 financing', date: '2026-10-12', text: 'Division has to resolve before the settings lookup', at: 5 }],
	learnings: [{ id: 'l1', date: '2026-10-12', text: 'Null pointer came from a missing division', kind: 'mistake', at: 6 }],
	tickets: [{ id: 'w1', name: 'PAY-2433 financing', at: 1 }],
	links: [{ ticketId: 'w1', ticketName: 'PAY-2433 financing', title: 'PR #812', url: 'https://github.com/acme/api/pull/812', note: 'the division fix', addedAt: 2 }],
	tasks: [{ uid: 't1', title: 'Verify the division on staging', key: 'PAY-2433', status: 'open', createdAt: 7 }],
	pages: [{ number: 3, title: 'Orders', text: 'The total ignores the discount', url: 'https://stage.acme.com/orders', at: 8 }],
}

describe('where did I write that down', () => {
	it('should look in every place at once', () => {
		const kinds = new Set(findAll('division', hay).map((h) => h.kind))
		expect(kinds).toEqual(new Set(['entry', 'note', 'learning', 'link', 'task']))
	})

	it('should want every word, not any of them', () => {
		// "null pointer" must not drag in everything that says "the".
		const hits = findAll('null pointer', hay)
		expect(hits).toHaveLength(2)
		expect(hits.every((h) => h.text.toLowerCase().includes('null'))).toBe(true)
	})

	it('should put the whole phrase above the scattered words', () => {
		const scattered = { ...hay, entries: [...hay.entries, { date: '2026-10-14', text: 'Pointer arithmetic, and a null check elsewhere', slotStart: 9 }] }
		expect(findAll('null pointer', scattered)[0].text.toLowerCase()).toContain('null pointer')
	})

	it('should say where each one came from', () => {
		const note = findAll('settings lookup', hay)[0]
		expect(note).toMatchObject({ kind: 'note', where: 'PAY-2433 financing', hash: '#/links/w1', date: '2026-10-12' })
	})

	it('should carry a link straight to the thing', () => {
		const link = findAll('division fix', hay)[0]
		expect(link.url).toBe('https://github.com/acme/api/pull/812')
	})

	it('should find what a teammate said on a page', () => {
		expect(findAll('discount', hay)[0]).toMatchObject({ kind: 'page', where: 'Orders' })
	})

	it('should not answer a single letter', () => {
		expect(findAll('a', hay)).toEqual([])
		expect(findAll('   ', hay)).toEqual([])
	})

	it('should count what it found, for the filters', () => {
		expect(countKinds(findAll('division', hay))[0].count).toBeGreaterThan(0)
	})
})

describe('brain entries in the one search', () => {
	it('finds a Brain entry by its root cause and opens its ticket', () => {
		const hits = findAll('idempotency', {
			entries: [], notes: [], learnings: [], tickets: [], links: [], tasks: [],
			brain: [{ id: 'e1', title: 'Webhook retry fails', kind: 'Debugging', ticket: 'PAY-2433', more: 'old idempotency key reused', at: 1 }],
		})
		expect(hits).toHaveLength(1)
		expect(hits[0]).toMatchObject({ kind: 'brain', text: 'Webhook retry fails', where: 'Debugging · PAY-2433', hash: '#/brain/PAY-2433' })
	})
})
