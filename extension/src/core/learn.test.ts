import { describe, expect, it } from 'vitest'

import { allTags, forTicket, matchLearning, repeats, taggedMistakes, tagsOf, toggleTag, withoutTags, type Learning } from './learn'

const item = (patch: Partial<Learning>): Learning => ({
	id: Math.random().toString(36).slice(2),
	date: '2026-10-13',
	at: Date.parse('2026-10-13T10:00:00Z'),
	kind: 'mistake',
	text: '',
	tags: [],
	...patch,
})

describe('tags', () => {
	it('should read hashtags and lower-case them', () => {
		expect(tagsOf('Forgot the index again #MySQL #slow-query')).toEqual(['mysql', 'slow-query'])
	})

	it('should not take a colour, a heading or an id as a tag', () => {
		expect(tagsOf('#fff is white')).toEqual(['fff']) // a word is a word
		expect(tagsOf('## Heading')).toEqual([])
		expect(tagsOf('see PAY-2433#comment')).toEqual([])
	})

	it('should list each tag once', () => {
		expect(tagsOf('#ci broke, #ci fixed')).toEqual(['ci'])
	})

	it('should show the text without its tags', () => {
		expect(withoutTags('Forgot the index again #mysql #slow-query')).toBe('Forgot the index again')
	})
})

describe('mistakes that keep coming back', () => {
	const now = Date.parse('2026-10-13T10:00:00Z')
	const day = 86_400_000

	it('should count a tag that has happened more than once', () => {
		const list = [
			item({ tags: ['flaky-test'], at: now - day }),
			item({ tags: ['flaky-test'], at: now - 8 * day }),
			item({ tags: ['ci'], at: now - 2 * day }),
		]
		expect(repeats(list, now)).toEqual([{ tag: 'flaky-test', count: 2, lastAt: now - day }])
	})

	it('should forget what happened outside the window', () => {
		const list = [item({ tags: ['ci'], at: now - day }), item({ tags: ['ci'], at: now - 60 * day })]
		expect(repeats(list, now)).toEqual([])
	})

	it('should count mistakes only — learning the same thing twice is fine', () => {
		const list = [item({ tags: ['ci'], kind: 'learning' }), item({ tags: ['ci'], kind: 'learning' })]
		expect(repeats(list, now)).toEqual([])
	})

	it('should put the most frequent first', () => {
		const list = [
			item({ tags: ['a'], at: now - day }),
			item({ tags: ['a'], at: now - 2 * day }),
			item({ tags: ['a'], at: now - 3 * day }),
			item({ tags: ['b'], at: now - day }),
			item({ tags: ['b'], at: now - 2 * day }),
		]
		expect(repeats(list, now).map((r) => [r.tag, r.count])).toEqual([
			['a', 3],
			['b', 2],
		])
	})
})

describe('finding one again', () => {
	const one = item({ text: 'Forgot to clear the cache after a migration #mysql', tags: ['mysql'], kind: 'mistake', date: '2026-10-13' })

	it('should match the text, a tag with or without the hash, the kind and the date', () => {
		for (const q of ['cache', '#mysql', 'mysql', 'mistake', '2026-10-13']) expect(matchLearning(one, q), q).toBe(true)
	})

	it('should need every word', () => {
		expect(matchLearning(one, 'cache migration')).toBe(true)
		expect(matchLearning(one, 'cache redis')).toBe(false)
	})
})

describe('the tag list', () => {
	const now = Date.parse('2026-10-13T10:00:00Z')
	const list = [
		item({ tags: ['ci', 'mysql'], at: now }),
		item({ tags: ['ci'], at: now - 1000 }),
		item({ tags: ['zoho'], at: now - 2000 }),
	]

	it('should offer every tag, most used first', () => {
		expect(allTags(list).map((t) => [t.tag, t.count])).toEqual([
			['ci', 2],
			['mysql', 1],
			['zoho', 1],
		])
	})

	it('should be empty when nothing is tagged', () => {
		expect(allTags([])).toEqual([])
	})
})

describe('a tag chip and a typed hashtag being the same thing', () => {
	it('should add a tag to the end of the note', () => {
		expect(toggleTag('Forgot the index', 'mysql')).toBe('Forgot the index #mysql')
		expect(toggleTag('', 'ci')).toBe('#ci')
	})

	it('should take it off again, wherever it sits', () => {
		expect(toggleTag('Forgot the index #mysql', 'mysql')).toBe('Forgot the index')
		expect(toggleTag('#ci broke the build', 'ci')).toBe('broke the build')
	})

	it('should not add it twice', () => {
		expect(toggleTag('x #ci', 'CI')).toBe('x')
		expect(toggleTag(toggleTag('x', 'ci'), 'ci')).toBe('x')
	})

	it('should refuse something that is not a tag', () => {
		expect(toggleTag('x', 'two words')).toBe('x')
		expect(toggleTag('x', '')).toBe('x')
	})

	it('should leave a longer tag alone when removing a shorter one', () => {
		expect(toggleTag('x #ci #ci-flaky', 'ci')).toBe('x #ci-flaky')
	})
})

describe('what you wrote the last times', () => {
	const now = Date.parse('2026-10-13T10:00:00Z')
	const list = [
		item({ text: 'second time', tags: ['mysql'], at: now }),
		item({ text: 'first time', tags: ['mysql'], at: now - 86_400_000 }),
		item({ text: 'learned something', tags: ['mysql'], kind: 'learning', at: now }),
		item({ text: 'on a ticket', ticketId: 'w1', at: now }),
	]

	it('should give the mistakes behind a tag, oldest first', () => {
		expect(taggedMistakes(list, 'mysql').map((l) => l.text)).toEqual(['first time', 'second time'])
	})

	it('should give what a ticket taught you', () => {
		expect(forTicket(list, 'w1').map((l) => l.text)).toEqual(['on a ticket'])
		expect(forTicket(list, 'nope')).toEqual([])
	})
})
