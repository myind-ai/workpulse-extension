import { describe, expect, it } from 'vitest'

import { MENU_MORE, MENU_ROOT, MENU_SEP, addedTogether, ago, keyPattern, keysIn, labelFor, matches, matchesRow, menuAction, menuDo, mergePreview, mergeWorkspaces, pageMenu, sortTickets, suggest, ticketForPage, ticketKey, type MergeInput, type TicketRow, type TicketSort } from './links'

describe('ticket keys', () => {
	it('should find a key anywhere in the text', () => {
		expect(ticketKey('PAY-2433 · retry the webhook')).toBe('PAY-2433')
		expect(ticketKey('fix/pay-2433/consumer-financing')).toBe('PAY-2433')
		expect(ticketKey('https://github.com/x/y/pull/812')).toBeNull()
	})

	it('should not mistake a date or a version for a key', () => {
		expect(ticketKey('released 2026-10-13')).toBeNull()
		expect(ticketKey('v1-2')).toBeNull()
	})
})

describe('guessing what a link is', () => {
	it('should name the kind of page', () => {
		expect(labelFor('https://github.com/acme/api/pull/812')).toBe('PR')
		expect(labelFor('https://figma.com/file/abc')).toBe('Design')
		expect(labelFor('https://sentry.io/issues/1')).toBe('Logs')
	})

	it('should say which environment when the address tells it', () => {
		expect(labelFor('https://dev.acme.com/orders')).toBe('Dev')
		expect(labelFor('https://github.com/acme/api/pull/812?base=staging')).toBe('PR · Stage')
	})

	it('should stay quiet rather than guess wrong', () => {
		expect(labelFor('https://acme.com/')).toBeUndefined()
		expect(labelFor('')).toBeUndefined()
	})
})

describe('finding a ticket later', () => {
	const space = {
		name: 'PAY-2433 financing button',
		note: 'waiting on LD flags',
		tabs: [{ title: 'Pull request #812', url: 'https://github.com/acme/api/pull/812', note: 'merged on dev' }],
	}

	it('should match the key, the name, the note and the links', () => {
		for (const q of ['pay-2433', 'financing', 'LD flags', 'merged on dev', '812']) expect(matches(space, q)).toBe(true)
	})

	it('should need every word, so two words narrow instead of widen', () => {
		expect(matches(space, 'financing merged')).toBe(true)
		expect(matches(space, 'financing deleted')).toBe(false)
	})

	it('should match everything when nothing is typed', () => {
		expect(matches(space, '  ')).toBe(true)
	})
})

describe('suggesting where a page belongs', () => {
	const list = [
		{ id: 'a', name: 'PAY-2433 financing button' },
		{ id: 'b', name: 'PAY-2501 refunds' },
	]

	it('should offer the ticket whose key is in the address', () => {
		expect(suggest('https://jira/browse/PAY-2501', 'Refunds', list).map((w) => w.id)).toEqual(['b'])
	})

	it('should offer nothing rather than a guess', () => {
		expect(suggest('https://news.site', 'Something', list)).toEqual([])
	})
})

describe('how old a link is', () => {
	const now = Date.parse('2026-10-13T10:00:00Z')
	it('should read the way people ask', () => {
		expect(ago(now, now)).toBe('today')
		expect(ago(now - 86_400_000, now)).toBe('yesterday')
		expect(ago(now - 10 * 86_400_000, now)).toBe('10 days ago')
		expect(ago(now - 70 * 86_400_000, now)).toBe('2 months ago')
	})
})

describe('ticket keys with your own prefixes', () => {
	const prefixes = ['PAY', 'LEAP', 'SALESPRO']

	it('should find every key, in the title or the address', () => {
		expect(keysIn('PAY-2433 · financing button by someone', prefixes)).toEqual(['PAY-2433'])
		expect(keysIn('https://leap.atlassian.net/browse/LEAP-3233', prefixes)).toEqual(['LEAP-3233'])
		expect(keysIn('fix/salespro-19/crash', prefixes)).toEqual(['SALESPRO-19'])
	})

	it('should ignore a key that is not one of yours', () => {
		expect(keysIn('ABC-12 and PAY-1', prefixes)).toEqual(['PAY-1'])
	})

	it('should take the general shape when no prefixes are set', () => {
		expect(keysIn('ABC-12 and PAY-1', [])).toEqual(['ABC-12', 'PAY-1'])
	})

	it('should not read a date or a version as a key', () => {
		expect(keysIn('released 2026-10-13, v1-2', [])).toEqual([])
	})

	it('should list a repeated key once', () => {
		expect(keysIn('PAY-1 blocks PAY-1', prefixes)).toEqual(['PAY-1'])
	})

	it('should tidy however a prefix was typed in settings', () => {
		expect(keysIn('pay-7', ['pay-'])).toEqual(['PAY-7'])
		expect(keysIn('pay-7', [' PAY '])).toEqual(['PAY-7'])
	})
})

