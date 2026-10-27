import { describe, expect, it } from 'vitest'

import { brainIndex, brainRecord, openWork, searchBrain } from './brain-index'
import type { BridgeEntry } from './bridge'

const entry: BridgeEntry = {
	schema: 'workpulse.bridge.entry/1',
	id: 'e_abc12345',
	at: Date.UTC(2026, 9, 26, 10),
	device: 'cli-test',
	kind: 'debug',
	scope: 'personal',
	title: 'Retry webhook uses old idempotency key',
	subtitle: 'Second retry fails on staging',
	ticket: 'PAY-2433',
	tags: ['retry', 'webhook'],
	status: 'in progress',
	next: ['Add a two-retry regression test'],
}

describe('brain records', () => {
	it('lives under bridge/, in the writing device’s own folder', () => {
		const record = brainRecord(entry)
		expect(record.path).toBe('bridge/records/cli-test/2026-10/pay-2433-retry-webhook-uses-old-idempotency-key-abc12345.md')
		expect(record.content).toContain('subtitle: "Second retry fails on staging"')
		expect(record.content).toContain('device: "cli-test"')
		expect(record.content).toContain('## Next action')
	})

	it('never writes into the backup folder', () => {
		expect(brainRecord({ ...entry, device: 'ext-ab12cd' }).path.startsWith('bridge/records/ext-ab12cd/')).toBe(true)
		expect(brainRecord({ ...entry, id: 'journal:l_1' }).path).not.toContain(':')
	})
})

describe('brain index', () => {
	it('builds the index and a graph chained by ticket and tag', () => {
		const other = { ...entry, id: 'e_other123', at: entry.at + 1, title: 'Production retry comparison', tags: ['retry'] }
		const third = { ...entry, id: 'e_third123', at: entry.at + 2, ticket: undefined, tags: [], title: 'Unrelated' }
		const { index, graph } = brainIndex([entry, other, third], entry.at + 10)
		expect(index).toContain('Open next actions')
		expect(index).toContain('records/cli-test/2026-10/')
		const g = JSON.parse(graph)
		expect(g.nodes).toHaveLength(3)
		expect(g.edges.map((x: { kind: string }) => x.kind).sort()).toEqual(['tag', 'ticket'])
	})

	it('grows linearly: 2,000 entries on one ticket make 1,999 ticket edges', () => {
		const many = Array.from({ length: 2000 }, (_, i) => ({ ...entry, id: `e_${i}`, at: entry.at + i, tags: [] }))
		expect(JSON.parse(brainIndex(many).graph).edges).toHaveLength(1999)
	})
})

describe('search and open work', () => {
	it('ranks title matches above body matches', () => {
		const body = { ...entry, id: 'e_body', title: 'Something else', subtitle: undefined, tags: [], body: 'the webhook was slow' }
		const got = searchBrain([body, entry], 'webhook')
		expect(got.map((x) => x.e.id)).toEqual(['e_abc12345', 'e_body'])
		expect(searchBrain([entry], '  ')).toEqual([])
	})

	it('keeps the newest next action per ticket and drops tickets closed later', () => {
		const older = { ...entry, id: 'e_old', at: entry.at - 1000, next: ['old step'] }
		const done = { ...entry, id: 'e_done', ticket: 'PAY-1', at: entry.at + 5, status: 'done', next: undefined }
		const before = { ...entry, id: 'e_before', ticket: 'PAY-1', at: entry.at, next: ['finished already'] }
		const got = openWork([older, entry, done, before])
		expect(got).toHaveLength(1)
		expect(got[0]).toMatchObject({ key: 'PAY-2433', next: ['Add a two-retry regression test'] })
	})
})
