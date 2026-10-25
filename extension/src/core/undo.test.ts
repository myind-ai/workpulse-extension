import { describe, expect, it } from 'vitest'

import { MAX_TICKET_IN_LABEL, UNDO_WINDOW, describeAdd, shortTicket, type Undoable, undoLabel, undoOffered } from './undo'

const u: Undoable = { kind: 'ticket', label: 'adding 23 links to PAY-2433', at: 1_000_000, before: null }

describe('putting it back', () => {
	it('should offer itself for a while, then stop', () => {
		expect(undoOffered(u, u.at + 60_000)?.label).toBe(u.label)
		expect(undoOffered(u, u.at + UNDO_WINDOW + 1)).toBeNull()
		expect(undoOffered(undefined, 1)).toBeNull()
	})

	it('should say what it would put back, not just "undo"', () => {
		// "Undo" on its own leaves you guessing which of the last three it means.
		expect(undoLabel(u)).toBe('Undo adding 23 links to PAY-2433')
		expect(describeAdd(1, 'PAY-1')).toBe('adding 1 link to PAY-1')
	})
})

describe('a ticket name inside a button', () => {
	it('should use the key, because the rest of a Jira title never identified it', () => {
		expect(shortTicket('[PAY-2398] SP - Create info icon in CRM pending balance to show which payments make up that balance - Jira')).toBe('PAY-2398')
	})

	it('should keep a name that already fits, key and all', () => {
		// "PAY-2433 financing" says more than "PAY-2433" and costs nothing.
		expect(shortTicket('PAY-2433 financing')).toBe('PAY-2433 financing')
		expect(shortTicket('financing button')).toBe('financing button')
	})

	it('should cut a long name with no key, rather than let it run', () => {
		const got = shortTicket('a very long ticket name with no key in it at all anywhere')
		expect(got.length).toBeLessThanOrEqual(MAX_TICKET_IN_LABEL)
		expect(got.endsWith('…')).toBe(true)
	})

	it('should keep the whole undo label short enough to read', () => {
		const label = describeAdd(1, '[PAY-2398] SP - Create info icon in CRM pending balance - Jira')
		expect(label).toBe('adding 1 link to PAY-2398')
	})
})
