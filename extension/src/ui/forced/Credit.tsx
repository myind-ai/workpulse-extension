// The line at the foot of every reminder card.
//
// It asks for nothing and stops nothing: no button to press before you can get
// on, and nothing that moves. The card interrupted you; the least it can do is
// not also sell to you. What it does instead is say whose work this is, in a
// different sentence each hour, so a line you have read a hundred times does not
// become furniture.
//
// There is no ✕. The one it had set "never" for good and globally, so a single
// click on one card took the line off every card for ever — which is how an
// extension ends up with a footer on some reminders and not others.

import { heartColour, paintSeed, pitch } from '@/core/brand'
import { AUTHOR, AUTHOR_URL, SOURCE_URL, SPONSOR_URL } from '@/entrypoints/dashboard/views/Support'
import { Icon } from '@/ui/Icon'
import { useNow } from '@/ui/hooks'
import { useMemo } from 'react'

export function Credit() {
	const now = useNow(60_000)
	// Fixed for the life of this card, so nothing flickers while you read it —
	// and different the next time one opens.
	const seed = useMemo(paintSeed, [])

	const colour = heartColour(now, seed)
	const p = pitch(now, { source: SOURCE_URL, sponsor: SPONSOR_URL, author: AUTHOR_URL, name: AUTHOR }, seed)
	return (
		<div className="wp-credit wp-small wp-fade-in">
			<a className="wp-link wp-muted wp-row" href={SOURCE_URL} target="_blank" rel="noreferrer" title="WorkPulse on GitHub" aria-label="WorkPulse on GitHub">
				<Icon name="github" size={14} />
			</a>
			<span className="wp-muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
				{p.text}
			</span>
			<a className="wp-link" href={p.href} target="_blank" rel="noreferrer" style={{ color: colour }}>
				{p.cta}
			</a>
			<a className="wp-link" href={SPONSOR_URL} target="_blank" rel="noreferrer" title="Sponsor WorkPulse" aria-label="Sponsor WorkPulse" style={{ color: colour }}>
				♥
			</a>
		</div>
	)
}
