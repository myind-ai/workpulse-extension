// The sidebar's search: sections first, then everything you have written.
//
// Typing "backup" takes you to Settings, filtered to the backup section — that
// is what a sidebar search is for. But "where did I write that down" is the
// most common question anyone asks their own notes, and it used to have no
// answer: the entries, the ticket notes, the learnings and the links each had
// their own box, which is four boxes and three wrong guesses. So the same field
// looks in all of them, below the sections, once you have typed enough to mean
// something.

import { useEffect, useRef, useState } from 'react'

import { KIND_LABEL, type Hit } from '@/core/find'
import { findSections, type Section } from '@/core/sections'
import { call } from '@/lib/rpc'
import { openPalette } from '@/ui/palette-open'

export function Search() {
	const [query, setQuery] = useState('')
	const [at, setAt] = useState(0)
	const box = useRef<HTMLDivElement>(null)

	// A static list, in memory, matched on the keystroke. Nothing to wait for.
	const hits = findSections(query)
	const [found, setFound] = useState<Hit[]>([])

	useEffect(() => setAt(0), [query])

	// The content search does touch storage, so it waits for a word rather than
	// a letter — and the result is thrown away if you keep typing.
	useEffect(() => {
		const q = query.trim()
		if (q.length < 2) return setFound([])
		let live = true
		void call('findAll', q).then((r) => live && setFound(r.hits.slice(0, 12)))
		return () => {
			live = false
		}
	}, [query])

	// `/` from anywhere on the page puts the caret here, as it does everywhere else.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const el = e.target as HTMLElement | null
			if (e.key !== '/' || el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return
			e.preventDefault()
			box.current?.querySelector('input')?.focus()
		}
		document.addEventListener('keydown', onKey)
		return () => document.removeEventListener('keydown', onKey)
	}, [])

	const go = (hit: Section) => {
		location.hash = hit.hash
		setQuery('')
		;(document.activeElement as HTMLElement | null)?.blur()
	}

	const open = (hit: Hit) => {
		if (hit.hash) location.hash = hit.hash
		else if (hit.url) window.open(hit.url, '_blank', 'noreferrer')
		setQuery('')
		;(document.activeElement as HTMLElement | null)?.blur()
	}

	let last: string | null = null

	return (
		<div className="wp-search" ref={box}>
			{/* A shortcut nobody can find is a feature nobody has. The box is
			    reachable by clicking, always, whatever Chrome did with the key. */}
			<button
				className="wp-action wp-muted wp-small"
				style={{ width: '100%', justifyContent: 'space-between', marginBottom: 6 }}
				title="Log, note, find anything — on any page"
				onClick={openPalette}
			>
				<span>Quick actions</span>
				<span className="wp-kbd">⌘K</span>
			</button>
			<input
				className="wp-input wp-sm"
				placeholder="Go to, or find anything…  /"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') return setQuery('')
					if (!hits.length) return
					if (e.key === 'ArrowDown') {
						e.preventDefault()
						setAt((at + 1) % hits.length)
					}
					if (e.key === 'ArrowUp') {
						e.preventDefault()
						setAt((at - 1 + hits.length) % hits.length)
					}
					if (e.key === 'Enter') go(hits[at])
				}}
				aria-label="Go to a section, or search everything you have written"
			/>

			{!!query.trim() && (
				<div className="wp-search-out">
					{!hits.length && !found.length ? (
						<div className="wp-muted wp-small" style={{ padding: '6px 8px' }}>
							Nothing matches “{query.trim()}” — not a section, and nothing you have written.
						</div>
					) : (
						hits.map((hit, i) => {
							const head = hit.page !== last && (last = hit.page)
							return (
								<div key={`${hit.hash}-${hit.title}`}>
									{head && <div className="wp-search-group">{hit.page}</div>}
									<button className={i === at ? 'wp-search-hit wp-search-on' : 'wp-search-hit'} onMouseEnter={() => setAt(i)} onClick={() => go(hit)}>
										<span style={{ minWidth: 0 }}>
											<span className="wp-search-title">{hit.title}</span>
											<span className="wp-muted wp-small" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
												{hit.detail}
											</span>
										</span>
									</button>
								</div>
							)
						})
					)}

					{/* Everything you have written, under the places you can go. */}
					{!!found.length && (
						<>
							<div className="wp-search-group">What you wrote</div>
							{found.map((hit) => (
								<button key={`${hit.kind}-${hit.at}-${hit.text.slice(0, 12)}`} className="wp-search-hit" onClick={() => open(hit)}>
									<span style={{ minWidth: 0 }}>
										<span className="wp-search-title">{hit.text}</span>
										<span className="wp-muted wp-small" style={{ display: 'block' }}>
											{KIND_LABEL[hit.kind]} · {hit.where}
											{hit.date ? ` · ${hit.date}` : ''}
										</span>
									</span>
								</button>
							))}
						</>
					)}
				</div>
			)}
		</div>
	)
}
