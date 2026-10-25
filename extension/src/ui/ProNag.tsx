// The one line a local Pro feature is allowed to say.
//
// It never covers the feature, never blocks it and never appears twice: the
// dismissal is remembered per feature, so somebody who has read it about the
// six-month record does not read it again about overtime next week.
//
// Deliberately quiet. A free tier that shouts is a free tier people resent, and
// the whole argument for charging is that the thing is already useful.

import { useState } from 'react'

import { gate, type Gated, type Licence } from '@/core/licence'
import { Icon } from '@/ui/Icon'

const seen = (key: string): boolean => {
	try {
		return localStorage.getItem(key) === 'off'
	} catch {
		// A private window answers nothing. Showing the line once more is a
		// smaller fault than never showing it.
		return false
	}
}

export function ProNag({ feature, licence }: { feature: Gated; licence: Licence | undefined }) {
	const v = gate(feature, licence)
	const [hidden, setHidden] = useState(() => !v.nagKey || seen(v.nagKey))
	if (!v.nag || hidden) return null

	const dismiss = () => {
		setHidden(true)
		try {
			if (v.nagKey) localStorage.setItem(v.nagKey, 'off')
		} catch {
			// Nothing to remember it with; it will ask again next time.
		}
	}

	return (
		<div className="wp-nag wp-row wp-small">
			<Icon name="bulb" size={14} />
			<span className="wp-grow">{v.nag}</span>
			<a className="wp-link wp-link-out" href="https://github.com/sponsors" target="_blank" rel="noreferrer">
				Pro
			</a>
			<button className="wp-action wp-muted" title="Hide this — it will not come back" onClick={dismiss}>
				<Icon name="check" size={12} />
			</button>
		</div>
	)
}