describe('the right-click menu for a page', () => {
	const spaces = [
		{ id: 'w1', name: 'PAY-2433 financing button' },
		{ id: 'w2', name: 'LEAP-3233 refunds' },
	]
	const prefixes = ['PAY', 'LEAP']
	const titles = (page: { title?: string; url?: string }) => pageMenu(page, prefixes, spaces).map((m) => m.title)

	it('should put the ticket this page belongs to first', () => {
		const menu = pageMenu({ title: 'PAY-2433 · financing', url: 'https://jira/browse/PAY-2433' }, prefixes, spaces)
		expect(menu[1]).toMatchObject({ id: 'wp-add:w1', title: 'Add this page to PAY-2433 financing button', parentId: MENU_ROOT })
	})

	it('should offer to start a ticket for a key it has never seen', () => {
		expect(titles({ title: 'PAY-9999 new thing' })).toContain('New ticket PAY-9999 with this page')
	})

	it('should keep every other ticket behind one submenu', () => {
		const menu = pageMenu({ title: 'PAY-2433' }, prefixes, spaces)
		expect(menu.find((m) => m.id === MENU_MORE)?.title).toBe('Add to another ticket')
		expect(menu.filter((m) => m.parentId === MENU_MORE).map((m) => m.title)).toEqual(['LEAP-3233 refunds'])
	})

	it('should still be useful on a page with no key at all', () => {
		const menu = pageMenu({ title: 'Some docs page', url: 'https://docs.site' }, prefixes, spaces)
		expect(menu.find((m) => m.id === MENU_MORE)?.title).toBe('Add this page to a ticket')
		expect(menu.filter((m) => m.parentId === MENU_MORE)).toHaveLength(2)
	})

	it('should offer to save a page when there are no tickets yet', () => {
		const filing = pageMenu({ title: 'Some docs page' }, prefixes, []).filter((m) => !menuDo(m.id) && m.id !== MENU_SEP)
		expect(filing.map((m) => m.title)).toEqual(['WorkPulse', 'Save this page as a new ticket…'])
	})

	it('should offer the one-click things on every page, tickets or not', () => {
		// Each is one click from the thought that prompted it, which is the only
		// moment any of them actually gets done.
		const does = pageMenu({ title: 'x' }, prefixes, []).map((m) => menuDo(m.id)).filter(Boolean)
		expect(does).toEqual(['note', 'todo', 'remind', 'learn', 'log', 'focus'])
	})

	it('should know an action from a filing', () => {
		expect(menuDo('wp-do:learn')).toBe('learn')
		expect(menuDo('wp-add:w1')).toBeNull()
		expect(menuAction('wp-do:learn')).toBeNull()
	})

	it('should cap how many tickets the submenu lists', () => {
		const many = Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, name: `T-${i}` }))
		expect(pageMenu({ title: 'x' }, prefixes, many).filter((m) => m.parentId === MENU_MORE)).toHaveLength(8)
	})

	it('should say what each id does', () => {
		expect(menuAction('wp-add:w1')).toEqual({ kind: 'add', ticketId: 'w1' })
		expect(menuAction('wp-new:PAY-1')).toEqual({ kind: 'new', key: 'PAY-1' })
		expect(menuAction(MENU_ROOT)).toBeNull()
	})
})

describe('keys found in the page itself', () => {
	const spaces = [{ id: 'w1', name: 'PAY-2433 financing button' }]
	const prefixes = ['PAY']

	it('should offer the ticket when only the page body names it', () => {
		const menu = pageMenu({ title: 'Release checklist', url: 'https://confluence/x', keys: ['PAY-2433'] }, prefixes, spaces)
		expect(menu[1]).toMatchObject({ id: 'wp-add:w1' })
	})

	it('should offer to start a ticket for a key found only in the page', () => {
		expect(pageMenu({ title: 'Notes', keys: ['PAY-77'] }, prefixes, spaces).map((m) => m.title)).toContain('New ticket PAY-77 with this page')
	})

	it('should still refuse a key that is not one of my prefixes', () => {
		expect(pageMenu({ title: 'Notes', keys: ['ABC-77'] }, prefixes, spaces).map((m) => m.title)).not.toContain('New ticket ABC-77 with this page')
	})

	it('should not list the same key twice when the title and the page agree', () => {
		const menu = pageMenu({ title: 'PAY-77 thing', keys: ['PAY-77'] }, prefixes, [])
		expect(menu.filter((m) => m.id.startsWith('wp-new:'))).toHaveLength(1)
	})

	it('should hand the page the same pattern it uses itself', () => {
		expect(new RegExp(keyPattern(['PAY', 'LEAP']), 'g').source).toBe('\\b(PAY|LEAP)-(\\d{1,6})\\b')
		expect('see PAY-12'.toUpperCase().match(new RegExp(keyPattern(['pay-']), 'g'))).toEqual(['PAY-12'])
	})
})

