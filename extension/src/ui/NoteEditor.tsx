// A note editor that converts as you type. The block you are in shows its
// markdown; every other block is rendered. Type `## ` and the heading appears
// when you leave the line, Enter carries a list on, and the toolbar works on
// the selection — the stored note is still plain markdown.

import { useEffect, useRef, useState } from 'react'

import { blocks, enterAt, join, togglePrefix, wrap } from '@/core/editor'
import { Markdown } from '@/ui/Markdown'

const MARKS: [string, string, string][] = [
	['B', '**', 'Bold  ⌘B'],
	['I', '*', 'Italic  ⌘I'],
	['</>', '`', 'Code'],
	['S', '~~', 'Strikethrough'],
]

const PREFIXES: [string, string, string][] = [
	['H', '## ', 'Heading'],
	['•', '- ', 'Bullet list'],
	['1.', '1. ', 'Numbered list'],
	['☑', '- [ ] ', 'Checkbox'],
	['❝', '> ', 'Quote'],
]

export function NoteEditor({ value, onChange, autoFocus }: { value: string; onChange: (text: string) => void; autoFocus?: boolean }) {
	const [active, setActive] = useState(autoFocus ? 0 : -1)
	const [caret, setCaret] = useState<number | null>(null)
	const box = useRef<HTMLTextAreaElement>(null)
	const list = blocks(value)

	useEffect(() => {
		const el = box.current
		if (!el) return
		el.focus()
		if (caret != null) el.setSelectionRange(caret, caret)
		el.style.height = 'auto'
		el.style.height = `${el.scrollHeight}px`
	}, [active, caret])

	const put = (next: string[], goTo = active, at: number | null = null) => {
		onChange(join(next))
		setActive(Math.max(0, Math.min(goTo, next.length - 1)))
		setCaret(at)
	}

	const replace = (i: number, text: string) => list.map((b, j) => (j === i ? text : b))

	/** Toolbar and ⌘-keys act on the selection inside the block you are in. */
	const applyMark = (mark: string) => {
		const el = box.current
		if (!el || active < 0) return
		const r = wrap(list[active], el.selectionStart, el.selectionEnd, mark)
		onChange(join(replace(active, r.text)))
		requestAnimationFrame(() => el.setSelectionRange(r.start, r.end))
	}

	const applyPrefix = (prefix: string) => {
		if (active < 0) return
		const line = togglePrefix(list[active], prefix)
		put(replace(active, line), active, line.length)
	}

	const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		const el = e.currentTarget
		const line = list[active]
		const mod = e.metaKey || e.ctrlKey

		if (mod && e.key === 'Enter') return // let the form save
		if (mod && (e.key === 'b' || e.key === 'i')) {
			e.preventDefault()
			return applyMark(e.key === 'b' ? '**' : '*')
		}
		if (e.key === 'Enter' && !e.shiftKey && !line.startsWith('```')) {
			e.preventDefault()
			const { line: kept, next } = enterAt(line, el.selectionStart)
			const after = [...list.slice(0, active), kept, next, ...list.slice(active + 1)]
			return put(after, active + 1, next.length)
		}
		// Backspace at the very start folds this block into the one above it.
		if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0 && active > 0) {
			e.preventDefault()
			const prev = list[active - 1]
			const merged = [...list.slice(0, active - 1), prev + line, ...list.slice(active + 1)]
			return put(merged, active - 1, prev.length)
		}
		if (e.key === 'ArrowUp' && el.selectionStart === 0 && active > 0) {
			e.preventDefault()
			return put(list, active - 1, list[active - 1].length)
		}
		if (e.key === 'ArrowDown' && el.selectionStart === line.length && active < list.length - 1) {
			e.preventDefault()
			return put(list, active + 1, 0)
		}
		if (e.key === 'Tab') {
			e.preventDefault()
			const line2 = e.shiftKey ? list[active].replace(/^ {1,2}/, '') : `  ${list[active]}`
			return put(replace(active, line2), active, null)
		}
	}

	return (
		<div className="wp-editor">
			<div className="wp-editor-bar" role="toolbar" aria-label="Formatting">
				{MARKS.map(([label, mark, title]) => (
					<button key={mark} type="button" className="wp-editor-btn" title={title} disabled={active < 0} onMouseDown={(e) => e.preventDefault()} onClick={() => applyMark(mark)}>
						{label}
					</button>
				))}
				<span className="wp-editor-sep" />
				{PREFIXES.map(([label, prefix, title]) => (
					<button key={prefix} type="button" className="wp-editor-btn" title={title} disabled={active < 0} onMouseDown={(e) => e.preventDefault()} onClick={() => applyPrefix(prefix)}>
						{label}
					</button>
				))}
			</div>

			<div className="wp-editor-body">
				{list.map((b, i) =>
					i === active ? (
						<textarea
							key={i}
							ref={box}
							className="wp-editor-line"
							rows={1}
							value={b}
							placeholder={list.length === 1 ? 'Type. Markdown works: ## heading, - bullet, - [ ] box, > quote, **bold**' : ''}
							onChange={(e) => {
								onChange(join(replace(i, e.target.value)))
								setCaret(null)
								e.target.style.height = 'auto'
								e.target.style.height = `${e.target.scrollHeight}px`
							}}
							onKeyDown={keys}
							onBlur={() => setActive(-1)}
						/>
					) : (
						// Click a rendered block and it goes back to being markdown.
						<div
							key={i}
							className={b.trim() ? 'wp-editor-block' : 'wp-editor-block wp-editor-blank'}
							// A link opens and a box ticks; anywhere else puts you in the line.
							onClick={(e) => {
								if ((e.target as HTMLElement).closest('a, input')) return
								put(list, i, b.length)
							}}
							role="button"
							tabIndex={-1}
						>
							{b.trim() ? <Markdown text={b} onToggleBox={(n) => onChange(join(replace(i, tick(b, n))))} /> : <br />}
						</div>
					),
				)}
			</div>
		</div>
	)
}

/** Ticks the nth box within one block. */
function tick(block: string, n: number): string {
	let seen = -1
	return block.replace(/^(\s*[-*+]\s*)\[([ xX])\]/gm, (whole, lead: string, mark: string) => (++seen === n ? `${lead}[${mark.toLowerCase() === 'x' ? ' ' : 'x'}]` : whole))
}
