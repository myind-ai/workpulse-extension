/**
 * Deterministic graph layouts with no dependency. `createLayout` is a Fruchterman-Reingold style force layout that the
 * page steps inside requestAnimationFrame; `radialLayout` puts one node at the centre with its neighbours on rings.
 * No Math.random: nodes start on a phyllotaxis spiral in id order, so the same graph always looks the same.
 */
import type { BrainGraph, GraphEdgeKind } from './brain-index'

export type Positions = Record<string, { x: number; y: number }>
type Graph = Pick<BrainGraph, 'nodes' | 'edges'>

const GOLDEN = 2.399963229728653
const IDEAL = 56 // spring length and repulsion scale
const TICKS_SMALL = 200
const TICKS_LARGE = 120
const SMALL_UP_TO = 400

export interface LayoutOptions {
	/**
	 * How far through the cooling to start, 0 to 1. A picture that has already settled and only changed a little starts
	 * late, so its nodes stay about where they were; the rest of the run is shorter by the same share. Default 0.
	 */
	startAt?: number
}

/** Late enough that a seeded run moves a node at most the sum of its last few ticks' heat: about 39 units up to 400 nodes, 24 above. */
export const SETTLED_START = 0.9

export function createLayout(g: Graph, seed: Positions = {}, options: LayoutOptions = {}): { step(ticks: number): boolean; positions(): Positions } {
	const ids = [...new Set(g.nodes.map((n) => n.id))].sort()
	const n = ids.length
	const index = new Map(ids.map((id, i) => [id, i]))
	const links: [number, number][] = []
	for (const e of [...g.edges].sort((a, b) => (a.source + '\0' + a.target + '\0' + a.kind).localeCompare(b.source + '\0' + b.target + '\0' + b.kind))) {
		const a = index.get(e.source)
		const b = index.get(e.target)
		if (a !== undefined && b !== undefined && a !== b) links.push([a, b])
	}
	const degree = new Float64Array(n)
	for (const [a, b] of links) (degree[a]!++, degree[b]!++)
	const radius = Float64Array.from(degree, (d) => 5 + Math.min(7, Math.sqrt(d)))

	const x = new Float64Array(n)
	const y = new Float64Array(n)
	ids.forEach((id, i) => {
		const s = seed[id]
		if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) [x[i], y[i]] = [s.x, s.y]
		else {
			const r = IDEAL * 0.6 * Math.sqrt(i + 0.5)
			;[x[i], y[i]] = [r * Math.cos(i * GOLDEN), r * Math.sin(i * GOLDEN)]
		}
	})
	// Starting late leaves a new node no heat to travel with, so it starts beside what it joins.
	if (options.startAt) {
		const known = (i: number) => {
			const s = seed[ids[i]!]
			return !!s && Number.isFinite(s.x) && Number.isFinite(s.y)
		}
		for (let i = 0; i < n; i++) {
			if (known(i)) continue
			const near = links.flatMap(([a, b]) => (a === i ? [b] : b === i ? [a] : [])).filter(known)
			if (!near.length) continue
			const a = i * GOLDEN
			x[i] = near.reduce((sum, j) => sum + x[j]!, 0) / near.length + IDEAL * 0.5 * Math.cos(a)
			y[i] = near.reduce((sum, j) => sum + y[j]!, 0) / near.length + IDEAL * 0.5 * Math.sin(a)
		}
	}
	const dx = new Float64Array(n)
	const dy = new Float64Array(n)
	const total = n <= SMALL_UP_TO ? TICKS_SMALL : TICKS_LARGE
	const reach = IDEAL * 12 // repulsion beyond this is ignored
	let tick = Math.floor(total * Math.max(0, Math.min(1, options.startAt ?? 0)))
	const someLinkedSomeLone = links.length > 0 && degree.some((d) => d === 0)

	/** Nothing holds a node with no links, so repulsion pushes it to the far edge; keep it on the rim of the rest. */
	function holdLoneNodes() {
		let cx = 0
		let cy = 0
		let count = 0
		for (let i = 0; i < n; i++) {
			if (!degree[i]) continue
			cx += x[i]!
			cy += y[i]!
			count++
		}
		cx /= count
		cy /= count
		// The 90th percentile, not the furthest: one long arm must not set how far out everything lone may sit.
		const out = new Float64Array(count)
		for (let i = 0, j = 0; i < n; i++) if (degree[i]) out[j++] = Math.hypot(x[i]! - cx, y[i]! - cy)
		const rim = out.sort()[Math.floor(count * 0.9)]! + IDEAL
		for (let i = 0; i < n; i++) {
			if (degree[i]) continue
			const d = Math.hypot(x[i]! - cx, y[i]! - cy)
			if (d <= rim) continue
			x[i] = cx + ((x[i]! - cx) / d) * rim
			y[i] = cy + ((y[i]! - cy) / d) * rim
		}
	}

	function once() {
		const cool = 1 - tick / total
		const heat = IDEAL * 0.5 * cool + 0.5
		dx.fill(0)
		dy.fill(0)
		for (let i = 0; i < n; i++)
			for (let j = i + 1; j < n; j++) {
				let ex = x[i]! - x[j]!
				let ey = y[i]! - y[j]!
				let d2 = ex * ex + ey * ey
				if (d2 > reach * reach) continue
				if (d2 < 1e-6) {
					// Same spot: split along a direction taken from the pair, not from chance.
					const a = (i * 31 + j * 17) * GOLDEN
					;[ex, ey, d2] = [Math.cos(a) * 0.01, Math.sin(a) * 0.01, 1e-4]
				}
				const min = radius[i]! + radius[j]! + 4
				let f = (IDEAL * IDEAL) / d2 // force / distance
				if (d2 < min * min) {
					const d = Math.sqrt(d2)
					f += (min - d) / d // collision
				}
				dx[i]! += ex * f
				dy[i]! += ey * f
				dx[j]! -= ex * f
				dy[j]! -= ey * f
			}
		for (const [a, b] of links) {
			const ex = x[a]! - x[b]!
			const ey = y[a]! - y[b]!
			const d = Math.sqrt(ex * ex + ey * ey) || 1e-3
			const f = d / IDEAL // d^2/IDEAL over d
			dx[a]! -= ex * f
			dy[a]! -= ey * f
			dx[b]! += ex * f
			dy[b]! += ey * f
		}
		for (let i = 0; i < n; i++) {
			dx[i]! -= x[i]! * 0.05 // gentle pull to the centre
			dy[i]! -= y[i]! * 0.05
			const m = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!)
			const s = m > heat ? heat / m : 1
			x[i]! += dx[i]! * s
			y[i]! += dy[i]! * s
		}
		if (someLinkedSomeLone) holdLoneNodes()
		tick++
	}

	return {
		step(ticks: number) {
			for (let k = 0; k < ticks && tick < total; k++) once()
			return tick >= total
		},
		positions() {
			const out: Positions = {}
			ids.forEach((id, i) => (out[id] = { x: x[i]!, y: y[i]! }))
			return out
		},
	}
}

