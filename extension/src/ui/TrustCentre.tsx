// The panel that makes "deliberately useless as a surveillance tool" checkable.
//
// It is the strongest thing about this product and, until now, entirely
// invisible: somebody wary of being watched had no way to satisfy themselves
// short of reading the source. So this is live rather than documented — every
// row is the real current state, and the two buttons at the bottom work.
//
// The order matters. Take it with you, then go: the export sits above the
// delete, so the honest sequence is the obvious one.

import { useState } from 'react'

import { call } from '@/lib/rpc'
import { Icon } from '@/ui/Icon'
import { Panel } from '@/ui/Panel'
import { useAction, useLive } from '@/ui/hooks'

/** Downloads are a plain anchor: an extension page can do it with no permission. */
function save(name: string, text: string) {
	const url = URL.createObjectURL(new Blob([text], { type: name.endsWith('.json') ? 'application/json' : 'text/plain' }))
	const a = document.createElement('a')
	a.href = url
	a.download = name
	a.click()
	setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function TrustCentre() {
	const { data, reload } = useLive(() => call('trustState'))
	const { busy, error, run } = useAction()
	const [said, setSaid] = useState('')
	const [armed, setArmed] = useState(false)
	if (!data) return null

	return (
		<Panel
			title="What WorkPulse can see"
			hint="Every permission, what it is for, and everything written down"
			keywords="privacy permissions trust data export delete surveillance monitoring what can it see gdpr local"
		>
			<div className="wp-stack">
				<p className="wp-small" style={{ margin: 0, maxWidth: 580 }}>
					{data.line}
				</p>

				<div>
					<span className="wp-eyebrow">Held from the moment it was installed</span>
					<div className="wp-stack-sm" style={{ marginTop: 8 }}>
						{data.always.map((c) => (
							<div key={c.id} className="wp-card-flat wp-small">
								<div className="wp-between">
									<b>{c.label}</b>
									<span className="wp-chip wp-chip-ok">
										<span className="wp-dot" /> on
									</span>
								</div>
								<div className="wp-muted">{c.does}</div>
								<div className="wp-faint" style={{ marginTop: 3 }}>
									{c.why}
								</div>
							</div>
						))}
					</div>
				</div>

				<div>
					<span className="wp-eyebrow">Asked for only when a feature first needs it</span>
					<div className="wp-stack-sm" style={{ marginTop: 8 }}>
						{data.onRequest.map((c) => (
							<div key={c.id} className="wp-card-flat wp-small">
								<div className="wp-between">
									<b>{c.label}</b>
									{c.granted ? (
										<button
											className="wp-action wp-muted"
											disabled={busy}
											title="Take this permission back"
											onClick={() => run(async () => void (await chrome.permissions.remove({ permissions: [c.id] }), await reload()))}
										>
											allowed · take it back
										</button>
									) : (
										<span className="wp-muted">never asked for</span>
									)}
								</div>
								<div className="wp-muted">{c.does}</div>
								<div className="wp-faint" style={{ marginTop: 3 }}>
									{c.why}
								</div>
							</div>
						))}
					</div>
				</div>

				<div>
					<span className="wp-eyebrow">Never, in any build</span>
					<ul className="wp-stack-sm wp-small" style={{ margin: '8px 0 0', paddingLeft: 0, listStyle: 'none' }}>
						{data.never.map((n) => (
							<li key={n} className="wp-row">
								<span className="wp-ok-text">✕</span>
								<span className="wp-muted">{n}</span>
							</li>
						))}
					</ul>
				</div>

				<div>
					<span className="wp-eyebrow">What is written down, and where</span>
					<div className="wp-grid-3" style={{ marginTop: 8 }}>
						{data.holding.map((h) => (
							<div key={h.label} className="wp-stat">
								<span className="wp-big wp-num">{h.count}</span>
								<span className="wp-small">{h.label}</span>
								<span className="wp-faint wp-small">{h.where}</span>
							</div>
						))}
					</div>
				</div>

				{/* Take it with you, then go. In that order, deliberately. */}
				<div className="wp-row-wrap">
					<button
						className="wp-btn wp-btn-sm"
						disabled={busy}
						onClick={() =>
							run(async () => {
								for (const f of await call('exportAll')) save(f.name, f.text)
								setSaid('Downloaded — JSON, CSV and Markdown.')
							})
						}
					>
						<Icon name="archive" size={13} /> Export everything
					</button>

					{armed ? (
						<button
							className="wp-btn wp-btn-sm wp-btn-danger"
							disabled={busy}
							onClick={() => run(async () => void (await call('deleteEverything'), (location.hash = '#/today'), location.reload()))}
						>
							Yes — delete it all now
						</button>
					) : (
						<button className="wp-action wp-muted" disabled={busy} onClick={() => setArmed(true)}>
							<Icon name="trash" size={13} /> Delete everything
						</button>
					)}
					{armed && <span className="wp-muted wp-small">No soft delete, no retention period. It will be gone.</span>}
					{said && <span className="wp-ok-text wp-small">{said}</span>}
				</div>
				{error && <span className="wp-error wp-small">{error}</span>}
			</div>
		</Panel>
	)
}
