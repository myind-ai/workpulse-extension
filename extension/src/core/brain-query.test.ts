import { describe, expect, it } from 'vitest'

import type { BridgeEntry } from './bridge'
import { describeFilters, matchBrain, parseBrainQuery, recallFor, relatedTo, samePage, searchBrain, stem, whenOf } from './brain-query'

const NOW = Date.UTC(2026, 9, 27, 12)
const base: BridgeEntry = { schema: 'workpulse.bridge.entry/1', id: 'e1', at: Date.UTC(2026, 9, 20), device: 'cli-a', kind: 'debug', scope: 'work', title: 'Retry webhook reused key' }
const e = (over: Partial<BridgeEntry>): BridgeEntry => ({ ...base, ...over })

describe('parseBrainQuery', () => {
	it('takes the filters out and leaves the words', () => {
		const q = parseBrainQuery('webhook ticket:pay-2433 type:debugging status:open repo:payments #retry has:next after:2026-10-01 before:2w', NOW)
		expect(q.text).toBe('webhook')
		expect(q.filtered).toBe(true)
		expect(q.filters).toMatchObject({ ticket: 'PAY-2433', type: 'debug', status: 'open', project: 'payments', tags: ['retry'], has: ['next-action'], after: Date.UTC(2026, 9, 1) })
		expect(q.filters.before).toBe(NOW - 14 * 86_400_000)
	})

	it('keeps anything it does not know as words: urls, times, unknown keys, bad dates', () => {
		const q = parseBrainQuery('https://x.io/a 10:30 colour:red after:someday')
		expect(q.text).toBe('https://x.io/a 10:30 colour:red after:someday')
		expect(q.filtered).toBe(false)
	})

	it('reads quoted values', () => {
		expect(parseBrainQuery('repo:"acme payments" x').filters.project).toBe('acme payments')
	})

	it('dates', () => {
		expect(whenOf('7d', NOW)).toBe(NOW - 7 * 86_400_000)
		expect(whenOf('2026-13-45')).toBeUndefined()
	})
})

describe('matchBrain', () => {
	const f = (q: string) => parseBrainQuery(q, NOW).filters
	it('status:open is anything not done; status:done only done', () => {
		expect(matchBrain(e({ status: 'in progress' }), f('status:open'))).toBe(true)
		expect(matchBrain(e({ status: 'done' }), f('status:open'))).toBe(false)
		expect(matchBrain(e({}), f('status:done'))).toBe(false)
	})
	it('has:, tags, ticket (also related), project, dates', () => {
		expect(matchBrain(e({ next: ['x'] }), f('has:next-action'))).toBe(true)
		expect(matchBrain(e({ next: [''] }), f('has:next-action'))).toBe(false)
		expect(matchBrain(e({ links: { pr: 'https://g/p/1' } }), f('has:pr'))).toBe(true)
		expect(matchBrain(e({ tags: ['retry', 'webhook'] }), f('#retry tag:webhook'))).toBe(true)
		expect(matchBrain(e({ links: { related: ['PAY-1'] } }), f('ticket:pay-1'))).toBe(true)
		expect(matchBrain(e({ project: 'acme/payments-web' }), f('repo:payments'))).toBe(true)
		expect(matchBrain(e({}), f('after:2026-10-21'))).toBe(false)
		expect(matchBrain(e({}), f('before:2026-10-21'))).toBe(true)
	})
	it('shows the filters back', () => {
		expect(describeFilters(f('type:debug has:pr #retry'))).toEqual(['type debug', '#retry', 'has pr'])
	})
})

describe('relatedTo', () => {
	const entries = [
		e({ id: 'link', at: 1, title: 'PR review notes', links: { pr: 'https://github.com/acme/payments/pull/12' } }),
		e({ id: 'tick', at: 3, ticket: 'PAY-2433' }),
		e({ id: 'rel', at: 2, ticket: 'PAY-1', links: { related: ['PAY-2433'] } }),
		e({ id: 'repo', at: 4, project: 'acme/payments' }),
		e({ id: 'host', at: 5, links: { urls: ['http://localhost:3000/checkout'] } }),
		e({ id: 'other', at: 6, ticket: 'OPS-9', project: 'acme/other' }),
	]
	it('a Jira issue: its ticket, and tickets that name it', () => {
		const r = relatedTo(entries, { url: 'https://acme.atlassian.net/browse/PAY-2433', title: 'PAY-2433 Webhook retry - Jira' })
		expect(r.keys).toEqual(['PAY-2433'])
		expect(r.entries.map((x) => x.e.id)).toEqual(['tick', 'rel'])
	})
	it('a pull request tab: the entry linking to it first, then the repo', () => {
		const r = relatedTo(entries, { url: 'https://github.com/acme/payments/pull/12/files#diff', title: 'Fix retry' })
		expect(r.repo).toBe('acme/payments')
		expect(r.entries.map((x) => [x.e.id, x.why])).toEqual([['link', 'link'], ['repo', 'repo']])
	})
	it('localhost: entries that link to the same host', () => {
		expect(relatedTo(entries, { url: 'http://localhost:3000/cart' }).entries.map((x) => x.e.id)).toEqual(['host'])
	})
	it('an ordinary page with nothing named: nothing, even on a shared host', () => {
		expect(relatedTo(entries, { url: 'https://news.example.com/payments' }).entries).toEqual([])
		expect(relatedTo(entries, { url: 'chrome://extensions' }).entries).toEqual([])
	})
	it('samePage ignores the tab, query and fragment', () => {
		expect(samePage('https://github.com/a/b/pull/3/commits?x=1#y')).toBe(samePage('https://github.com/a/b/pull/3'))
	})
})

