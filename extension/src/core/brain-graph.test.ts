import { describe, expect, it } from 'vitest'

import { brainGraph } from './brain-index'
import { capGraph, connections, findNodes, narrowGraph, neighbourhood } from './brain-graph'
import type { BridgeEntry } from './bridge'

const at = Date.UTC(2026, 9, 26, 10)
const mk = (id: string, more: Partial<BridgeEntry> = {}): BridgeEntry => ({ schema: 'workpulse.bridge.entry/1', id, at, device: 'cli-test', kind: 'learning', scope: 'work', title: `Title ${id}`, ...more })

const full = mk('e_full0001', {
	title: 'Retry webhook',
	ticket: 'pay-1',
	project: 'Payments',
	tags: ['retry', 'webhook'],
	links: { related: ['PAY-2'] },
	source: { type: 'youtube', url: 'https://www.youtube.com/watch?v=abc', title: 'Talk' },
})

describe('brainGraph', () => {
	it('makes one lesson, six hubs and six edges of the right kinds', () => {
		const g = brainGraph([full])
		expect(g.version).toBe(3)
		expect(g.nodes.filter((n) => n.type === 'lesson')).toHaveLength(1)
		expect(g.nodes.filter((n) => n.type !== 'lesson').map((n) => n.id).sort()).toEqual(['project:payments', 'source:youtube:abc', 'tag:retry', 'tag:webhook', 'ticket:PAY-1', 'ticket:PAY-2'])
		expect(g.edges.map((e) => e.kind).sort()).toEqual(['project', 'related', 'source', 'tag', 'tag', 'ticket'])
		expect(g.edges.every((e) => e.source === 'e_full0001')).toBe(true)
		expect(g.nodes.find((n) => n.id === 'project:payments')?.label).toBe('Payments')
		expect(g.nodes.find((n) => n.id === 'source:youtube:abc')).toMatchObject({ label: 'Talk', sourceType: 'youtube' })
	})

	it('the same video at different timestamps is one source node', () => {
		const a = mk('e_a0000001', { source: { type: 'youtube', url: 'https://www.youtube.com/watch?v=a&t=3s' } })
		const b = mk('e_b0000001', { source: { type: 'youtube', url: 'https://www.youtube.com/watch?v=a&t=90s' } })
		const g = brainGraph([a, b])
		const sources = g.nodes.filter((n) => n.type === 'source')
		expect(sources).toHaveLength(1)
		expect(sources[0].degree).toBe(2)
	})

	it('a related key equal to the ticket makes one edge; no fields is an isolated lesson', () => {
		const g = brainGraph([mk('e_t0000001', { ticket: 'PAY-1', links: { related: ['PAY-1'] } }), mk('e_n0000001', { device: 'cli-x' })])
		expect(g.edges).toHaveLength(1)
		expect(g.nodes.find((n) => n.id === 'e_n0000001')?.degree).toBe(0)
	})

	it('a source label falls back from title to host to the type label', () => {
		const g = brainGraph([mk('e_1', { source: { type: 'site', url: 'https://example.com/a' } }), mk('e_2', { source: { type: 'manual' } })])
		expect(g.nodes.filter((n) => n.type === 'source').map((n) => n.label).sort()).toEqual(['Manual', 'example.com'])
	})
})

const sample = () => {
	const l1 = mk('e_l1000001', { at, tags: ['x'], ticket: 'A-1', source: { type: 'youtube', url: 'https://youtu.be/v1' } })
	const l2 = mk('e_l2000001', { at: at + 1, tags: ['x', 'solo'], project: 'p' })
	const l3 = mk('e_l3000001', { at: at + 2, tags: ['y'], title: 'Unrelated zebra' })
	return [l1, l2, l3]
}

describe('neighbourhood', () => {
	it('depth 1 of a tag is the tag and its lessons; depth 2 adds their other hubs', () => {
		const g = brainGraph(sample())
		const one = neighbourhood(g, 'tag:x', 1)
		expect(one.graph.nodes.map((n) => n.id).sort()).toEqual(['e_l1000001', 'e_l2000001', 'tag:x'])
		expect(one.distance).toEqual({ 'tag:x': 0, e_l1000001: 1, e_l2000001: 1 })
		const two = neighbourhood(g, 'tag:x', 2)
		expect(two.distance['ticket:A-1']).toBe(2)
		expect(two.distance['tag:y']).toBeUndefined()
		expect(two.graph.edges.every((e) => two.distance[e.source] !== undefined && two.distance[e.target] !== undefined)).toBe(true)
	})
	it('an unknown id is empty, not an error', () => {
		const n = neighbourhood(brainGraph(sample()), 'nope', 2)
		expect(n.graph.nodes).toEqual([])
		expect(n.distance).toEqual({})
	})
})

