// Questions to ask a Brain graph: find a node, what is near it, what connects to it, a narrower view, a capped one.
// One implementation for `wp-brain graph`, `graph.json` and the graph page. Pure. Values come only from
// ./bridge.ts, ./brain-query.ts and ./brain-index.ts, so Node's type stripping loads it.

import type { BrainGraph, GraphEdge, GraphEdgeKind, GraphNode, GraphNodeType } from './brain-index.ts'
import { searchBrain } from './brain-query.ts'
import { entryByRef, type BridgeEntry } from './bridge.ts'

const KIND_ORDER: GraphEdgeKind[] = ['source', 'project', 'ticket', 'related', 'tag']

const empty = (g: BrainGraph): BrainGraph => ({ version: 3, generatedAt: g.generatedAt, nodes: [], edges: [] })

/** Degrees counted again from the edges that are left. */
function withDegrees(g: BrainGraph, nodes: GraphNode[], edges: GraphEdge[]): BrainGraph {
	const degree = new Map<string, number>()
	for (const e of edges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1)
	return { ...g, nodes: nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })), edges }
}

/** What a lesson node says about its entry, as far as the graph knows it (no body text), to search it. */
function entriesOf(g: BrainGraph): BridgeEntry[] {
	const byId = new Map(g.nodes.map((n) => [n.id, n]))
	const into = new Map<string, BridgeEntry>()
	for (const n of g.nodes) {
		if (n.type !== 'lesson') continue
		into.set(n.id, { schema: 'workpulse.bridge.entry/1', id: n.id, at: n.at ?? 0, device: '', kind: (n.kind ?? 'learning') as BridgeEntry['kind'], scope: n.scope === 'personal' ? 'personal' : 'work', title: n.label, status: n.status, tags: [] })
	}
	for (const e of g.edges) {
		const entry = into.get(e.source)
		const hub = byId.get(e.target)
		if (!entry || !hub) continue
		if (e.kind === 'ticket') entry.ticket = hub.label
		else if (e.kind === 'project') entry.project = hub.label
		else if (e.kind === 'tag') entry.tags!.push(hub.label)
		else if (e.kind === 'source') entry.source = { type: (hub.sourceType ?? 'manual') as NonNullable<BridgeEntry['source']>['type'], ...(hub.url ? { url: hub.url } : {}) }
	}
	return [...into.values()]
}

export type FoundHow = 'form' | 'id' | 'name' | 'search' | 'none'

/**
 * The node a person means by `ref`, first hit wins: `ticket:K` / `tag:x` / `#x` / `project:p` / `source:…`; an entry
 * id or the end of one; a hub named exactly that (case aside); then lessons by search, at most 5. `entries` gives the
 * search their full text; without them it reads the titles, tags, tickets and projects the graph holds.
 */
