// The drawing: one SVG, moved and redrawn through refs. Positions, pan, zoom and selection are written straight to the
// DOM, so nothing here re-renders per frame, and the panel's state never reaches it (`memo`).
//
// Checked before writing: `Heatmap`, `Timeline` and `DayBar` draw without SVG, so this is the first SVG chart. Colours
// are the `--wp-node-*` tokens in dashboard.css (one validated palette per theme); shape carries the same meaning.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'

import type { BrainGraph, GraphNodeType } from '@/core/brain-index'
import { createLayout, radialLayout, SETTLED_START, type Positions } from '@/core/graph-layout'

const ZOOM_MIN = 0.08
const ZOOM_MAX = 6
const CLICK_PX = 4
const FIT_PAD = 70
/** From here one tick a frame: a tick on 1,000 nodes is longer than the frame budget by itself. */
const LARGE = 600
const FRAME_BUDGET_MS = 12
const LARGE_WRITE_EVERY = 4
const LABEL_MAX = 30
/** Lessons get their labels from here up (the CSS's `is-zoomed`); below it, a hub label that collides gives way. */
const ZOOM_LABELS = 1.2
const LABEL_FONT_PX = 11
/** Enough of the nodes the same, by Jaccard, for it to be the same picture: keep the place and the camera. */
const SAME_PICTURE = 0.7

// Where each picture came to rest. The same picture comes back exactly (Back from a focus, a filter pressed and
// pressed again); a new one starts from where its nodes last were.
const SETTLED_KEEP = 8
const settled = new Map<string, Positions>()
let lastOverview: Positions = {}
/** The last arrangement ran to its end. One cut short has not settled, so the next must not start cool. */
let lastCame = false

export const radiusOf = (degree: number) => 5.5 + Math.min(9, 1.2 * Math.sqrt(degree))

/** One shape per type, centred on 0,0. */
export function markPath(type: GraphNodeType, r: number): string {
	const at = (points: [number, number][]) => `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`
	const star = () =>
		at(Array.from({ length: 10 }, (_, i) => {
			const a = -Math.PI / 2 + (i / 10) * 2 * Math.PI
			const reach = r * (i % 2 ? 0.6 : 1.5)
			return [reach * Math.cos(a), reach * Math.sin(a)] as [number, number]
		}))
	if (type === 'lesson') return `M${-r} 0A${r} ${r} 0 1 0 ${r} 0A${r} ${r} 0 1 0 ${-r} 0Z`
	if (type === 'project') return at([[-r * 0.9, -r * 0.9], [r * 0.9, -r * 0.9], [r * 0.9, r * 0.9], [-r * 0.9, r * 0.9]])
	if (type === 'ticket') return at([[0, -r * 1.2], [r * 1.2, 0], [0, r * 1.2], [-r * 1.2, 0]])
	if (type === 'tag') return at([[0, -r * 1.15], [r * 1.1, r * 0.85], [-r * 1.1, r * 0.85]])
	return star() // source
}

/** The shape of a type on its own, for the legend and the lists. */
export function NodeMark({ type, size = 12 }: { type: GraphNodeType; size?: number }) {
	return (
		<svg className="wp-g-swatch" data-type={type} width={size} height={size} viewBox="-8 -8 16 16" aria-hidden>
			<path d={markPath(type, 6)} />
		</svg>
	)
}

let measure: CanvasRenderingContext2D | null | undefined
const short = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s)

interface Props {
	graph: BrainGraph
	/** The same picture has the same signature. */
	sig: string
	focus?: string
	distance?: Record<string, number>
	selected?: string
	onSelect: (id: string | undefined) => void
	onBusy: (busy: boolean) => void
}