describe('connections and findNodes', () => {
	it('groups a lesson’s hubs by kind', () => {
		const g = brainGraph(sample())
		const got = connections(g, 'e_l2000001')
		expect(got.map((c) => c.kind)).toEqual(['project', 'tag'])
		expect(got[1].nodes.map((n) => n.id).sort()).toEqual(['tag:solo', 'tag:x'])
	})
	it('finds by form, id, exact name, then search', () => {
		const entries = sample()
		const g = brainGraph(entries)
		expect(findNodes(g, '#X').map((n) => n.id)).toEqual(['tag:x'])
		expect(findNodes(g, 'ticket:a-1').map((n) => n.id)).toEqual(['ticket:A-1'])
		expect(findNodes(g, 'A-1').map((n) => n.id)).toEqual(['ticket:A-1'])
		expect(findNodes(g, 'project:P').map((n) => n.id)).toEqual(['project:p'])
		expect(findNodes(g, 'l2000001').map((n) => n.id)).toEqual(['e_l2000001'])
		expect(findNodes(g, 'source:youtube').map((n) => n.id)).toEqual(['source:youtube:v1'])
		expect(findNodes(g, 'zebra', entries).map((n) => n.id)).toEqual(['e_l3000001'])
		expect(findNodes(g, 'nothing-like-it', entries)).toEqual([])
	})
})

describe('narrowGraph', () => {
	it('source:youtube keeps those lessons and only the hubs they touch', () => {
		const entries = sample()
		const g = narrowGraph(brainGraph(entries), entries, { query: 'source:youtube' })
		expect(g.nodes.map((n) => n.id).sort()).toEqual(['e_l1000001', 'source:youtube:v1', 'tag:x', 'ticket:A-1'])
		expect(g.nodes.find((n) => n.id === 'tag:x')?.degree).toBe(1)
	})
	it('types without tag drop tag nodes and their edges', () => {
		const entries = sample()
		const g = narrowGraph(brainGraph(entries), entries, { types: ['lesson', 'ticket', 'project', 'source'] })
		expect(g.nodes.some((n) => n.type === 'tag')).toBe(false)
		expect(g.edges.some((e) => e.kind === 'tag')).toBe(false)
		expect(g.nodes.find((n) => n.id === 'e_l2000001')?.degree).toBe(1)
	})
	it('edge kinds keep only those edges', () => {
		const entries = sample()
		const g = narrowGraph(brainGraph(entries), entries, { edges: ['ticket'] })
		expect(g.edges.map((e) => e.kind)).toEqual(['ticket'])
		expect(g.nodes.some((n) => n.type === 'tag')).toBe(false)
		expect(g.nodes.filter((n) => n.type === 'lesson')).toHaveLength(3)
	})
	it('hideLoneTags drops tags with degree 1 only', () => {
		const entries = sample()
		const g = narrowGraph(brainGraph(entries), entries, { hideLoneTags: true })
		expect(g.nodes.filter((n) => n.type === 'tag').map((n) => n.id)).toEqual(['tag:x'])
	})
	it('a query matching nothing is empty', () => {
		const entries = sample()
		expect(narrowGraph(brainGraph(entries), entries, { query: 'qqqqzzzz' }).nodes).toEqual([])
	})
})

describe('capGraph', () => {
	it('keeps the 1,000 most connected, newest first on ties, and reports the rest', () => {
		const lessons = Array.from({ length: 1500 }, (_, i) => mk(`e_${String(i).padStart(5, '0')}`, { at: at + i }))
		const g = brainGraph(lessons)
		const { graph, hidden } = capGraph(g)
		expect(graph.nodes).toHaveLength(1000)
		expect(hidden).toBe(500)
		expect(graph.nodes.every((n) => n.at! >= at + 500)).toBe(true)
	})
	it('keeps hubs by degree and only edges between kept nodes', () => {
		const lessons = Array.from({ length: 5 }, (_, i) => mk(`e_${i}`, { at: at + i, tags: ['t'] }))
		const { graph, hidden } = capGraph(brainGraph(lessons), 3)
		expect(hidden).toBe(3)
		expect(graph.nodes.map((n) => n.id)).toContain('tag:t')
		expect(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.source) && graph.nodes.some((n) => n.id === e.target))).toBe(true)
	})
	it('under the cap returns the same graph', () => {
		const g = brainGraph(sample())
		expect(capGraph(g)).toEqual({ graph: g, hidden: 0 })
	})
})
