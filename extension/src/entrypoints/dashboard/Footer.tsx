// The footer every page carries. One quiet line: who made it, that it is open,
// and where to sponsor it. Always present so it is never a surprise, never
// animated, never in the way of the work above it.

import { heartColour } from '@/core/brand'
import { Icon } from '@/ui/Icon'
import { useNow } from '@/ui/hooks'

import { AUTHOR, AUTHOR_URL, SOURCE_URL, SPONSOR_URL } from './views/Support'

export function Footer() {
	const version = chrome.runtime.getManifest?.().version ?? ''
	// A heart that is a different colour each hour: the same for everyone at the
	// same hour, so it reads as a clock rather than as something flashing at you.
	const now = useNow(60_000)
	return (
		<footer className="wp-foot">
			<span>
				WorkPulse{version && <span className="wp-muted"> {version}</span>} — made by{' '}
				<a className="wp-link" href={AUTHOR_URL} target="_blank" rel="noreferrer">
					{AUTHOR}
				</a>
			</span>
			<span className="wp-foot-links">
				<a className="wp-link wp-row" href={SOURCE_URL} target="_blank" rel="noreferrer" title="WorkPulse on GitHub">
					<Icon name="github" size={13} /> Source
				</a>
				<a className="wp-link" href={`${SOURCE_URL}/issues/new`} target="_blank" rel="noreferrer">
					Report an issue
				</a>
				<a className="wp-link" href={SPONSOR_URL} target="_blank" rel="noreferrer">
					<span style={{ color: heartColour(now) }}>♥</span> Sponsor
				</a>
			</span>
		</footer>
	)
}

/** The sidebar's own corner of it, where there is room for two words. */
export function SideFoot() {
	const now = useNow(60_000)
	return (
		<div className="wp-side-links">
			<a className="wp-link" href={AUTHOR_URL} target="_blank" rel="noreferrer">
				{AUTHOR}
			</a>
			<span>
				<a className="wp-link" href={SOURCE_URL} target="_blank" rel="noreferrer">
					Source
				</a>
				{' · '}
				<a className="wp-link" href={SPONSOR_URL} target="_blank" rel="noreferrer">
					<span style={{ color: heartColour(now) }}>♥</span> Sponsor
				</a>
			</span>
		</div>
	)
}