describe('searchBrain with filters', () => {
	it('filters first, then ranks the words; filters alone list newest first', () => {
		const a = e({ id: 'a', at: 1, title: 'webhook retry', ticket: 'PAY-1', next: ['x'] })
		const b = e({ id: 'b', at: 2, title: 'webhook timeout', ticket: 'PAY-2' })
		const c = e({ id: 'c', at: 3, title: 'cache', ticket: 'PAY-1', next: ['y'] })
		expect(searchBrain([a, b, c], 'webhook ticket:PAY-1').map((x) => x.e.id)).toEqual(['a'])
		expect(searchBrain([a, b, c], 'has:next-action').map((x) => x.e.id)).toEqual(['c', 'a'])
		expect(searchBrain([a, b, c], 'webhook').map((x) => x.e.id)).toEqual(['b', 'a'])
	})
})

describe('searchBrain ranking', () => {
	// The real miss of 2026-10-30: "write an ad script hook" put a Write-tool mistake and an unrelated note above the
	// scripting lessons, because "an" and "write" counted and "script" never met "scripting".
	const lesson = e({ id: 'lesson', kind: 'learning', at: 1, title: 'Open every script with Promise-Proof-Plan', tags: ['youtube', 'scripting'] })
	const writeTool = e({ id: 'tool', kind: 'mistake', at: 2, title: 'Write tool turned escapes into real characters in a content script', tags: ['tooling'] })
	const noise = e({ id: 'noise', kind: 'learning', at: 3, title: 'To edit in an append-only store, write a change record', tags: ['sync'] })

	it('ignores filler words', () => {
		expect(searchBrain([noise], 'an the to in').map((x) => x.e.id)).toEqual([])
	})

	it('matches word forms: script, scripts, scripting', () => {
		expect(stem('scripting')).toBe('script')
		expect(stem('scripts')).toBe('script')
		expect(stem('hooks')).toBe('hook')
		expect(stem('class')).toBe('class')
		expect(stem('promised')).toBe(stem('promise'))
		expect(searchBrain([lesson], 'scripts').map((x) => x.e.id)).toEqual(['lesson'])
	})

	it('an entry matching more of the words beats one matching a single word', () => {
		const got = searchBrain([noise, writeTool, lesson], 'write an ad script promise hook').map((x) => x.e.id)
		expect(got[0]).toBe('lesson')
		expect(got.indexOf('noise')).toBeGreaterThan(got.indexOf('lesson'))
	})

	it('reports how many query words each entry has', () => {
		expect(searchBrain([lesson], 'script promise hook')[0].matched).toBe(2)
	})
})

describe('recallFor', () => {
	const lesson = e({ id: 'lesson', kind: 'learning', title: 'Open every script with Promise-Proof-Plan: the result promised in the thumbnail', tags: ['youtube', 'scripting'] })
	const ticket = e({ id: 'ticket', kind: 'ticket', title: 'Script the thumbnail promise for the launch reel' })

	it('brings back lessons that share at least two words with the prompt', () => {
		expect(recallFor([lesson, ticket], 'write the reel script and thumbnail for my app').map((x) => x.e.id)).toEqual(['lesson'])
	})

	it('stays quiet for one shared word, commands, and prompts with nothing to go on', () => {
		expect(recallFor([lesson], 'fix the flaky script in CI please today')).toEqual([])
		expect(recallFor([lesson], '/code-review script thumbnail')).toEqual([])
		expect(recallFor([lesson], 'yes do it')).toEqual([])
	})

	it('ignores URLs and filter-looking words in the prompt', () => {
		expect(recallFor([lesson], 'https://youtube.com/watch?v=script ok')).toEqual([])
	})
})
