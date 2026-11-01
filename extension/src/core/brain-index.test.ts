import { describe, expect, it } from 'vitest'

import { brainIndex, brainRecord, openWork } from './brain-index'
import { searchBrain } from './brain-query'
import { fold, type BridgeEntry } from './bridge'

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
	it('builds the index text and a version 3 graph', () => {
		const { index, graph } = brainIndex([entry], entry.at + 10)
		expect(index).toContain('Open next actions')
		expect(index).toContain('records/cli-test/2026-10/')
		expect(JSON.parse(graph).version).toBe(3)
	})

	it('grows linearly: 2,000 entries on one ticket make 2,000 ticket edges and one ticket node', () => {
		const many = Array.from({ length: 2000 }, (_, i) => ({ ...entry, id: `e_${i}`, at: entry.at + i, tags: [] }))
		const g = JSON.parse(brainIndex(many).graph)
		expect(g.edges.filter((x: { kind: string }) => x.kind === 'ticket')).toHaveLength(2000)
		expect(g.nodes.filter((x: { type: string }) => x.type === 'ticket')).toHaveLength(1)
	})

	it('a tag is one node whatever its case', () => {
		const a = { ...entry, id: 'e_a', tags: ['Retry'] }
		const b = { ...entry, id: 'e_b', tags: ['retry'] }
		const g = JSON.parse(brainIndex([a, b]).graph)
		expect(g.nodes.filter((x: { type: string }) => x.type === 'tag')).toHaveLength(1)
	})

	it('a deleted entry is not there, and the serialised graph holds no body text', () => {
		const secret = { ...entry, id: 'e_body', body: 'zebra-unique-body-text' }
		const kept = brainIndex([secret]).graph
		expect(kept).not.toContain('zebra-unique-body-text')
		const gone = fold({ 'a.jsonl': [JSON.stringify(secret), JSON.stringify({ ...secret, id: 'e_del', at: secret.at + 1, amends: 'e_body', state: 'deleted' })].join('\n') })
		expect(JSON.parse(brainIndex(gone).graph).nodes).toHaveLength(0)
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
