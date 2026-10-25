import { describe, expect, it } from 'vitest'

import { handover, handoverText, type Handover } from './handover'

const h: Handover = handover({
	from: '2026-10-19',
	to: '2026-10-23',
	who: 'Shantanu',
	tickets: [
		{
			id: 'w2',
			name: 'LEAP-12 migration',
			minutes: 60,
			lastAt: 10,
			said: ['ran it on dev'],
			links: [],
			notes: [],
			open: [],
			watchOut: [],
		},
		{
			id: 'w1',
			name: 'PAY-2433 financing',
			minutes: 540,
			lastAt: 99,
			said: ['wrote the parser', 'the division lookup was wrong'],
			links: [{ title: 'PR #812', url: 'https://github.com/acme/api/pull/812', note: 'the PR, waiting on review' }],
			notes: [{ date: '2026-10-16', text: '# Where it stands\nBehind the flag on stage, not switched on' }],
			open: ['Verify on staging'],
			watchOut: ['The division must resolve before the settings lookup'],
		},
	],
	loose: ['Reply to the client about the invoice'],
	meetings: [{ name: 'Standup', time: '09:45', days: [1, 2, 3, 4, 5] }],
})

describe('cover notes for whoever picks it up', () => {
	it('should lead with what you touched most recently', () => {
		expect(h.tickets.map((t) => t.name)).toEqual(['PAY-2433 financing', 'LEAP-12 migration'])
	})

	it('should read in the order the person covering needs it', () => {
		const text = handoverText(h)
		expect(text.indexOf('Where it got to')).toBeLessThan(text.indexOf('What will catch you out'))
		expect(text.indexOf('What will catch you out')).toBeLessThan(text.indexOf('Links'))
	})

	it('should carry the label you wrote on a link, not the page title', () => {
		expect(handoverText(h)).toContain('[the PR, waiting on review](https://github.com/acme/api/pull/812)')
	})

	it('should cut a page of notes down to what can be read in a minute', () => {
		expect(handoverText(h)).toContain('Where it stands · Behind the flag on stage, not switched on')
	})

	it('should name the meetings someone has to cover', () => {
		expect(handoverText(h)).toContain('Standup · 09:45 · Mon, Tue, Wed, Thu, Fri')
	})

	it('should say so plainly when there is nothing to hand over', () => {
		expect(handoverText({ ...h, tickets: [], loose: [] })).toContain('Nothing open. Enjoy it.')
	})
})