const KIND_ORDER: GraphEdgeKind[] = ['source', 'project', 'ticket', 'related', 'tag']
const SPACING = 16

/**
 * The focus at the origin; depth 1 on a ring grouped by the kind of edge to the focus and sorted by label; depth 2 on an
 * outer ring around its parent's angle. A node whose distance is not 1 or 2 (or absent) gets no position.
 */
export function radialLayout(g: Graph, focus: string, distance: Record<string, number>): Positions {
	const out: Positions = {}
	const byId = new Map(g.nodes.map((n) => [n.id, n]))
	if (!byId.has(focus)) return out
	out[focus] = { x: 0, y: 0 }
	const label = (id: string) => byId.get(id)?.label ?? id
	const cmp = (a: string, b: string) => label(a).localeCompare(label(b)) || a.localeCompare(b)
	const adj = new Map<string, { id: string; kind: GraphEdgeKind }[]>()
	for (const e of g.edges) {
		if (!byId.has(e.source) || !byId.has(e.target)) continue
		;(adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push({ id: e.target, kind: e.kind })
		;(adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push({ id: e.source, kind: e.kind })
	}
	const at = (d: number) => g.nodes.map((n) => n.id).filter((id) => distance[id] === d && id !== focus)

	const kindOf = (id: string) => {
		const ks = (adj.get(focus) ?? []).filter((a) => a.id === id).map((a) => KIND_ORDER.indexOf(a.kind))
		return ks.length ? Math.min(...ks) : KIND_ORDER.length
	}
	const ring1 = at(1).sort((a, b) => kindOf(a) - kindOf(b) || cmp(a, b))
	const r1 = Math.max(140, (ring1.length * SPACING) / (2 * Math.PI))
	const angle1 = new Map<string, number>()
	ring1.forEach((id, i) => {
		const a = (i / ring1.length) * 2 * Math.PI - Math.PI / 2
		angle1.set(id, a)
		out[id] = { x: r1 * Math.cos(a), y: r1 * Math.sin(a) }
	})

	const ring2 = at(2)
	const parentAngle = (id: string) => {
		const ps = (adj.get(id) ?? []).filter((a) => angle1.has(a.id)).map((a) => a.id).sort(cmp)
		return ps.length ? angle1.get(ps[0]!)! : -Math.PI / 2
	}
	const ideal = new Map(ring2.map((id) => [id, parentAngle(id)]))
	ring2.sort((a, b) => ideal.get(a)! - ideal.get(b)! || cmp(a, b))
	const r2 = Math.max(r1 + 110, (ring2.length * SPACING) / (2 * Math.PI))
	const gap = SPACING / r2
	const placed: number[] = []
	let drift = 0
	ring2.forEach((id, i) => {
		const want = ideal.get(id)!
		const a = i === 0 ? want : Math.max(want, placed[i - 1]! + gap)
		placed.push(a)
		drift += a - want
	})
	const shift = ring2.length ? drift / ring2.length : 0
	ring2.forEach((id, i) => {
		const a = placed[i]! - shift
		out[id] = { x: r2 * Math.cos(a), y: r2 * Math.sin(a) }
	})
	return out
}
