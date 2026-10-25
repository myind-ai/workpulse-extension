import { describe, expect, it } from 'vitest'

import { closingPrompt, deskLoad, driftLine, inferContext, keysIn, parkable, spread, verdictFor, type Context, type Tab } from './context'

const tab = (id: number, title: string, url: string, pinned = false): Tab => ({ id, title, url, pinned })
const ctx: Context = {
	id: 'c1',
	name: 'LEAP-19',
	intent: 'finish the webhook retry',
	urls: ['https://github.com/acme/api/pull/42', 'https://stage.acme.com/orders'],
}

describe('what belongs on this desk', () => {
	it('should place a tab by a ticket key it shares with the context', () => {
		expect(verdictFor(tab(1, 'LEAP-19 webhook retry', 'https://jira.acme.com/LEAP-19'), ctx)).toBe('belongs')
	})

	it('should place a tab by a host the context already owns', () => {
		expect(verdictFor(tab(2, 'Orders', 'https://stage.acme.com/orders/88'), ctx)).toBe('belongs')
	})

	it('should call a different ticket drifting, which is the clearest drift there is', () => {
		expect(verdictFor(tab(3, 'PAY-2433 financing', 'https://jira.acme.com/PAY-2433'), ctx)).toBe('drifting')
	})

	it('should say unknown rather than drifting when it cannot place a tab', () => {
		// The whole honesty of this: a nag that is wrong a third of the time
		// gets switched off within a week.
		expect(verdictFor(tab(4, 'MDN — fetch', 'https://developer.mozilla.org/fetch'), ctx)).toBe('unknown')
		expect(verdictFor(tab(5, 'Reddit', 'https://reddit.com/r/programming'), ctx)).toBe('unknown')
	})

	it('should not try to place a page that is not a web page', () => {
		expect(verdictFor(tab(6, 'Settings', 'chrome://settings'), ctx)).toBe('unknown')
	})

	it('should count how much of the screen it can place at all', () => {
		const s = spread([tab(1, 'LEAP-19', 'https://jira.acme.com/LEAP-19'), tab(2, 'PAY-2433', 'https://jira.acme.com/PAY-2433'), tab(3, 'MDN', 'https://developer.mozilla.org/x')], ctx)
		expect(s.belongs).toHaveLength(1)
		expect(s.drifting).toHaveLength(1)
		expect(s.unknown).toHaveLength(1)
		expect(s.placed).toBe(67)
	})
})

describe('when to say something, and when to stay quiet', () => {
	it('should stay quiet about a single stray tab', () => {
		const s = spread([tab(1, 'PAY-2433', 'https://jira.acme.com/PAY-2433')], ctx)
		expect(driftLine(s, ctx)).toBeNull()
	})

	it('should speak once a second ticket is genuinely on the desk', () => {
		const s = spread([tab(1, 'PAY-2433 one', 'https://jira.acme.com/PAY-2433'), tab(2, 'PAY-2433 two', 'https://git.acme.com/PAY-2433')], ctx)
		const line = driftLine(s, ctx)
		expect(line).toContain('PAY-2433')
		expect(line).toContain('not LEAP-19')
		// Never an instruction. It names the situation and leaves the decision.
		expect(line).toContain('or leave them')
	})
})

describe('what is safe to take off the screen', () => {
	it('should never park a pinned tab or one of our own pages', () => {
		const mine = 'chrome-extension://abc/'
		const got = parkable([tab(1, 'pinned', 'https://a.com', true), tab(2, 'ours', `${mine}dashboard.html`), tab(3, 'fine', 'https://b.com')], mine)
		expect(got.map((t) => t.id)).toEqual([3])
	})
})

