// Renders core/markdown's blocks as elements. Nothing is ever set as HTML, so a
// note pasted from anywhere is text — the worst a stray <script> can do is read
// as one.

import type { Block, Span } from '@/core/markdown'
import { parse } from '@/core/markdown'

function Spans({ spans }: { spans: Span[] }) {
	return (
		<>
			{spans.map((s, i) => {
				if (s.kind === 'code') return <code key={i}>{s.text}</code>
				if (s.kind === 'bold') return <strong key={i}>{s.text}</strong>
				if (s.kind === 'italic') return <em key={i}>{s.text}</em>
				if (s.kind === 'strike') return <s key={i}>{s.text}</s>
				if (s.kind === 'link')
					return (
						<a key={i} className="wp-link" href={s.href} target="_blank" rel="noreferrer noopener">
							{s.text}
						</a>
					)
				return <span key={i}>{s.text}</span>
			})}
		</>
	)
}

function One({ block, onToggle }: { block: Block; onToggle?: (index: number) => void }) {
	switch (block.kind) {
		case 'heading': {
			const H = (['h3', 'h4', 'h5'] as const)[block.level - 1]
			return <H className="wp-md-h">{<Spans spans={block.spans} />}</H>
		}
		case 'quote':
			return (
				<blockquote className="wp-md-quote">
					<Spans spans={block.spans} />
				</blockquote>
			)
		case 'code':
			return <pre className="wp-md-code">{block.text}</pre>
		case 'rule':
			return <hr className="wp-md-rule" />
		case 'list': {
			const L = block.ordered ? 'ol' : 'ul'
			return (
				<L className="wp-md-list">
					{block.items.map((item, i) => (
						<li key={i} className={item.done ? 'wp-md-done' : undefined} style={item.done != null ? { listStyle: 'none', marginLeft: '-1.1em' } : undefined}>
							{/* A checkbox in a note is a real one: ticking it writes the note back. */}
							{item.done != null && <input type="checkbox" checked={item.done} onChange={() => onToggle?.(i)} disabled={!onToggle} style={{ marginRight: 6 }} />}
							<Spans spans={item.spans} />
						</li>
					))}
				</L>
			)
		}
		default:
			return (
				<p className="wp-md-p">
					<Spans spans={block.spans} />
				</p>
			)
	}
}

/** `onToggleBox` receives the index of the checkbox among all boxes in `text`. */
export function Markdown({ text, onToggleBox }: { text: string; onToggleBox?: (boxIndex: number) => void }) {
	const blocks = parse(text)
	let seen = 0
	return (
		<div className="wp-md">
			{blocks.map((b, i) => {
				const base = seen
				if (b.kind === 'list') seen += b.items.filter((it) => it.done != null).length
				return <One key={i} block={b} onToggle={onToggleBox && b.kind === 'list' ? (idx) => onToggleBox(base + b.items.slice(0, idx).filter((it) => it.done != null).length) : undefined} />
			})}
		</div>
	)
}
