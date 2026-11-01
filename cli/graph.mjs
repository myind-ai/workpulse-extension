// The text `wp-brain graph` prints. Pure: takes a graph from extension/src/core/brain-index.ts, returns lines.
import { connections, neighbourhood } from '../extension/src/core/brain-graph.ts'
import { shortId } from '../extension/src/core/bridge.ts'

const TYPES = ['lesson', 'source', 'project', 'ticket', 'tag']
const plural = { lesson: 'lessons', source: 'sources', project: 'projects', ticket: 'tickets', tag: 'tags' }

/** How a node reads in a list: a lesson with its id, a hub with its type. */
export const nodeLine = (n) => (n.type === 'lesson' ? `[${shortId(n.id)}] ${n.label}${n.kind ? ` (${n.kind})` : ''}` : `${n.type}: ${n.label}`)

/** Counts per node type and the most connected hubs. */
export function overviewLines(g) {
	const count = (t) => g.nodes.filter((n) => n.type === t).length
	const lines = [`Brain graph: ${TYPES.map((t) => `${count(t)} ${count(t) === 1 ? t : plural[t]}`).join(', ')}; ${g.edges.length} connection${g.edges.length === 1 ? '' : 's'}.`]
	const top = g.nodes.filter((n) => n.type !== 'lesson').sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label)).slice(0, 10)
	if (top.length) lines.push('', 'Most connected:', ...top.map((n) => `  ${n.type}: ${n.label}  (${n.degree} lesson${n.degree === 1 ? '' : 's'})`))
	lines.push('', 'Ask about one: wp-brain graph PAY-123 | \'#tag\' | project:name | <id> | "words"')
	return lines
}

/** The nodes within `depth` of a node. `types` filters what comes back; the walk still goes through every node. */
export function connectionGraph(g, id, { depth = 1, types } = {}) {
	const near = neighbourhood(g, id, depth)
	if (!types) return near
	const kept = new Set(near.graph.nodes.filter((n) => n.id === id || types.includes(n.type)).map((n) => n.id))
	return {
		graph: { ...near.graph, nodes: near.graph.nodes.filter((n) => kept.has(n.id)), edges: near.graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target)) },
		distance: Object.fromEntries(Object.entries(near.distance).filter(([n]) => kept.has(n))),
	}
}

/** What connects to a node, grouped by kind; `depth` 2 adds what those neighbours connect to. `types` filters what is listed, and the count is of what is listed. */
export function connectionLines(g, node, { depth = 1, limit = 20, types } = {}) {
	const wanted = (n) => !types || types.includes(n.type)
	const groups = connections(g, node.id)
		.map((x) => ({ ...x, nodes: x.nodes.filter(wanted) }))
		.filter((x) => x.nodes.length)
	const { graph, distance } = neighbourhood(g, node.id, depth)
	const far = depth === 2 ? graph.nodes.filter((n) => distance[n.id] === 2 && wanted(n)).sort((a, b) => b.degree - a.degree) : []
	const total = groups.reduce((n, x) => n + x.nodes.length, 0) + far.length
	const lines = [`${nodeLine(node)}  - ${total} connection${total === 1 ? '' : 's'}`]
	const cap = (nodes, indent) => {
		for (const n of nodes.slice(0, limit)) lines.push(`${indent}${nodeLine(n)}`)
		if (nodes.length > limit) lines.push(`${indent}… and ${nodes.length - limit} more`)
	}
	for (const group of groups) {
		lines.push('', `${group.kind} (${group.nodes.length}):`)
		cap(group.nodes, '  ')
	}
	if (far.length) lines.push('', `Two steps away (${far.length}):`), cap(far, '  ')
	return lines
}