describe('the number nobody has', () => {
	it('should say nothing about a tidy desk', () => {
		expect(deskLoad([tab(1, 'LEAP-19', 'https://a.com/LEAP-19')]).line).toBeNull()
	})

	it('should count jobs rather than tabs, because tabs is the number everyone already ignores', () => {
		const tabs = Array.from({ length: 14 }, (_, i) => tab(i, `TKT-${i % 4}`, `https://a.com/TKT-${i % 4}`))
		const got = deskLoad(tabs)
		expect(got.jobs).toBe(4)
		expect(got.line).toContain('4 jobs on one desk')
	})

	it('should not scold somebody with many tabs on a single job', () => {
		const tabs = Array.from({ length: 20 }, (_, i) => tab(i, 'LEAP-19 thing', `https://a.com/LEAP-19/${i}`))
		expect(deskLoad(tabs).line).toBeNull()
	})
})

describe('closing a context', () => {
	it('should ask what came of it, quoting what was promised', () => {
		expect(closingPrompt(ctx, 50)).toContain('“finish the webhook retry”')
		expect(closingPrompt(ctx, 50)).toContain('What came of it?')
	})

	it('should read in hours once it has been long enough to deserve them', () => {
		expect(closingPrompt(ctx, 90)).toContain('1.5 hours')
		expect(closingPrompt(ctx, 25)).toContain('25 minutes')
	})
})

describe('ticket keys', () => {
	it('should find them anywhere and never twice', () => {
		expect(keysIn('LEAP-19 and leap-19 and PAY-2433')).toEqual(['LEAP-19', 'PAY-2433'])
	})
})

describe('the context the desk implies, when nobody declared one', () => {
	const t = (i: number, k: string) => tab(i, `${k} something`, `https://jira.acme.com/${k}`)

	it('should say nothing when no ticket appears twice', () => {
		// One tab is not a context.
		expect(inferContext([t(1, 'LEAP-19'), t(2, 'PAY-2433')])).toBeNull()
	})

	it('should take the ticket most of the desk is about', () => {
		const got = inferContext([t(1, 'LEAP-19'), t(2, 'LEAP-19'), t(3, 'LEAP-19'), t(4, 'PAY-2433'), t(5, 'PAY-2433')])
		expect(got?.name).toBe('LEAP-19')
		expect(got?.kind).toBe('observed')
	})

	it('should break a genuine tie with what you wrote about most recently', () => {
		const tabs = [t(1, 'LEAP-19'), t(2, 'LEAP-19'), t(3, 'PAY-2433'), t(4, 'PAY-2433')]
		expect(inferContext(tabs, ['PAY-2433', 'LEAP-19'])?.name).toBe('PAY-2433')
		expect(inferContext(tabs, ['LEAP-19', 'PAY-2433'])?.name).toBe('LEAP-19')
	})

	it('should carry the matching tabs as its own, so host matching still works', () => {
		const got = inferContext([t(1, 'LEAP-19'), t(2, 'LEAP-19')])
		expect(got?.urls).toHaveLength(2)
	})

	it('should ignore pages a browser cannot reopen', () => {
		expect(inferContext([tab(1, 'Settings LEAP-19', 'chrome://settings'), tab(2, 'Settings LEAP-19', 'chrome://flags')])).toBeNull()
	})
})

describe('what an inferred context is allowed to say', () => {
	const stated: Context = { ...ctx, kind: 'stated' }
	const observed: Context = { ...ctx, kind: 'observed' }
	const drift = (n: number) => spread(Array.from({ length: n }, (_, i) => tab(i, 'PAY-2433 x', `https://jira.acme.com/PAY-2433/${i}`)), ctx)

	it('should hold somebody to a plan they actually stated', () => {
		const line = driftLine(drift(2), stated)
		expect(line).toContain('not LEAP-19')
		expect(line).toContain('Park this and switch')
	})

	it('should only describe the room when the context was inferred', () => {
		const line = driftLine(drift(3), observed)
		expect(line).toContain('This desk is mostly LEAP-19')
		// No plan was broken, so nothing is suggested and nothing is implied.
		expect(line).not.toContain('not LEAP-19')
		expect(line).not.toContain('Park this')
	})

	it('should wait for more evidence before speaking about an inferred context', () => {
		// Two stray tabs break a stated plan; they prove nothing on their own.
		expect(driftLine(drift(2), stated)).not.toBeNull()
		expect(driftLine(drift(2), observed)).toBeNull()
		expect(driftLine(drift(3), observed)).not.toBeNull()
	})
})