export function findNodesHow(g: BrainGraph, ref: string, entries?: BridgeEntry[]): { nodes: GraphNode[]; how: FoundHow } {
	const r = ref.trim()
	if (!r) return { nodes: [], how: 'none' }
	const byId = new Map(g.nodes.map((n) => [n.id, n]))
	const pick = (...ids: string[]) => ids.map((id) => byId.get(id)).filter((n): n is GraphNode => !!n)
	const form = r.match(/^(ticket|tag|project|source):(.+)$/i)
	const hash = r.match(/^#([\w-]+)$/)
	if (hash) {
		const got = pick(`tag:${hash[1].toLowerCase()}`)
		if (got.length) return { nodes: got, how: 'form' }
	} else if (form) {
		const kind = form[1].toLowerCase()
		const value = form[2].trim()
		const got =
			kind === 'ticket' ? pick(`ticket:${value.toUpperCase()}`)
			: kind === 'tag' ? pick(`tag:${value.replace(/^#/, '').toLowerCase()}`)
			: kind === 'project' ? pick(`project:${value.toLowerCase()}`)
			: pick(`source:${value}`).concat(g.nodes.filter((n) => n.type === 'source' && n.id !== `source:${value}` && n.sourceType === value.toLowerCase()))
		if (got.length) return { nodes: got, how: 'form' }
	}
	const lessons = g.nodes.filter((n) => n.type === 'lesson')
	const byRef = entryByRef(lessons as unknown as BridgeEntry[], r)
	if (!('error' in byRef)) return { nodes: pick((byRef as unknown as GraphNode).id), how: 'id' }
	const lower = r.toLowerCase()
	const named = g.nodes.filter((n) => n.type !== 'lesson' && (n.label.toLowerCase() === lower || n.id.toLowerCase() === lower))
	if (named.length) return { nodes: named, how: 'name' }
	// Several ids ending the same way: list them rather than guess.
	if (/^[\w-]{4,}$/.test(r) && /\d/.test(r)) {
		const ends = lessons.filter((n) => n.id.toLowerCase().endsWith(lower))
		if (ends.length > 1) return { nodes: ends.slice(0, 5), how: 'id' }
	}
	const found = searchBrain(entries ?? entriesOf(g), r)
		.map((x) => byId.get(x.e.id))
		.filter((n): n is GraphNode => !!n && n.type === 'lesson')
		.slice(0, 5)
	return { nodes: found, how: found.length ? 'search' : 'none' }
}

export const findNodes = (g: BrainGraph, ref: string, entries?: BridgeEntry[]): GraphNode[] => findNodesHow(g, ref, entries).nodes

/** Everything within `depth` steps of a node, and how far each is. An unknown id gives an empty graph. */
export function neighbourhood(g: BrainGraph, id: string, depth: 1 | 2): { graph: BrainGraph; distance: Record<string, number> } {
	if (!g.nodes.some((n) => n.id === id)) return { graph: empty(g), distance: {} }
	const near = new Map<string, string[]>()
	for (const e of g.edges) {
		near.set(e.source, [...(near.get(e.source) ?? []), e.target])
		near.set(e.target, [...(near.get(e.target) ?? []), e.source])
	}
	const distance: Record<string, number> = { [id]: 0 }
	let ring = [id]
	for (let d = 1; d <= depth; d++) {
		const next: string[] = []
		for (const from of ring) for (const to of near.get(from) ?? []) if (distance[to] === undefined) (distance[to] = d, next.push(to))
		ring = next
	}
	return { graph: { ...g, nodes: g.nodes.filter((n) => distance[n.id] !== undefined), edges: g.edges.filter((e) => distance[e.source] !== undefined && distance[e.target] !== undefined) }, distance }
}

/** What touches a node, grouped by the kind of edge, in a fixed order; each group has the nodes at the other end. */
export function connections(g: BrainGraph, id: string): { kind: GraphEdgeKind; nodes: GraphNode[] }[] {
	const byId = new Map(g.nodes.map((n) => [n.id, n]))
	const groups = new Map<GraphEdgeKind, Map<string, GraphNode>>()
	for (const e of g.edges) {
		const other = e.source === id ? e.target : e.target === id ? e.source : undefined
		const node = other ? byId.get(other) : undefined
		if (!node) continue
		if (!groups.has(e.kind)) groups.set(e.kind, new Map())
		groups.get(e.kind)!.set(node.id, node)
	}
	return KIND_ORDER.filter((k) => groups.has(k)).map((kind) => ({ kind, nodes: [...groups.get(kind)!.values()] }))
}

export interface NarrowOptions {
	query?: string
	types?: GraphNodeType[]
	edges?: GraphEdgeKind[]
	hideLoneTags?: boolean
}

/**
 * A narrower view. `query` (words and filters, as the search box) keeps the lessons it finds and only the hubs they
 * touch; `types` and `edges` keep only those; `hideLoneTags` then drops tags that join one lesson. Degrees are counted again.
 */
export function narrowGraph(g: BrainGraph, entries: BridgeEntry[], opts: NarrowOptions = {}): BrainGraph {
	let nodes = g.nodes
	let edges = g.edges
	if (opts.query?.trim()) {
		const keep = new Set(searchBrain(entries, opts.query).map((x) => x.e.id))
		const lessons = nodes.filter((n) => n.type === 'lesson' && keep.has(n.id))
		edges = edges.filter((e) => keep.has(e.source))
		const touched = new Set(edges.map((e) => e.target))
		nodes = [...lessons, ...nodes.filter((n) => n.type !== 'lesson' && touched.has(n.id))]
	}
	if (opts.types) {
		const types = new Set(opts.types)
		nodes = nodes.filter((n) => types.has(n.type))
		const ids = new Set(nodes.map((n) => n.id))
		edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
	}
	if (opts.edges) {
		const kinds = new Set(opts.edges)
		edges = edges.filter((e) => kinds.has(e.kind))
		const touched = new Set(edges.flatMap((e) => [e.source, e.target]))
		nodes = nodes.filter((n) => n.type === 'lesson' || touched.has(n.id))
	}
	let out = withDegrees(g, nodes, edges)
	if (opts.hideLoneTags) {
		const lone = new Set(out.nodes.filter((n) => n.type === 'tag' && n.degree === 1).map((n) => n.id))
		out = withDegrees(g, out.nodes.filter((n) => !lone.has(n.id)), out.edges.filter((e) => !lone.has(e.target)))
	}
	return out
}

/** The `max` most connected nodes (newest first on a tie) and the edges between them; `hidden` is how many were left out. */
export function capGraph(g: BrainGraph, max = 1000): { graph: BrainGraph; hidden: number } {
	if (g.nodes.length <= max) return { graph: g, hidden: 0 }
	const keep = new Set([...g.nodes].sort((a, b) => b.degree - a.degree || (b.at ?? 0) - (a.at ?? 0)).slice(0, max).map((n) => n.id))
	return { graph: { ...g, nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) }, hidden: g.nodes.length - keep.size }
}
