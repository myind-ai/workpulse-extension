import { describe, expect, it } from 'vitest'

import { activity, draft, MAX_VISIT_MIN, site, ticketsIn, type Visit } from './history'
import { parseIst } from './time'

const FROM = parseIst('2026-10-13T10:00:00')
const TO = parseIst('2026-10-13T11:00:00')
const at = (mins: number) => FROM + mins * 60_000
const visit = (mins: number, url: string, title = ''): Visit => ({ at: at(mins), url, title })

describe('an hour, grouped', () => {
	const hour = [
		visit(0, 'https://jira.acme.com/browse/PAY-2433', 'PAY-2433 financing button'),
		visit(10, 'https://github.com/acme/api/pull/812', 'Add the financing button by someone · PAY-2433'),
		visit(35, 'https://stackoverflow.com/questions/1', 'How to parse a CSV'),
		visit(50, 'https://news.site/article', 'Something else entirely'),
	]

	it('should weigh a visit by the gap to the next one', () => {
		const out = activity(hour, FROM, TO, ['PAY'])
		expect(out.find((g) => g.label === 'PAY-2433')!.minutes).toBe(35) // 10 + 25
		expect(out.find((g) => g.label === 'stackoverflow.com')!.minutes).toBe(15)
		expect(out.find((g) => g.label === 'news.site')!.minutes).toBe(10) // to the end of the slot
	})

	it('should group by ticket key when the page names one', () => {
		const out = activity(hour, FROM, TO, ['PAY'])
		const ticket = out.find((g) => g.label === 'PAY-2433')!
		expect(ticket.ticket).toBe(true)
		expect(ticket.urls).toHaveLength(2) // the ticket and the PR
	})

	it('should fall back to the site when there is no key', () => {
		expect(activity([visit(0, 'https://docs.acme.com/x', 'Docs')], FROM, TO).map((g) => g.label)).toEqual(['docs.acme.com'])
	})

	it('should not credit a tab left open overnight with the whole night', () => {
		const long = [visit(0, 'https://docs.acme.com/x', 'Docs'), visit(59, 'https://other.com', 'Other')]
		expect(activity(long, FROM, TO)[0].minutes).toBe(MAX_VISIT_MIN)
	})

	it('should leave out the browser’s own pages and a search box', () => {
		const noise = [
			visit(0, 'chrome://extensions', 'Extensions'),
			visit(5, 'chrome-extension://abc/dashboard.html', 'WorkPulse'),
			visit(10, 'https://www.google.com/search?q=csv', 'csv - Google Search'),
			visit(20, 'https://docs.acme.com/x', 'Docs'),
		]
		expect(activity(noise, FROM, TO).map((g) => g.label)).toEqual(['docs.acme.com'])
	})

	it('should ignore what happened outside the hour', () => {
		const spread = [visit(-30, 'https://a.com', 'Before'), visit(30, 'https://b.com', 'During'), visit(90, 'https://c.com', 'After')]
		expect(activity(spread, FROM, TO).map((g) => g.label)).toEqual(['b.com'])
	})

	it('should drop a glance of under two minutes', () => {
		const glance = [visit(0, 'https://a.com', 'A'), visit(1, 'https://b.com', 'B'), visit(2, 'https://a.com', 'A again')]
		expect(activity(glance, FROM, TO).map((g) => g.label)).toEqual(['a.com'])
	})

	it('should put the biggest first, and a ticket above a site of the same size', () => {
		const tie = [visit(0, 'https://jira/browse/PAY-1', 'PAY-1'), visit(30, 'https://docs.com/a', 'Docs')]
		expect(activity(tie, FROM, TO, ['PAY'])[0].label).toBe('PAY-1')
	})

	it('should say nothing for an hour with nothing in it', () => {
		expect(activity([], FROM, TO)).toEqual([])
	})
})

describe('the first draft it offers', () => {
	it('should name tickets by key and pages by title', () => {
		const groups = activity(
			[visit(0, 'https://jira/browse/PAY-2433', 'PAY-2433 financing'), visit(30, 'https://docs.acme.com/x', 'CSV import guide')],
			FROM,
			TO,
			['PAY'],
		)
		expect(draft(groups)).toBe('PAY-2433; CSV import guide')
	})

	it('should stay short enough to be a prompt rather than an essay', () => {
		const many = Array.from({ length: 8 }, (_, i) => visit(i * 7, `https://site${i}.com/p`, `Page ${i}`))
		expect(draft(activity(many, FROM, TO)).split(';')).toHaveLength(3)
	})

	it('should hand back the tickets it saw, for filing the links', () => {
		const groups = activity([visit(0, 'https://jira/browse/PAY-1', 'PAY-1'), visit(30, 'https://docs.com/a', 'Docs')], FROM, TO, ['PAY'])
		expect(ticketsIn(groups)).toEqual(['PAY-1'])
	})
})

describe('reading a host out of a url', () => {
	it('should drop the www and keep the rest', () => {
		expect(site('https://www.github.com/a/b')).toBe('github.com')
		expect(site('not a url')).toBe('not a url')
	})
})