describe('a hundred tickets', () => {
	const row = (patch: Partial<TicketRow>): TicketRow => ({ id: 'x', name: 'x', links: 0, notes: 0, at: 0, updatedAt: 0, hay: '', ...patch })
	const rows = [
		row({ id: 'a', name: 'PAY-2 beta', at: 100, updatedAt: 300, lastOpenedAt: 50 }),
		row({ id: 'b', name: 'PAY-10 alpha', at: 300, updatedAt: 100 }),
		row({ id: 'c', name: 'PAY-1 gamma', at: 200, updatedAt: 200, lastOpenedAt: 900 }),
	]
	const ids = (sort: TicketSort) => sortTickets(rows, sort).map((r) => r.id)

	it('should sort by what changed last, newest first', () => {
		expect(ids('activity')).toEqual(['a', 'c', 'b'])
	})

	it('should sort by what was opened last, and put never-opened at the end', () => {
		expect(ids('opened')).toEqual(['c', 'a', 'b'])
	})

	it('should sort by when it was started', () => {
		expect(ids('created')).toEqual(['b', 'c', 'a'])
	})

	it('should sort by name the way a person reads numbers', () => {
		expect(ids('name')).toEqual(['c', 'a', 'b']) // PAY-1, PAY-2, PAY-10
	})

	it('should not reorder the array it was given', () => {
		sortTickets(rows, 'name')
		expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
	})

	it('should search the flattened row, every word required', () => {
		const one = row({ name: 'PAY-2433 financing', hay: 'stage deploy https://stage.acme.com', latestNote: 'waiting on the LD flag' })
		for (const q of ['financing', 'stage', 'acme.com', 'LD flag', 'financing stage']) expect(matchesRow(one, q), q).toBe(true)
		expect(matchesRow(one, 'financing refunds')).toBe(false)
		expect(matchesRow(one, '')).toBe(true)
	})
})

describe('two tickets that turned out to be one', () => {
	const NOW = 1_000_000
	const ws = (patch: Partial<MergeInput> = {}): MergeInput => ({ id: 'a', name: 'PAY-2433', at: 100, tabs: [], notes: [], ...patch })

	const left = ws({
		id: 'a',
		name: 'PAY-2433',
		at: 100,
		tabs: [{ url: 'https://pr/1', title: 'PR', note: 'merged on dev' }],
		notes: [{ id: 'n1', date: '2026-10-12', at: 2, text: 'first' }],
	})
	const right = ws({
		id: 'b',
		name: 'PAY-2433 financing',
		at: 50,
		lastOpenedAt: 900,
		tabs: [
			{ url: 'https://pr/1', title: 'The same PR' },
			{ url: 'https://stage/x', title: 'Stage' },
		],
		notes: [{ id: 'n2', date: '2026-10-13', at: 3, text: 'second' }],
	})

	it('should keep the name of the one you merged into', () => {
		expect(mergeWorkspaces(right, left, NOW).name).toBe('PAY-2433')
	})

	it('should bring the links across without duplicating them', () => {
		const out = mergeWorkspaces(right, left, NOW)
		expect(out.tabs.map((t) => t.url)).toEqual(['https://pr/1', 'https://stage/x'])
	})

	it('should keep the label you wrote, whichever side it was on', () => {
		// A label is work; the duplicate is an accident.
		expect(mergeWorkspaces(right, left, NOW).tabs[0].note).toBe('merged on dev')
		expect(mergeWorkspaces(left, right, NOW).tabs.find((t) => t.url === 'https://pr/1')?.note).toBe('merged on dev')
	})

	it('should keep every note, newest day first', () => {
		expect(mergeWorkspaces(right, left, NOW).notes?.map((n) => n.id)).toEqual(['n2', 'n1'])
	})

	it('should be as old as its oldest half and as fresh as now', () => {
		const out = mergeWorkspaces(right, left, NOW)
		expect(out.at).toBe(50)
		expect(out.updatedAt).toBe(NOW)
		expect(out.lastOpenedAt).toBe(900)
	})

	it('should say what it would do before it does it', () => {
		expect(mergePreview(right, left)).toEqual({ links: 1, notes: 1, duplicates: 1 })
		expect(mergePreview(ws(), left)).toEqual({ links: 0, notes: 0, duplicates: 0 })
	})
})

