import { describe, expect, it } from 'vitest'

import { canonicalUrl, countFor, EMPTY_INDEX, indexWith, issueBody, pageOf, pageTitle, shotPath, textOf, urlKey } from './page-notes'

describe('the same page, to two people', () => {
	it('should ignore the fragment, the tracking and the trailing slash', () => {
		const a = canonicalUrl('https://WWW.Stage.acme.com/orders/12/?utm_source=slack#row-4')
		expect(a).toBe('https://stage.acme.com/orders/12')
		expect(urlKey('https://stage.acme.com/orders/12')).toBe(urlKey(a))
	})

	it('should keep the parameters that decide what the page shows', () => {
		expect(canonicalUrl('https://acme.com/search?q=invoice&page=2')).toBe('https://acme.com/search?q=invoice&page=2')
	})

	it('should keep the root slash, which is the page', () => {
		expect(canonicalUrl('https://acme.com/')).toBe('https://acme.com/')
	})

	it('should survive something that is not a URL at all', () => {
		expect(canonicalUrl('  not a url ')).toBe('not a url')
	})

	it('should give the same key on every machine', () => {
		expect(urlKey('https://acme.com/a')).toBe(urlKey('https://acme.com/a'))
		expect(urlKey('https://acme.com/a')).not.toBe(urlKey('https://acme.com/b'))
		expect(urlKey('https://acme.com/a')).toHaveLength(12)
	})
})

describe('the issue a note becomes', () => {
	const note = { url: 'https://stage.acme.com/orders/12#x', text: 'The total ignores the discount.\nSteps: add a coupon.', author: 'shantanu', at: 1_760_000_000_000, where: 'Order summary' }

	it('should carry the page so anyone can find it again', () => {
		const body = issueBody(note)
		expect(pageOf(body)).toBe('https://stage.acme.com/orders/12')
	})

	it('should read back as what was written, without the scaffolding', () => {
		expect(textOf(issueBody(note))).toBe('The total ignores the discount.\nSteps: add a coupon.')
	})

	it('should link the screenshot, not just name a path', () => {
		// A path in backticks is something to go and find; a link is something to
		// click, and GitHub will not render a private repo's image inline.
		const body = issueBody({ ...note, shot: 'team/shots/2026-10-16-orders-a1b2.jpg', repo: 'acme/team', branch: 'main' })
		expect(body).toContain('[2026-10-16-orders-a1b2.jpg](https://github.com/acme/team/blob/main/team/shots/2026-10-16-orders-a1b2.jpg)')
	})

	it('should fall back to naming it when it does not know the repository', () => {
		expect(issueBody({ ...note, shot: 'team/shots/x.jpg' })).toContain('`team/shots/x.jpg`')
		expect(shotPath('team', 'abc', 7)).toBe('team/shots/abc-7.png')
	})

	it('should title itself from the page when the page has no title', () => {
		expect(pageTitle('', 'https://stage.acme.com/orders/12')).toBe('stage.acme.com/orders/12')
		expect(pageTitle('  Orders   · Acme ', 'x')).toBe('Orders · Acme')
	})
})

describe('knowing a page has notes without reading them', () => {
	it('should count the open and closed ones for a badge', () => {
		let index = indexWith(EMPTY_INDEX, 'https://acme.com/a#one', 4, 'open', 1)
		index = indexWith(index, 'https://acme.com/a', 9, 'open', 2)
		index = indexWith(index, 'https://acme.com/b', 11, 'open', 3)
		expect(countFor(index, 'https://acme.com/a?utm_source=x')).toEqual({ open: 2, closed: 0 })
		expect(countFor(index, 'https://acme.com/c')).toEqual({ open: 0, closed: 0 })
	})

	it('should move a note across when it is closed, not list it twice', () => {
		let index = indexWith(EMPTY_INDEX, 'https://acme.com/a', 4, 'open', 1)
		index = indexWith(index, 'https://acme.com/a', 4, 'closed', 2)
		expect(countFor(index, 'https://acme.com/a')).toEqual({ open: 0, closed: 1 })
	})
})
