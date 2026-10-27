// Pick up where you left off.
//
// The next action written when work stopped — in the palette's Save context, on
// the Brain page, or by Claude Code at the end of a session — is the one line
// that makes coming back cheap. This puts the newest one per ticket where the
// day starts, with the ticket's tabs one click away when there is a ticket.

import { prettyDate, istDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { useAction, useLive } from '@/ui/hooks'

export function Resume({ limit = 4 }: { limit?: number }) {
	const { data } = useLive(() => call('bridge'))
	const open = (data?.on ? data.open : []).slice(0, limit)
	const keys = open.map((o) => o.ticket).filter((k): k is string => !!k)
	const { data: tickets } = useLive(() => (keys.length ? call('brainTickets', keys) : Promise.resolve({} as Record<string, string | null>)), [keys.join(',')])
	const { busy, run } = useAction()
	if (!open.length) return null

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<h2 className="wp-h2">Pick up where you left off</h2>
				<a className="wp-link wp-small" href="#/brain">
					Brain
				</a>
			</div>
			{open.map((o) => {
				const ticketId = o.ticket ? tickets?.[o.ticket] : null
				return (
					<div key={o.key} className="wp-between wp-small">
						<span className="wp-grow" style={{ minWidth: 0 }}>
							<strong>{o.key}</strong> <span className="wp-muted">{o.title.startsWith(o.key) ? o.title.slice(o.key.length).replace(/^[\s:—-]+/, '') : o.title}</span>
							<br />
							<span>Next: {o.next[0]}</span>
							{o.next.length > 1 && <span className="wp-muted"> (+{o.next.length - 1})</span>}
						</span>
						<span className="wp-row">
							<span className="wp-muted">{prettyDate(istDate(o.at))}</span>
							{ticketId ? (
								<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('openWorkspace', ticketId, []))} title="Open this ticket’s tabs together">
									Resume
								</button>
							) : (
								<a className="wp-btn wp-btn-sm" href={`#/brain/${encodeURIComponent(o.ticket ?? '')}`}>
									Open
								</a>
							)}
						</span>
					</div>
				)
			})}
		</section>
	)
}