export const GraphCanvas = memo(function GraphCanvas({ graph, sig, focus, distance, selected, onSelect, onBusy }: Props) {
	const svg = useRef<SVGSVGElement>(null)
	const world = useRef<SVGGElement>(null)
	const camera = useRef({ k: 1, x: 0, y: 0 })
	const places = useRef<Positions>({})
	const moved = useRef(false)
	const lastDrawn = useRef<{ ids: Set<string>; focus?: string }>({ ids: new Set() })
	const declutterK = useRef(0)

	// Elements once per graph: a selection or a zoom never touches them, so React has nothing to do.
	const drawing = useMemo(() => {
		const order = [...graph.nodes].sort((a, b) => Number(a.type !== 'lesson') - Number(b.type !== 'lesson'))
		return (
			<>
				{graph.edges.map((e) => (
					<line key={`${e.source}|${e.target}|${e.kind}`} data-kind={e.kind} data-a={e.source} data-b={e.target} className="wp-g-edge" />
				))}
				{order.map((n) => {
					const r = radiusOf(n.degree)
					return (
						<g key={n.id} data-node={n.id} data-type={n.type} className={`wp-g-node${n.type === 'lesson' ? '' : ' is-hub'}${n.archived ? ' is-archived' : ''}`} style={{ '--r': r } as React.CSSProperties}>
							<title>{n.label}</title>
							<circle className="wp-g-hit" r={r + 6} />
							{n.kind === 'mistake' && <circle className="wp-g-ring" r={r + 3} />}
							<path className="wp-g-mark" d={markPath(n.type, r)} />
							<text className="wp-g-label" y={12}>
								{short(n.type === 'tag' ? `#${n.label}` : n.label)}
							</text>
						</g>
					)
				})}
			</>
		)
	}, [graph])

	/**
	 * Below `ZOOM_LABELS`, a hub whose label would touch a better-connected hub's gives way, until you zoom in. Selected
	 * and adjacent labels are CSS's to keep, and every node keeps its `<title>`.
	 */
	const declutter = useCallback(() => {
		const root = svg.current
		if (!root) return
		const { k, x, y } = camera.current
		declutterK.current = k
		const hubs = [...root.querySelectorAll<SVGGElement>('.is-hub')]
		if (k >= ZOOM_LABELS) {
			hubs.forEach((el) => el.classList.remove('is-crowded'))
			return
		}
		const ns = Math.max(1, 0.8 / k)
		const ctx = (measure ??= document.createElement('canvas').getContext('2d'))
		if (ctx) ctx.font = `500 ${LABEL_FONT_PX}px ${getComputedStyle(root).fontFamily}`
		const byId = new Map(graph.nodes.map((n) => [n.id, n]))
		const placed: { l: number; r: number; t: number; b: number }[] = []
		const order = hubs
			.map((el) => ({ el, node: byId.get(el.dataset.node!) }))
			.filter((h) => h.node && places.current[h.node.id])
			.sort((a, b) => b.node!.degree - a.node!.degree || a.node!.id.localeCompare(b.node!.id))
		for (const { el, node } of order) {
			const p = places.current[node!.id]!
			const [sx, sy] = [k * p.x + x, k * p.y + y]
			const out = k * radiusOf(node!.degree) * ns
			const text = el.querySelector('.wp-g-label')?.textContent ?? ''
			const w = (ctx?.measureText(text).width ?? text.length * 6.5) + 4
			const side = el.dataset.side
			const l = side === 'right' ? sx + out + 5 : side === 'left' ? sx - out - 5 - w : sx - w / 2
			const base = side ? sy + 4 : sy + out + 12
			const box = { l, r: l + w, t: base - 12, b: base + 4 }
			const hit = placed.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t)
			el.classList.toggle('is-crowded', hit)
			if (!hit) placed.push(box)
		}
	}, [graph])

	const show = useCallback(() => {
		const { k, x, y } = camera.current
		world.current?.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${k.toFixed(3)})`)
		const root = svg.current
		if (!root) return
		// Words stay one size on screen, and a mark never shrinks below something you can see and hit.
		root.style.setProperty('--ts', String(1 / k))
		root.style.setProperty('--ns', String(Math.max(1, 0.8 / k)))
		root.classList.toggle('is-zoomed', k > ZOOM_LABELS)
		// Panning moves every label together; only a change of size can make them collide.
		if (k !== declutterK.current) declutter()
	}, [declutter])

	const fit = useCallback(() => {
		const root = svg.current
		const all = Object.values(places.current)
		if (!root || !all.length) return
		const xs = all.map((p) => p.x)
		const ys = all.map((p) => p.y)
		const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
		const { clientWidth: w, clientHeight: h } = root
		const k = Math.max(ZOOM_MIN, Math.min(1, w / (x1 - x0 + FIT_PAD * 2), h / (y1 - y0 + FIT_PAD * 2)))
		camera.current = { k, x: w / 2 - (k * (x0 + x1)) / 2, y: h / 2 - (k * (y0 + y1)) / 2 }
		show()
	}, [show])

	const zoomAt = useCallback(
		(cx: number, cy: number, by: number) => {
			const { k, x, y } = camera.current
			const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, k * by))
			camera.current = { k: next, x: cx - ((cx - x) * next) / k, y: cy - ((cy - y) * next) / k }
			moved.current = true
			show()
		},
		[show],
	)
	const zoomMiddle = (by: number) => svg.current && zoomAt(svg.current.clientWidth / 2, svg.current.clientHeight / 2, by)

	// Arrange, then write. Only ever setAttribute from here on.
	useLayoutEffect(() => {
		const root = svg.current
		if (!root) return
		const nodes = new Map<string, Element>()
		root.querySelectorAll('[data-node]').forEach((el) => nodes.set((el as SVGElement).dataset.node!, el))
		const lines = [...root.querySelectorAll('line')].map((el) => ({ el, a: el.dataset.a!, b: el.dataset.b! }))
		const write = (pos: Positions, radial = false) => {
			places.current = pos
			for (const [id, el] of nodes) {
				const p = pos[id]
				if (!p) continue
				el.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`)
				if (radial && id !== focus) el.setAttribute('data-side', p.x < 0 ? 'left' : 'right')
				else el.removeAttribute('data-side')
			}
			for (const { el, a, b } of lines) {
				const [p, q] = [pos[a], pos[b]]
				if (!p || !q) continue
				el.setAttribute('x1', p.x.toFixed(1))
				el.setAttribute('y1', p.y.toFixed(1))
				el.setAttribute('x2', q.x.toFixed(1))
				el.setAttribute('y2', q.y.toFixed(1))
			}
		}
		// Most of the same nodes: an edit, an archive, a new lesson, one legend press. The reader keeps their place.
		const ids = new Set(graph.nodes.map((n) => n.id))
		const before = lastDrawn.current
		const common = [...ids].filter((id) => before.ids.has(id)).length
		const samePicture = before.focus === focus && common > 0 && common / (before.ids.size + ids.size - common) >= SAME_PICTURE
		lastDrawn.current = { ids, focus }
		if (!samePicture) moved.current = false
		const refit = () => {
			if (!moved.current) fit()
			declutter()
		}
		if (focus) {
			write(radialLayout(graph, focus, distance ?? {}), true)
			refit()
			onBusy(false)
			return
		}
		const known = settled.get(sig)
		if (known) {
			write(known)
			lastOverview = known
			lastCame = true
			refit()
			onBusy(false)
			return
		}
		const seeded = graph.nodes.filter((n) => lastOverview[n.id]).length
		const cool = lastCame && graph.nodes.length > 0 && seeded / graph.nodes.length >= SAME_PICTURE
		const layout = createLayout(graph, lastOverview, cool ? { startAt: SETTLED_START } : {})
		lastCame = false
		write(layout.positions())
		refit()
		onBusy(true)
		let frame = 0
		let frames = 0
		const large = graph.nodes.length >= LARGE
		const tick = () => {
			const start = performance.now()
			let done = layout.step(1)
			while (!large && !done && performance.now() - start < FRAME_BUDGET_MS) done = layout.step(1)
			// A large picture is written every few frames: restyling 1,000 nodes each frame cost more than arranging them.
			if (done || !large || ++frames % LARGE_WRITE_EVERY === 0) {
				write(layout.positions())
				if (!moved.current) fit()
			}
			if (!done) {
				frame = requestAnimationFrame(tick)
				return
			}
			declutter()
			lastCame = true
			settled.set(sig, places.current)
			if (settled.size > SETTLED_KEEP) settled.delete(settled.keys().next().value!)
			onBusy(false)
		}
		frame = requestAnimationFrame(tick)
		return () => {
			cancelAnimationFrame(frame)
			lastOverview = { ...lastOverview, ...places.current }
		}
	}, [graph, sig, focus, distance, fit, declutter, onBusy])

	// Selection is three classes, set here so no node re-renders.
	useLayoutEffect(() => {
		const root = svg.current
		if (!root) return
		root.querySelectorAll('.is-sel, .is-near, .is-lit').forEach((el) => el.classList.remove('is-sel', 'is-near', 'is-lit'))
		const chosen = selected ? root.querySelector(`[data-node="${CSS.escape(selected)}"]`) : null
		root.classList.toggle('has-sel', !!chosen)
		if (!chosen) return
		chosen.classList.add('is-sel')
		root.querySelectorAll('line').forEach((el) => {
			const other = el.dataset.a === selected ? el.dataset.b : el.dataset.b === selected ? el.dataset.a : undefined
			if (other === undefined) return
			el.classList.add('is-lit')
			root.querySelector(`[data-node="${CSS.escape(other)}"]`)?.classList.add('is-near')
		})
	}, [graph, selected])

	// Wheel needs preventDefault, so not a passive React handler; the size can change under us.
	useEffect(() => {
		const root = svg.current
		if (!root) return
		const onWheel = (e: WheelEvent) => {
			e.preventDefault()
			const box = root.getBoundingClientRect()
			zoomAt(e.clientX - box.left, e.clientY - box.top, Math.exp(-e.deltaY * 0.0015))
		}
		root.addEventListener('wheel', onWheel, { passive: false })
		const size = new ResizeObserver(() => {
			if (!moved.current) fit()
		})
		size.observe(root)
		return () => {
			root.removeEventListener('wheel', onWheel)
			size.disconnect()
		}
	}, [fit, zoomAt])

	const press = useRef<{ x: number; y: number; cx: number; cy: number; node?: string; dragging: boolean } | null>(null)
	return (
		<div className="wp-graph-frame">
			<svg
				ref={svg}
				className="wp-graph-svg"
				role="img"
				aria-label={`Graph of ${graph.nodes.length} nodes and ${graph.edges.length} connections. Every node can be reached with the find box beside it.`}
				onPointerDown={(e) => {
					if (e.button !== 0) return
					const { x, y } = camera.current
					press.current = { x, y, cx: e.clientX, cy: e.clientY, node: ((e.target as Element).closest('[data-node]') as SVGElement | null)?.dataset.node, dragging: false }
					e.currentTarget.setPointerCapture(e.pointerId)
				}}
				onPointerMove={(e) => {
					const p = press.current
					if (!p) return
					const [dx, dy] = [e.clientX - p.cx, e.clientY - p.cy]
					if (!p.dragging && Math.hypot(dx, dy) < CLICK_PX) return
					p.dragging = true
					moved.current = true
					camera.current = { ...camera.current, x: p.x + dx, y: p.y + dy }
					show()
				}}
				onPointerUp={() => {
					const p = press.current
					press.current = null
					if (p && !p.dragging) onSelect(p.node)
				}}
				onPointerCancel={() => (press.current = null)}
			>
				<g ref={world} data-testid="graph-world">
					{drawing}
				</g>
			</svg>
			<div className="wp-graph-tools" role="group" aria-label="Zoom">
				<button className="wp-btn wp-btn-sm" aria-label="Zoom in" title="Zoom in" onClick={() => zoomMiddle(1.3)}>
					+
				</button>
				<button className="wp-btn wp-btn-sm" aria-label="Zoom out" title="Zoom out" onClick={() => zoomMiddle(1 / 1.3)}>
					−
				</button>
				<button
					className="wp-btn wp-btn-sm"
					onClick={() => {
						moved.current = false
						fit()
					}}
				>
					Fit
				</button>
			</div>
		</div>
	)
})
