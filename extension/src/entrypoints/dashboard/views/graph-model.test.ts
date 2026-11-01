import { describe, expect, it } from 'vitest'

import type { BridgeEntry } from '@/core/bridge'

import { EDGE_KINDS, graphModel, MAX_DRAWN, NODE_TYPES, type GraphFilters } from './graph-model'

const lesson = (id: string, more: Partial<BridgeEntry> = {}): BridgeEntry => ({ schema: 'workpulse.bridge.entry/1', id, at: 1000, device: 'd', kind: 'learning', scope: 'work', title: `Lesson ${id}`, ...more })
const filters = (more: Partial<GraphFilters> = {}): GraphFilters => ({ query: '', source: 'all', types: new Set(NODE_TYPES), kinds: new Set(EDGE_KINDS), archived: false, loneTags: false, depth: 1, ...more })
const ids = (m: { view: { nodes: { id: string }[] } }) => m.view.nodes.map((n) => n.id).sort()

describe('what the graph page draws', () => {
	const entries = [lesson('a', { tags: ['shared', 'once'] }), lesson('b', { tags: ['shared'] }), lesson('c')]

	it('should leave out tags used once, keep their count, and keep a lesson with no links', () => {
		const m = graphModel(entries, [], filters())
		expect(ids(m)).toEqual(['a', 'b', 'c', 'tag:shared'])
		expect(m.loneTags).toBe(1)
		expect(ids(graphModel(entries, [], filters({ loneTags: true })))).toContain('tag:once')
	})

	it('should keep a tag used once when it is the focus', () => {
		expect(ids(graphModel(entries, [], filters({ focus: 'tag:once' })))).toEqual(['a', 'tag:once'])
	})

	it('should have a type that is off say what pressing it would bring back', () => {
		const m = graphModel(entries, [], filters({ types: new Set(['lesson']) }))
		expect(ids(m)).toEqual(['a', 'b', 'c'])
		expect(m.byType.tag).toBe(1)
		expect(m.byType.lesson).toBe(3)
		expect(m.byKind.tag).toBe(0)
	})

	it('should count the legend from what is drawn, inside a focus and under the cap', () => {
		const m = graphModel(entries, [], filters({ focus: 'a' }))
		expect(ids(m)).toEqual(['a', 'tag:shared'])
		expect([m.byType.lesson, m.byType.tag, m.byKind.tag]).toEqual([1, 1, 1])
		const many = Array.from({ length: MAX_DRAWN + 200 }, (_, i) => lesson(`l${i}`, { tags: ['hub', `t${i % 3}`] }))
		const capped = graphModel(many, [], filters())
		expect(NODE_TYPES.reduce((n, t) => n + capped.byType[t], 0)).toBe(capped.view.nodes.length)
		expect(EDGE_KINDS.reduce((n, k) => n + capped.byKind[k], 0)).toBe(capped.view.edges.length)
	})

	it('should have an edge kind that is off say what pressing it would bring back', () => {
		const m = graphModel(entries, [], filters({ kinds: new Set(EDGE_KINDS.filter((k) => k !== 'tag')) }))
		expect(m.view.edges.length).toBe(0)
		expect(m.byKind.tag).toBe(2)
	})

	it('should call a tag used once by the whole Brain, whatever the search', () => {
		const m = graphModel(entries, [], filters({ query: 'id:b' }))
		expect(m.loneTags).toBe(1)
		expect(ids(m)).toEqual(['b', 'tag:shared'])
	})

	it('should let a typed source win over the buttons', () => {
		const list = [lesson('y', { source: { type: 'youtube', url: 'https://youtu.be/x' } }), lesson('s', { source: { type: 'site', url: 'https://a.example/b' } })]
		expect(ids(graphModel(list, [], filters({ source: 'youtube' })))).toEqual(['source:youtube:x', 'y'])
		expect(ids(graphModel(list, [], filters({ source: 'youtube', query: 'source:site' })))).toEqual(['s', 'source:a.example/b'])
	})

	it('should know a focus that is gone from one the filters hide', () => {
		expect(graphModel(entries, [], filters({ focus: 'nope' })).gone).toBe(true)
		const hidden = graphModel(entries, [], filters({ focus: 'a', query: 'zebrafinch' }))
		expect([hidden.gone, hidden.view.nodes.length]).toEqual([false, 0])
	})

	it('should draw a focus on an archived lesson rather than call it gone', () => {
		const m = graphModel(entries, [lesson('old', { archived: true, tags: ['shared'] })], filters({ focus: 'old' }))
		expect(m.gone).toBe(false)
		expect(ids(m)).toEqual(['old', 'tag:shared'])
	})

	it('should cap what is drawn, say how many there were, and never drop the focus', () => {
		const many = Array.from({ length: MAX_DRAWN + 200 }, (_, i) => lesson(`l${i}`, { tags: ['hub', `t${i % 3}`] }))
		const m = graphModel([...many, lesson('quiet', { tags: ['hub'] })], [], filters({ focus: 'tag:hub' }))
		expect(m.view.nodes.length).toBe(MAX_DRAWN)
		expect(m.total).toBe(MAX_DRAWN + 202)
		expect(m.view.nodes.some((n) => n.id === 'tag:hub')).toBe(true)
		const quiet = graphModel(many.concat(lesson('quiet')), [], filters({ focus: 'quiet' }))
		expect(ids(quiet)).toEqual(['quiet'])
	})

	it('should give the same picture the same signature, whichever object it came in', () => {
		expect(graphModel(entries, [], filters()).sig).toBe(graphModel([...entries], [], filters()).sig)
		expect(graphModel(entries, [], filters()).sig).not.toBe(graphModel(entries.slice(1), [], filters()).sig)
	})
})
