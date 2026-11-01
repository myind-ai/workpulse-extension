// What the graph page draws, from the entries and the filters. Pure, so the page stays about the page.
// Built on `brainGraph` and `core/brain-graph.ts`; nothing here decides anything those already decide.

import { neighbourhood, narrowGraph, capGraph } from '@/core/brain-graph'
import { brainGraph, type BrainGraph, type GraphEdgeKind, type GraphNodeType } from '@/core/brain-index'
import { parseBrainQuery } from '@/core/brain-query'
import { sourceOf, type BridgeEntry, type SourceType } from '@/core/bridge'
import type { SourceChoice } from '@/ui/SourceChip'

export const NODE_TYPES: GraphNodeType[] = ['lesson', 'source', 'project', 'ticket', 'tag']
export const EDGE_KINDS: GraphEdgeKind[] = ['source', 'project', 'ticket', 'related', 'tag']
export const MAX_DRAWN = 1000

export interface GraphFilters {
	query: string
	source: SourceChoice
	types: Set<GraphNodeType>
	kinds: Set<GraphEdgeKind>
	archived: boolean
	loneTags: boolean
	focus?: string
	depth: 1 | 2
}

export interface GraphModel {
	/** The lessons in play, and their graph with nothing narrowed: what the find box and the side panel read. */
	pool: BridgeEntry[]
	base: BrainGraph
	/** What is drawn. */
	view: BrainGraph
	/** Distance from the focus, for the radial layout. */
	distance?: Record<string, number>
	/** How many nodes the filters left, before the cap. */
	total: number
	byType: Record<GraphNodeType, number>
	byKind: Record<GraphEdgeKind, number>
	bySource: Partial<Record<SourceType | 'none', number>>
	/** Tags that join one lesson in the whole Brain: a property of the tag, not of what is searched for. */
	loneTags: number
	/** The focus is on nothing the Brain holds any more, archived included. */
	gone: boolean
	/** A signature of what is drawn: the same picture has the same one, whatever object it came in. */
	sig: string
}

function tally<K extends string>(keys: K[], values: K[]): Record<K, number> {
	const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>
	for (const v of values) out[v]++
	return out
}

/** `capGraph`, except the focus always stays: a radial picture with no centre is no picture. */
function capKeeping(g: BrainGraph, focus?: string) {
	if (!focus) return capGraph(g, MAX_DRAWN)
	const raised = { ...g, nodes: g.nodes.map((n) => (n.id === focus ? { ...n, degree: Infinity } : n)) }
	const { graph, hidden } = capGraph(raised, MAX_DRAWN)
	const was = g.nodes.find((n) => n.id === focus)
	return { graph: { ...graph, nodes: graph.nodes.map((n) => (n.id === focus && was ? was : n)) }, hidden }
}

const signature = (g: BrainGraph) =>
	`${g.nodes.map((n) => `${n.id}|${n.degree}|${n.label}|${n.kind ?? ''}|${n.archived ? 1 : 0}`).join('\n')}\n--\n${g.edges.map((e) => `${e.source}|${e.target}|${e.kind}`).join('\n')}`

export function graphModel(entries: BridgeEntry[], archived: BridgeEntry[], f: GraphFilters): GraphModel {
	// A focus on an archived lesson (its card links here too) brings the archive in, or it would read as gone.
	const focusArchived = !!f.focus && archived.some((e) => e.id === f.focus)
	const pool = f.archived || focusArchived ? [...entries, ...archived] : entries
	const base = brainGraph(pool)
	const gone = !!f.focus && !base.nodes.some((n) => n.id === f.focus) && !brainGraph([...entries, ...archived]).nodes.some((n) => n.id === f.focus)

	const bySource: GraphModel['bySource'] = {}
	for (const e of pool) {
		const k = sourceOf(e)?.type ?? 'none'
		bySource[k] = (bySource[k] ?? 0) + 1
	}

	// The buttons narrow by source too; a `source:` typed in the box wins, as on the Brain page.
	const typedSource = !!parseBrainQuery(f.query).filters.source
	const query = [f.query, !typedSource && f.source !== 'all' ? `source:${f.source}` : ''].filter(Boolean).join(' ')
	const asked = query.trim() ? narrowGraph(base, pool, { query }) : base

	const lone = base.nodes.filter((n) => n.type === 'tag' && n.degree === 1)
	const hide = new Set(f.loneTags ? [] : lone.map((n) => n.id).filter((id) => id !== f.focus))
	const seen = { ...asked, nodes: asked.nodes.filter((n) => !hide.has(n.id)), edges: asked.edges.filter((e) => !hide.has(e.target)) }

	/** What would be drawn with these types and kinds: narrowed, in focus, capped. */
	const drawnWith = (types: GraphNodeType[], kinds: GraphEdgeKind[]) => {
		const narrowed = narrowGraph(seen, pool, { types, edges: kinds })
		const near = f.focus ? neighbourhood(narrowed, f.focus, f.depth) : undefined
		const shown = near?.graph ?? narrowed
		return { near, shown, view: capKeeping(shown, f.focus).graph }
	}
	const on = { types: [...f.types], kinds: [...f.kinds] }
	const { near, shown, view } = drawnWith(on.types, on.kinds)

	// The legend says what is drawn. A type or kind switched off says what pressing it would bring back.
	const byType = tally(NODE_TYPES, view.nodes.map((n) => n.type))
	const byKind = tally(EDGE_KINDS, view.edges.map((e) => e.kind))
	for (const t of NODE_TYPES) if (!f.types.has(t)) byType[t] = drawnWith([...on.types, t], on.kinds).view.nodes.filter((n) => n.type === t).length
	for (const k of EDGE_KINDS) if (!f.kinds.has(k)) byKind[k] = drawnWith(on.types, [...on.kinds, k]).view.edges.filter((e) => e.kind === k).length

	return {
		pool,
		base,
		view,
		distance: near?.distance,
		total: shown.nodes.length,
		byType,
		byKind,
		bySource,
		loneTags: lone.length,
		gone,
		sig: `${f.focus ?? ''}\n${f.focus ? f.depth : ''}\n${signature(view)}`,
	}
}
