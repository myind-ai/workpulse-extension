// The column beside the graph: find any node, then what the selected one is. A lesson is the Brain page's own
// `EntryCard`, so edit, archive and delete work here; a hub lists what touches it. Reuses `SourceChip`, `EntryCard`,
// `connections`, `rankTitles`, `brainHash`.

import { useMemo, useState } from 'react'

import { connections } from '@/core/brain-graph'
import type { BrainGraph, GraphEdgeKind, GraphNode, GraphNodeType } from '@/core/brain-index'
import { brainHash, rankTitles } from '@/core/brain-query'
import { libraryKey, sourceOf, type BridgeEntry, type SourceType } from '@/core/bridge'
import { SourceChip } from '@/ui/SourceChip'

import { EntryCard } from './BrainView'
import { NodeMark } from './GraphCanvas'

const FOUND_MAX = 8
const LIST_STEP = 30
const TYPE_LABEL: Record<GraphNodeType, string> = { lesson: 'Lesson', source: 'Source', project: 'Project', ticket: 'Ticket', tag: 'Tag' }
const KIND_LABEL: Record<GraphEdgeKind, string> = { source: 'Source', project: 'Project', ticket: 'Ticket', related: 'Related ticket', tag: 'Tags' }

const nameOf = (n: GraphNode) => (n.type === 'tag' ? `#${n.label}` : n.label)
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Where a hub opens on the Brain page. A source has no filter of its own there. */
function brainLink(n: GraphNode): string | undefined {
	if (n.type === 'ticket') return brainHash({ ticket: n.label })
	if (n.type === 'project') return brainHash({ project: n.label })
	if (n.type === 'tag') return brainHash({ query: /^[\w-]+$/.test(n.label) ? `#${n.label}` : `tag:"${n.label}"` })
	return undefined
}

function NodeRow({ node, onSelect }: { node: GraphNode; onSelect: (id: string) => void }) {
	return (
		<button className="wp-action wp-graph-row" onClick={() => onSelect(node.id)} title={node.label}>
			<NodeMark type={node.type} />
			<span className="wp-graph-row-text">{nameOf(node)}</span>
		</button>
	)
}

function Connections({ graph, id, title, onSelect }: { graph: BrainGraph; id: string; title: (kind: GraphEdgeKind) => string; onSelect: (id: string) => void }) {
	const groups = useMemo(() => connections(graph, id), [graph, id])
	const [show, setShow] = useState(LIST_STEP)
	return (
		<>
			{groups.map((g) => (
				<div key={g.kind} className="wp-stack-sm">
					<span className="wp-eyebrow">
						{title(g.kind)} · {g.nodes.length}
					</span>
					{g.nodes.slice(0, show).map((n) => (
						<NodeRow key={n.id} node={n} onSelect={onSelect} />
					))}
					{g.nodes.length > show && (
						<button className="wp-action wp-muted" onClick={() => setShow(show + LIST_STEP)}>
							Show {Math.min(LIST_STEP, g.nodes.length - show)} more of {g.nodes.length - show}
						</button>
					)}
				</div>
			))}
		</>
	)
}

export function GraphPanel({
	base,
	entries,
	selected,
	focus,
	drawn,
	onSelect,
	onChanged,
}: {
	base: BrainGraph
	/** Active and archived: a lesson just archived here keeps its card, with Restore. */
	entries: BridgeEntry[]
	selected?: string
	focus?: string
	drawn: Set<string>
	onSelect: (id: string | undefined) => void
	onChanged: () => void
}) {
	const [find, setFind] = useState('')
	// Hubs first: on a tie, the thing with that name is meant before a lesson that mentions it.
	const found = useMemo(() => rankTitles([...base.nodes.filter((n) => n.type !== 'lesson'), ...base.nodes.filter((n) => n.type === 'lesson')], find, (n) => n.label).slice(0, FOUND_MAX), [base, find])
	const pick = (id: string) => {
		setFind('')
		onSelect(id)
	}
	const entry = selected ? entries.find((e) => e.id === selected) : undefined
	const hub = selected && !entry ? base.nodes.find((n) => n.id === selected) : undefined
	const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])
	const lessons = useMemo(() => (hub ? connections(base, hub.id).flatMap((g) => g.nodes) : []), [base, hub])
	const library = hub?.type === 'source' ? lessons.map((n) => byId.get(n.id)).map((e) => e && sourceOf(e)?.library).find(Boolean) : undefined
	const focusButton = selected && selected !== focus && (
		<button className="wp-btn wp-btn-sm" onClick={() => (location.hash = `#/graph/${encodeURIComponent(selected)}`)}>
			Focus
		</button>
	)
	const notDrawn = selected && !drawn.has(selected) && <span className="wp-muted wp-small">Not drawn with the current filters.</span>

	return (
		<aside className="wp-stack-sm" data-testid="graph-panel">
			<div className="wp-card wp-stack-sm wp-small">
				<input
					className="wp-input"
					aria-label="Find a node"
					placeholder="Find a lesson, tag, project, ticket or source"
					value={find}
					onChange={(e) => setFind(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && found[0]) pick(found[0].id)
					}}
				/>
				{found.map((n) => (
					<NodeRow key={n.id} node={n} onSelect={pick} />
				))}
				{find.trim() && !found.length && <span className="wp-muted">Nothing by that name.</span>}
			</div>

			{entry ? (
				<>
					<EntryCard
						key={entry.id}
						e={entry}
						startOpen
						onChanged={onChanged}
						onTicket={(k) => onSelect(`ticket:${k.toUpperCase()}`)}
						onProject={(p) => onSelect(`project:${p.toLowerCase()}`)}
					/>
					<div className="wp-card wp-stack-sm wp-small">
						{notDrawn}
						<span className="wp-row-wrap">
							{focusButton}
							<a className="wp-link" href={brainHash({ entry: entry.id })}>
								Open in Brain
							</a>
						</span>
						<Connections graph={base} id={entry.id} title={(k) => KIND_LABEL[k]} onSelect={onSelect} />
					</div>
				</>
			) : hub ? (
				<div className="wp-card wp-stack-sm wp-small">
					<span className="wp-eyebrow wp-row" style={{ gap: 6 }}>
						<NodeMark type={hub.type} /> {TYPE_LABEL[hub.type]}
					</span>
					<h2 className="wp-graph-title">{nameOf(hub)}</h2>
					<span className="wp-muted">{plural(lessons.length, 'lesson')}</span>
					{notDrawn}
					{hub.type === 'source' && <SourceChip source={{ type: hub.sourceType as SourceType, url: hub.url, title: hub.label }} />}
					<span className="wp-row-wrap">
						{focusButton}
						{brainLink(hub) && (
							<a className="wp-link" href={brainLink(hub)}>
								Open in Brain
							</a>
						)}
						{library && (
							<a className="wp-link" href={`#/library/${encodeURIComponent(`bridge/library/${libraryKey(library)}`)}`}>
								Open in Library
							</a>
						)}
					</span>
					<Connections key={hub.id} graph={base} id={hub.id} title={() => 'Lessons'} onSelect={onSelect} />
				</div>
			) : (
				<div className="wp-card wp-muted wp-small">Choose a node to see what it is and what touches it. Drag to move, scroll to zoom.</div>
			)}
		</aside>
	)
}
