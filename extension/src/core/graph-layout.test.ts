import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode } from './brain-index'
import { createLayout, radialLayout, SETTLED_START, type Positions } from './graph-layout'

const node = (id: string, label = id): GraphNode => ({ id, type: 'lesson', label, degree: 0 })
const edge = (source: string, target: string, kind: GraphEdge['kind'] = 'tag'): GraphEdge => ({ source, target, kind })
const ids = (n: number, p = 'n') => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(4, '0')}`)
const graphOf = (nodeIds: string[], edges: GraphEdge[]) => ({ nodes: nodeIds.map((i) => node(i)), edges })
const run = (g: ReturnType<typeof graphOf>, seed?: Positions) => {
	const l = createLayout(g, seed)
	while (!l.step(50)) {
		/* keep stepping until settled */
	}
	return l.positions()
}
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
const finiteAndBounded = (p: Positions) => {
	for (const v of Object.values(p)) {
		expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true)
		expect(Math.abs(v.x)).toBeLessThan(20000)
		expect(Math.abs(v.y)).toBeLessThan(20000)
	}
}

const twoClusters = () => {
	const a = ids(8, 'a')
	const b = ids(8, 'b')
	const edges: GraphEdge[] = []
	for (const c of [a, b]) for (let i = 1; i < c.length; i++) edges.push(edge(c[0]!, c[i]!))
	edges.push(edge('a0000', 'b0000'))
	return graphOf([...a, ...b], edges)
}

describe('createLayout', () => {
	it('gives the same positions for the same graph, whatever the input order', () => {
		const g = twoClusters()
		const reversed = { nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() }
		expect(run(g)).toEqual(run(g))
		expect(run(reversed)).toEqual(run(g))
	})

	it('handles 0, 1 and 2 nodes, nodes seeded at one point, and isolated nodes', () => {
		expect(run(graphOf([], []))).toEqual({})
		finiteAndBounded(run(graphOf(['a'], [])))
		finiteAndBounded(run(graphOf(['a', 'b'], [edge('a', 'b')])))
		const same = Object.fromEntries(ids(10).map((i) => [i, { x: 5, y: 5 }]))
		const p = run(graphOf(ids(10), [edge('n0000', 'n0001')]), same)
		finiteAndBounded(p)
		expect(dist(p.n0002!, p.n0003!)).toBeGreaterThan(0)
		finiteAndBounded(run(graphOf(ids(30), [edge('n0000', 'n0001'), edge('n0001', 'n0002'), edge('n0000', 'ghost')])))
	})

	it('draws connected nodes closer than unconnected ones', () => {
		const g = twoClusters()
		const p = run(g)
		const linked = new Set(g.edges.map((e) => [e.source, e.target].sort().join('|')))
		let el = 0
		let en = 0
		let ul = 0
		let un = 0
		for (let i = 0; i < g.nodes.length; i++)
			for (let j = i + 1; j < g.nodes.length; j++) {
				const a = g.nodes[i]!.id
				const b = g.nodes[j]!.id
				const d = dist(p[a]!, p[b]!)
				if (linked.has([a, b].sort().join('|'))) (el += d), en++
				else (ul += d), un++
			}
		expect(el / en).toBeLessThan(ul / un)
	})

	it('keeps seeded nodes near where they were when a node is added', () => {
		const before = twoClusters()
		const seed = run(before)
		const after = { nodes: [...before.nodes, node('c0000')], edges: [...before.edges, edge('a0003', 'c0000')] }
		const move = (p: Positions) => before.nodes.reduce((s, n) => s + dist(p[n.id]!, seed[n.id]!), 0) / before.nodes.length
		expect(move(run(after, seed))).toBeLessThan(move(run(after)))
	})

	it('runs in slices and matches one run with the same tick total', () => {
		const g = twoClusters()
		const one = createLayout(g)
		one.step(1000)
		const sliced = createLayout(g)
		let calls = 0
		while (!sliced.step(7)) calls++
		expect(calls).toBeGreaterThan(3)
		expect(sliced.positions()).toEqual(one.positions())
		expect(one.step(1)).toBe(true)
	})

	it('counts ticks on a 1,000-node graph: 120 ticks, then settled', { timeout: 30_000 }, () => {
		const n = ids(1000)
		const edges: GraphEdge[] = []
		for (let i = 1; i < n.length; i++) edges.push(edge(n[i]!, n[Math.floor(i / 3)]!))
		for (let i = 0; i < 600; i++) edges.push(edge(n[(i * 7) % 1000]!, n[(i * 13 + 5) % 1000]!))
		const l = createLayout(graphOf(n, edges))
		expect(l.step(119)).toBe(false)
		expect(l.step(1)).toBe(true)
		finiteAndBounded(l.positions())
	})

	it('uses 200 ticks up to 400 nodes', () => {
		const l = createLayout(graphOf(ids(400), []))
		expect(l.step(199)).toBe(false)
		expect(l.step(1)).toBe(true)
	})
})

describe('createLayout started late, for a picture that has already settled', () => {
	/** Shaped like the Brain: lessons on a few busy hubs and some that join nothing. */
	const brainLike = () => {
		const hubs = ids(40, 'h')
		const lessons = ids(240, 'l')
		const edges: GraphEdge[] = []
		lessons.slice(0, 225).forEach((l, i) => {
			edges.push(edge(l, hubs[i % 7]!))
			edges.push(edge(l, hubs[(i * i + 3) % 40]!))
		})
		return graphOf([...hubs, ...lessons], edges)
	}
	const settle = (g: ReturnType<typeof graphOf>, seed?: Positions, startAt?: number) => {
		const l = createLayout(g, seed, { startAt })
		while (!l.step(50)) {
			/* keep stepping until settled */
		}
		return l.positions()
	}
	const meanMove = (a: Positions, b: Positions) => {
		const keys = Object.keys(a).filter((k) => b[k])
		return keys.reduce((sum, k) => sum + dist(a[k]!, b[k]!), 0) / keys.length
	}

	it('barely moves an identical graph, where a full-heat run moves it a lot', () => {
		const g = brainLike()
		const rest = settle(g)
		const late = meanMove(rest, settle(g, rest, SETTLED_START))
		expect(late).toBeLessThan(40)
		expect(late * 2).toBeLessThan(meanMove(rest, settle(g, rest)))
	})

	it('barely moves what survives when a type is taken away', () => {
		const g = brainLike()
		const rest = settle(g)
		const left = { nodes: g.nodes.filter((n) => !n.id.startsWith('h000')), edges: g.edges.filter((e) => !e.target.startsWith('h000')) }
		expect(meanMove(rest, settle(left, rest, SETTLED_START))).toBeLessThan(40)
	})

	it('starts a new node beside what it joins', () => {
		const g = brainLike()
		const rest = settle(g)
		const after = { nodes: [...g.nodes, node('new')], edges: [...g.edges, edge('new', 'h0001')] }
		const p = settle(after, rest, SETTLED_START)
		expect(dist(p.new!, p.h0001!)).toBeLessThan(120)
		expect(meanMove(rest, p)).toBeLessThan(40)
	})

	it('shortens the run by the share it skips, and leaves a run with no option at its full count', () => {
		const small = graphOf(ids(100), [])
		const late = createLayout(small, {}, { startAt: SETTLED_START })
		expect(late.step(19)).toBe(false)
		expect(late.step(1)).toBe(true)
		const full = createLayout(small)
		expect(full.step(199)).toBe(false)
		expect(full.step(1)).toBe(true)
		expect(createLayout(small, {}, { startAt: 1 }).step(0)).toBe(true)
	})

	it('holds a node with no links on the rim of the rest', () => {
		const g = brainLike()
		const p = settle(g)
		const linked = g.nodes.map((n) => n.id).filter((id) => !/^l02(2[5-9]|3\d)/.test(id))
		const lone = g.nodes.map((n) => n.id).filter((id) => /^l02(2[5-9]|3\d)/.test(id))
		const cx = linked.reduce((s, id) => s + p[id]!.x, 0) / linked.length
		const cy = linked.reduce((s, id) => s + p[id]!.y, 0) / linked.length
		const reach = Math.max(...linked.map((id) => Math.hypot(p[id]!.x - cx, p[id]!.y - cy)))
		expect(lone.length).toBe(15)
		for (const id of lone) expect(Math.hypot(p[id]!.x - cx, p[id]!.y - cy)).toBeLessThanOrEqual(reach + 56 + 1)
	})
})

describe('radialLayout', () => {
	const star = (n1: number, n2PerParent = 0) => {
		const nodes = [node('focus')]
		const edges: GraphEdge[] = []
		const distance: Record<string, number> = { focus: 0 }
		for (let i = 0; i < n1; i++) {
			const id = `p${String(i).padStart(3, '0')}`
			nodes.push(node(id, `P ${String(i).padStart(3, '0')}`))
			edges.push(edge('focus', id, i % 2 ? 'tag' : 'project'))
			distance[id] = 1
			for (let j = 0; j < n2PerParent; j++) {
				const c = `${id}c${j}`
				nodes.push(node(c))
				edges.push(edge(id, c))
				distance[c] = 2
			}
		}
		return { g: { nodes, edges }, distance }
	}

	it('puts the focus at the origin, depth 1 on one ring and depth 2 further out', () => {
		const { g, distance } = star(10, 3)
		const p = radialLayout(g, 'focus', distance)
		expect(p.focus).toEqual({ x: 0, y: 0 })
		const r1 = Object.keys(distance).filter((k) => distance[k] === 1).map((k) => Math.hypot(p[k]!.x, p[k]!.y))
		expect(Math.max(...r1) - Math.min(...r1)).toBeLessThan(1e-6)
		expect(r1[0]).toBeGreaterThanOrEqual(140)
		for (const k of Object.keys(distance).filter((k) => distance[k] === 2)) expect(Math.hypot(p[k]!.x, p[k]!.y)).toBeGreaterThan(r1[0]!)
	})

	it('grows the ring to fit and keeps 60 siblings apart', () => {
		const { g, distance } = star(60)
		const p = radialLayout(g, 'focus', distance)
		const keys = Object.keys(distance).filter((k) => distance[k] === 1)
		expect(Math.hypot(p[keys[0]!]!.x, p[keys[0]!]!.y)).toBeGreaterThanOrEqual((60 * 16) / (2 * Math.PI) - 1e-6)
		let min = Infinity
		for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) min = Math.min(min, dist(p[keys[i]!]!, p[keys[j]!]!))
		expect(min).toBeGreaterThan(15)
	})

	it('groups depth 1 by edge kind, then label, and is deterministic', () => {
		const { g, distance } = star(6)
		const p = radialLayout(g, 'focus', distance)
		expect(radialLayout({ nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() }, 'focus', distance)).toEqual(p)
		const angle = (k: string) => (Math.atan2(p[k]!.y, p[k]!.x) + Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI) // from the top, clockwise
		const project = ['p000', 'p002', 'p004'].map(angle)
		const tag = ['p001', 'p003', 'p005'].map(angle)
		expect(Math.max(...project)).toBeLessThan(Math.min(...tag))
		expect(project).toEqual([...project].sort((a, b) => a - b))
	})

	it('copes with an unknown focus and an empty graph', () => {
		expect(radialLayout({ nodes: [], edges: [] }, 'x', {})).toEqual({})
		finiteAndBounded(radialLayout({ nodes: [node('a')], edges: [] }, 'zzz', { a: 1 }))
	})
})
