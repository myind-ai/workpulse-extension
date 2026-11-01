// The Brain as a picture: lessons and the tickets, projects, tags and sources they share. Built in the page from the
// entries already loaded; no new background command. One look at the repository on open: the 60-second look belongs
// to the Brain page.
//
// Checked before writing: the `.wp-brain` grid, `EntryCard`, `SourceChip`/`SourceFilter`, `BRAIN_FILTER_HELP` +
// `describeFilters`, `Art`, `Busy`, `useLive`, `useAction`, `.wp-seg` and `.wp-banner` are reused. `GraphCanvas`
// (no SVG chart existed) and `GraphPanel` are new, and `graph-model.ts` holds the arithmetic.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { GraphEdgeKind, GraphNodeType } from '@/core/brain-index'
import { BRAIN_FILTER_HELP, describeFilters, parseBrainQuery } from '@/core/brain-query'
import { call } from '@/lib/rpc'
import { Art } from '@/ui/Art'
import { Busy } from '@/ui/Busy'
import { useAction, useLive } from '@/ui/hooks'
import { SourceFilter, type SourceChoice } from '@/ui/SourceChip'

import { GraphCanvas, NodeMark } from './GraphCanvas'
import { GraphPanel } from './GraphPanel'
import { EDGE_KINDS, graphModel, MAX_DRAWN, NODE_TYPES } from './graph-model'

const DEBOUNCE_MS = 200
const TYPE_LABEL: Record<GraphNodeType, string> = { lesson: 'Lessons', source: 'Sources', project: 'Projects', ticket: 'Tickets', tag: 'Tags' }
const EDGE_LABEL: Record<GraphEdgeKind, string> = { source: 'Source', project: 'Project', ticket: 'Ticket', related: 'Related', tag: 'Tag' }

