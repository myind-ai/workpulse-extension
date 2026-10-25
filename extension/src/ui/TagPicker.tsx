// Tags you have used, as chips. Clicking one writes `#tag` into the note, so a
// chip and a typed hashtag are the same thing and there is only one place the
// tags live: the note itself.

import { useState } from 'react'

import { tagsOf, toggleTag, type TagCount } from '@/core/learn'

export function TagPicker({ text, onChange, known }: { text: string; onChange: (text: string) => void; known: TagCount[] }) {
	const [adding, setAdding] = useState('')
	const on = tagsOf(text)
	// The ones you use most, plus any already on this note, so nothing vanishes.
	const offer = [...new Set([...on, ...known.slice(0, 14).map((t) => t.tag)])]

	const add = () => {
		const next = toggleTag(text, adding)
		if (next !== text) onChange(next)
		setAdding('')
	}

	return (
		<div className="wp-row-wrap wp-small">
			{offer.map((tag) => (
				<button
					key={tag}
					type="button"
					className={on.includes(tag) ? 'wp-chip wp-chip-accent' : 'wp-chip'}
					aria-pressed={on.includes(tag)}
					onClick={() => onChange(toggleTag(text, tag))}
				>
					#{tag}
					{!on.includes(tag) && known.find((k) => k.tag === tag)?.count ? <span className="wp-muted"> {known.find((k) => k.tag === tag)!.count}</span> : null}
				</button>
			))}
			<input
				className="wp-input wp-sm"
				style={{ width: 120 }}
				placeholder="+ new tag"
				value={adding}
				onChange={(e) => setAdding(e.target.value.replace(/[^\w-]/g, ''))}
				onBlur={add}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault()
						add()
					}
				}}
			/>
		</div>
	)
}
