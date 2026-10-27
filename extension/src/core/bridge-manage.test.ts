import { describe, expect, it } from 'vitest'

import { duplicateOf, entryByRef, fold, newEntry, shortId, type BridgeEntry } from './bridge'

const line = (e: Partial<BridgeEntry>) => JSON.stringify({ schema: 'workpulse.bridge.entry/1', device: 'cli-a', scope: 'work', kind: 'learning', ...e }) + '\n'
const learning = { id: 'e_abc_11111111', at: 1000, title: 'Idempotency keys per operation #retry', tags: ['retry'] }
const change = (id: string, at: number, over: Partial<BridgeEntry>) => line({ id, at, device: 'ext-b', title: learning.title, amends: 'e_abc_11111111', ...over })

describe('changing an entry without rewriting anyone’s file', () => {
	it('applies edits in order, from any device', () => {
		const files = {
			'bridge/entries/2026-10/cli-a.jsonl': line(learning),
			'bridge/entries/2026-10/ext-b.jsonl': change('c1', 2000, { set: { title: 'Idempotency keys belong to the operation' } }) + change('c2', 3000, { set: { tags: ['retry', 'payments'], rootCause: 'SDK cached the key' } }),
		}
		const [e] = fold(files)
		expect(e).toMatchObject({ id: 'e_abc_11111111', title: 'Idempotency keys belong to the operation', tags: ['retry', 'payments'], rootCause: 'SDK cached the key', editedAt: 3000, at: 1000 })
		expect(fold(files)).toHaveLength(1)
	})

	it('archives (hidden unless asked for), restores, and deletes', () => {
		const base = { 'bridge/entries/2026-10/cli-a.jsonl': line(learning) }
		const archived = { ...base, 'bridge/entries/2026-10/ext-b.jsonl': change('c1', 2000, { state: 'archived' }) }
		expect(fold(archived)).toEqual([])
		expect(fold(archived, { archived: true })[0]).toMatchObject({ archived: true })
		const restored = { ...base, 'bridge/entries/2026-10/ext-b.jsonl': change('c1', 2000, { state: 'archived' }) + change('c2', 3000, { state: 'active' }) }
		expect(fold(restored)[0].archived).toBeUndefined()
		const deleted = { ...base, 'bridge/entries/2026-10/ext-b.jsonl': change('c1', 2000, { state: 'deleted' }) }
		expect(fold(deleted, { archived: true })).toEqual([])
	})

	it('ignores a change to an entry it has not seen, and a bad kind', () => {
		const files = { 'a.jsonl': line(learning) + line({ id: 'c9', at: 5, title: 'x', amends: 'nope', state: 'deleted' }) + change('c1', 2000, { set: { kind: 'banana' as never } }) }
		expect(fold(files)[0]).toMatchObject({ kind: 'learning', title: learning.title })
	})

	it('refuses a change that carries a secret', () => {
		expect(() => newEntry({ kind: 'learning', scope: 'work', title: 'x', amends: 'e1', set: { body: 'ghp_abcdefghijklmnopqrstuvwxyz123456' } }, 'ext-b', 1)).toThrow()
	})
})

describe('finding and not repeating', () => {
	const all = fold({ 'a.jsonl': line(learning) + line({ id: 'journal:l_99', at: 5, title: 'Other' }) })
	it('spots the same learning said again', () => {
		expect(duplicateOf(all, 'learning', 'idempotency keys per operation.')?.id).toBe('e_abc_11111111')
		expect(duplicateOf(all, 'mistake', 'Idempotency keys per operation')).toBeUndefined()
		expect(duplicateOf(all, 'learning', 'Idempotency keys per operation', 'PAY-1')).toBeUndefined()
	})
	it('finds an entry by the short id lists show', () => {
		expect(shortId('e_abc_11111111')).toBe('11111111')
		expect(entryByRef(all, '11111111')).toMatchObject({ id: 'e_abc_11111111' })
		expect(entryByRef(all, shortId('journal:l_99'))).toMatchObject({ id: 'journal:l_99' })
		expect(entryByRef(all, 'zzzzzzzz')).toEqual({ error: 'No entry matches "zzzzzzzz".' })
		expect(entryByRef(all, 'ab')).toHaveProperty('error')
	})
})

it('applies changes made in the same millisecond in the order they were written', () => {
	const at = 2000
	const files = { 'bridge/entries/2026-10/cli-a.jsonl': line(learning), 'bridge/entries/2026-10/ext-b.jsonl': change('zz', at, { state: 'archived' }) + change('aa', at, { state: 'active' }) }
	expect(fold(files)).toHaveLength(1)
})