describe('the links that went in together', () => {
	const at = 1_760_000_000_000
	const burst = (n: number, when: number) => Array.from({ length: n }, (_, i) => ({ url: `https://a.test/${when}/${i}`, addedAt: when + i * 200 }))

	it('should find the batch that arrived at once', () => {
		// Four collected over a fortnight, then twenty in one click.
		const tabs = [...burst(4, at - 14 * 86_400_000), ...burst(20, at)]
		const found = addedTogether(tabs)
		expect(found?.urls).toHaveLength(20)
		expect(found?.urls.every((u) => u.includes(String(at)))).toBe(true)
	})

	it('should call two links a Tuesday, not a batch', () => {
		expect(addedTogether([...burst(5, at - 86_400_000), ...burst(2, at)])?.urls).toHaveLength(5)
		expect(addedTogether(burst(2, at))).toBeNull()
	})

	it('should say nothing when the whole ticket arrived at once', () => {
		// Offering to remove every link in the ticket is offering to empty it.
		expect(addedTogether(burst(9, at))).toBeNull()
	})

	it('should ignore links with no timestamp at all', () => {
		expect(addedTogether([{ url: 'a' }, { url: 'b' }, { url: 'c' }])).toBeNull()
	})
})

describe('which ticket a page belongs to', () => {
	const list = [
		{ id: 'a', name: 'PAY-2433 financing', tabs: [{ url: 'https://stage.acme.com/orders' }] },
		{ id: 'b', name: 'LEAP-12 migration', tabs: [{ url: 'https://github.com/acme/api/pull/9' }] },
	]

	it('should take the key in the address as proof', () => {
		expect(ticketForPage('https://jira/browse/LEAP-12', 'Migration', list)).toMatchObject({ ticket: { id: 'b' }, why: 'its key is in the address' })
	})

	it('should know the exact page is already saved under one', () => {
		const got = ticketForPage('https://stage.acme.com/orders?utm=x', 'Orders', list)
		expect(got?.ticket.id).toBe('a')
		expect(got?.why).toContain('exact page')
	})

	it('should guess from the site, and say that is what it did', () => {
		// A bug on stage.acme.com/invoices is almost always about the ticket whose
		// stage link you saved last week.
		const got = ticketForPage('https://stage.acme.com/invoices/9', 'Invoices', list)
		expect(got?.ticket.id).toBe('a')
		expect(got?.why).toBe('you saved a stage.acme.com link under it')
	})

	it('should say nothing rather than guess wildly', () => {
		expect(ticketForPage('https://news.site/story', 'Something', list)).toBeNull()
		expect(ticketForPage('nonsense', 'x', list)).toBeNull()
	})
})

describe('a note that names its own ticket', () => {
	const list = [
		{ id: 't1', name: 'PAY-3110 lightstream warning', tabs: [] },
		{ id: 't2', name: 'PAY-2433 financing button', tabs: [{ url: 'https://stage.acme.com/orders' }] },
	]

	it('should file a note under the ticket it mentions, wherever the page is', () => {
		// Production's address says nothing about PAY-3110. The note does.
		const got = ticketForPage('https://app.acme.com/dashboard', 'Dashboard', list, 'Tested PAY-3110 on production and lightstream warning working with message and contact email link')
		expect(got?.ticket.id).toBe('t1')
		expect(got?.why).toBe('you named it in the note')
	})

	it('should let what you wrote beat what the address happens to say', () => {
		// You typed that key on purpose; the address is where you happened to be.
		const got = ticketForPage('https://jira.acme.com/browse/PAY-2433', 'PAY-2433', list, 'actually this is about PAY-3110')
		expect(got?.ticket.id).toBe('t1')
	})

	it('should still read the address when the note names nothing', () => {
		const got = ticketForPage('https://jira.acme.com/browse/PAY-2433', 'PAY-2433', list, 'looks wrong on mobile')
		expect(got?.ticket.id).toBe('t2')
		expect(got?.why).toContain('address')
	})

	it('should ignore a key for a ticket that is not saved', () => {
		expect(ticketForPage('https://app.acme.com/x', '', list, 'about NOPE-99')).toBeNull()
	})

	it('should behave exactly as before when no text is given', () => {
		const got = ticketForPage('https://stage.acme.com/orders/88', '', list)
		expect(got?.ticket.id).toBe('t2')
	})
})