const decode = (v?: string) => {
	if (!v) return undefined
	try {
		return decodeURIComponent(v)
	} catch {
		return v
	}
}
const toggled = <T,>(set: Set<T>, value: T) => {
	const next = new Set(set)
	if (!next.delete(value)) next.add(value)
	return next
}
const soft = (on: boolean) => (on ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm')

export function GraphView({ arg }: { arg?: string }) {
	const { data, reload } = useLive(() => call('bridge'))
	const sync = useAction()
	const focus = decode(arg)
	const [selected, setSelected] = useState<string | undefined>()
	const [input, setInput] = useState('')
	const [query, setQuery] = useState('')
	const [source, setSource] = useState<SourceChoice>('all')
	const [types, setTypes] = useState(() => new Set(NODE_TYPES))
	const [kinds, setKinds] = useState(() => new Set(EDGE_KINDS))
	const [archived, setArchived] = useState(false)
	const [loneTags, setLoneTags] = useState(false)
	const [depth, setDepth] = useState<1 | 2>(1)
	const [busy, setBusy] = useState(false)
	const [polled, setPolled] = useState(false)

	// One look at the repository when the page opens.
	useEffect(() => {
		// A failed look is stored, not broadcast: read it back, or the page would say "no lessons".
		void call('pollBridge')
			.catch(() => undefined)
			.then(reload)
			.then(() => setPolled(true))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	useEffect(() => {
		const t = setTimeout(() => setQuery(input), DEBOUNCE_MS)
		return () => clearTimeout(t)
	}, [input])

	// A new focus starts with itself selected; the panel follows it.
	useEffect(() => setSelected(undefined), [focus])

	const entries = data?.entries
	const archive = data?.archived
	const model = useMemo(() => (entries && archive ? graphModel(entries, archive, { query, source, types, kinds, archived, loneTags, focus, depth }) : undefined), [entries, archive, query, source, types, kinds, archived, loneTags, focus, depth])

	// `useLive` hands over new objects on every broadcast. The same picture must stay the same object, or it rearranges.
	const last = useRef(model)
	if (model && last.current?.sig !== model.sig) last.current = model
	const view = last.current?.view
	const distance = last.current?.distance
	const drawn = useMemo(() => new Set(view?.nodes.map((n) => n.id)), [view])

	const select = useCallback((id: string | undefined) => setSelected(id), [])
	const shownSel = selected ?? focus
	const all = useMemo(() => [...(entries ?? []), ...(archive ?? [])], [entries, archive])
	const parsed = useMemo(() => parseBrainQuery(query), [query])
	const narrowed = !!input || source !== 'all' || types.size < NODE_TYPES.length || kinds.size < EDGE_KINDS.length || loneTags || archived
	const clear = () => {
		setInput('')
		setQuery('')
		setSource('all')
		setTypes(new Set(NODE_TYPES))
		setKinds(new Set(EDGE_KINDS))
		setLoneTags(false)
		setArchived(false)
	}
	const showAll = () => (location.hash = '#/graph')
	const nothing = !!model && !model.view.nodes.length
	/** Every lesson is archived, and nothing was narrowed: there is nothing to clear. */
	const allArchived = nothing && !narrowed && !entries?.length && !!archive?.length
	const failed = sync.error || data?.error

	const head = (
		<header className="wp-page-head">
			<div>
				<span className="wp-eyebrow">Every lesson, and what joins them</span>
				<h1 className="wp-h1">Graph</h1>
				<p className="wp-muted wp-small" style={{ maxWidth: 600, margin: 0 }}>
					The lessons in your <a href="#/brain">Brain</a>, joined by the tickets, projects, tags and sources they share. Choose one to read it, change it, or focus on what is near it.
				</p>
			</div>
			<div className="wp-row-wrap">
				<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={sync.busy || !data?.ready} onClick={() => sync.run(async () => void (await call('pollBridge', true), await reload()))}>
					<Busy busy={sync.busy} doing="Syncing…">
						Sync now
					</Busy>
				</button>
			</div>
		</header>
	)

	if (data && !data.on) {
		return (
			<div className="wp-card wp-muted">
				The bridge is switched off in this build. Remove <code>WXT_FEATURE_BRIDGE_SYNC=false</code> from <code>.env</code> and rebuild to turn it on.
			</div>
		)
	}
	if (data && !data.ready) {
		return (
			<div className="wp-stack wp-graph-page">
				{head}
				<div className="wp-card wp-stack-sm">
					<Art name="empty-journal" size={96} />
					<strong>Connect a repository first.</strong>
					<span className="wp-muted wp-small">
						The graph is drawn from the Brain, in the same private repository your backup uses. Set it up in <a href="#/settings/backup">Settings → Backup</a> (a fine-grained token with Contents: Read and write on that one repository).
					</span>
				</div>
			</div>
		)
	}
	if (!data || (!all.length && !polled)) {
		return (
			<div className="wp-stack wp-graph-page">
				{head}
				{failed && <div className="wp-banner wp-small">{failed}</div>}
				<div className="wp-card">
					<Art name="reading" size={48} />
					<span className="wp-muted wp-small">Looking in your repository…</span>
				</div>
			</div>
		)
	}
	if (!all.length) {
		return (
			<div className="wp-stack wp-graph-page">
				{head}
				{failed && <div className="wp-banner wp-small">{failed}</div>}
				{failed ? (
					<div className="wp-card wp-stack-sm">
						<Art name="empty-notes" size={96} />
						<strong data-testid="graph-failed">Could not read your repository.</strong>
						<span className="wp-muted wp-small">So this page cannot say what the Brain holds. The reason is above; once it is sorted, press Sync now.</span>
					</div>
				) : (
					<div className="wp-card wp-stack-sm">
						<Art name="empty-notes" size={96} />
						<strong data-testid="graph-empty">No lessons yet, so nothing to draw.</strong>
						<span className="wp-muted wp-small">
							At the end of a ticket, the <code>workpulse-brain</code> skill writes what was asked, what was done and what was learned; you can also press <strong>+ Add</strong> on the <a href="#/brain">Brain</a> page. Each lesson appears here, joined to its ticket, project, tags and source.
						</span>
					</div>
				)}
			</div>
		)
	}

	return (
		<div className="wp-stack wp-graph-page">
			{head}
			{failed && <div className="wp-banner wp-small">{failed}</div>}

			<div className="wp-row-wrap">
				<span className="wp-row" role="group" aria-label="Node types">
					{NODE_TYPES.filter((t) => (model?.byType[t] ?? 0) > 0 || !types.has(t)).map((t) => (
						<button key={t} className={soft(types.has(t))} aria-pressed={types.has(t)} onClick={() => setTypes(toggled(types, t))}>
							<NodeMark type={t} /> {TYPE_LABEL[t]} <span className="wp-muted">{model?.byType[t] ?? 0}</span>
						</button>
					))}
				</span>
				<button className={loneTags ? 'wp-chip wp-chip-accent' : 'wp-chip'} style={{ cursor: 'pointer' }} aria-pressed={loneTags} onClick={() => setLoneTags(!loneTags)} title="Tags on one lesson only: they connect nothing, so they stay off unless asked for">
					Tags used once {model?.loneTags ?? 0}
				</button>
				{(!!archive?.length || archived) && (
					<button className={archived ? 'wp-chip wp-chip-accent' : 'wp-chip'} style={{ cursor: 'pointer' }} aria-pressed={archived} onClick={() => setArchived(!archived)} title="Lessons you archived, drawn hollow beside the rest">
						Archived {archive?.length ?? 0}
					</button>
				)}
			</div>
			<div className="wp-row-wrap">
				<span className="wp-row" role="group" aria-label="Connection kinds">
					{EDGE_KINDS.filter((k) => (model?.byKind[k] ?? 0) > 0 || !kinds.has(k)).map((k) => (
						<button key={k} className={soft(kinds.has(k))} aria-pressed={kinds.has(k)} onClick={() => setKinds(toggled(kinds, k))}>
							<svg className="wp-g-sample" width="16" height="6" aria-hidden>
								<line x1="0" y1="3" x2="16" y2="3" data-kind={k} />
							</svg>{' '}
							{EDGE_LABEL[k]} <span className="wp-muted">{model?.byKind[k] ?? 0}</span>
						</button>
					))}
				</span>
				<SourceFilter value={source} counts={model?.bySource ?? {}} onChange={setSource} />
			</div>
			<div className="wp-row-wrap">
				<input className="wp-input wp-grow" style={{ minWidth: 180 }} placeholder="Search, or filter: ticket:PAY-1 type:debug status:open has:next-action #tag after:7d" title={BRAIN_FILTER_HELP} aria-label="Filter the graph" value={input} onChange={(e) => setInput(e.target.value)} />
				{describeFilters(parsed.filters).map((f) => (
					<span key={f} className="wp-chip wp-chip-accent">
						{f}
					</span>
				))}
				{narrowed && !nothing && (
					<button className="wp-action" onClick={clear}>
						Clear filters
					</button>
				)}
			</div>

			{!!model && model.total > MAX_DRAWN && (
				<div className="wp-banner wp-small">
					Showing {MAX_DRAWN.toLocaleString('en-US')} of {model.total.toLocaleString('en-US')}, the most connected. Filter or focus to see the rest.
				</div>
			)}

			<div className="wp-brain">
				<div className="wp-stack-sm">
					<div className="wp-between wp-small">
						<span className="wp-row-wrap">
							<span className="wp-muted" data-testid="graph-counts">
								{view?.nodes.length ?? 0} nodes · {view?.edges.length ?? 0} connections
							</span>
							{busy && !nothing && (
								<span className="wp-muted wp-row" data-testid="graph-busy">
									<Busy busy doing="Arranging…">
										{null}
									</Busy>
								</span>
							)}
						</span>
						{focus && !model?.gone && (
							<span className="wp-row-wrap">
								<span className="wp-seg" role="group" aria-label="How far from the focus">
									<button aria-pressed={depth === 1} onClick={() => setDepth(1)}>
										1 step
									</button>
									<button aria-pressed={depth === 2} onClick={() => setDepth(2)}>
										2 steps
									</button>
								</span>
								<button className="wp-btn wp-btn-sm" onClick={showAll}>
									Show everything
								</button>
							</span>
						)}
					</div>
					{model?.gone ? (
						<div className="wp-card wp-stack-sm">
							<strong>That is no longer in the Brain</strong>
							<span className="wp-muted wp-small">It may have been deleted, on this device or another.</span>
							<span>
								<button className="wp-btn wp-btn-sm" onClick={showAll}>
									Show everything
								</button>
							</span>
						</div>
					) : allArchived ? (
						<div className="wp-card wp-stack-sm">
							<strong data-testid="graph-all-archived">Every lesson is archived.</strong>
							<span className="wp-muted wp-small">
								Press <strong>Archived {archive?.length}</strong> above to draw them.
							</span>
						</div>
					) : nothing ? (
						<div className="wp-card wp-stack-sm">
							<strong>Nothing matches that</strong>
							<span>
								<button className="wp-btn wp-btn-sm" onClick={clear}>
									Clear filters
								</button>
							</span>
						</div>
					) : (
						view && <GraphCanvas graph={view} sig={last.current!.sig} focus={focus} distance={distance} selected={shownSel} onSelect={select} onBusy={setBusy} />
					)}
				</div>
				<GraphPanel base={model!.base} entries={all} selected={shownSel} focus={focus} drawn={drawn} onSelect={select} onChanged={reload} />
			</div>
		</div>
	)
}
