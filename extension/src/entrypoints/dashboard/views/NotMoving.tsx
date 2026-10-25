// Work that is not moving.
//
// Two kinds, and they feel different: what you finished and somebody else has
// not looked at, and what you started and walked away from. Neither is a
// telling-off. Both are facts with dates on them, and the first is the only
// number in the app that is really about somebody else.

import { fmtMinutes } from '@/core/time'
import { call } from '@/lib/rpc'
import { Icon } from '@/ui/Icon'
import { useAction, useLive } from '@/ui/hooks'

export function NotMoving({ compact }: { compact?: boolean }) {
	const { data, reload } = useLive(() => call('notMoving'))
	const { busy, run } = useAction()
	if (!data) return null
	const { waiting, stale, quiet } = data
	if (!waiting.length && !stale.length && !quiet.length) return null

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<h2 className="wp-h2">Not moving</h2>
				{data.lostMinutes > 0 && (
					<span className="wp-muted wp-small" title="Finished work, in the hours you were at your desk waiting">
						{fmtMinutes(data.lostMinutes)} of your work is finished and waiting
					</span>
				)}
			</div>

			{/* Waiting on somebody else. "Here for" is the part that matters: three
			    days over a weekend is not the same complaint as three at your desk. */}
			{waiting.map((w) => (
				<div key={w.key ?? w.title} className="wp-between wp-small">
					<span className="wp-grow" style={{ minWidth: 0 }}>
						<span className="wp-chip wp-chip-warn">waiting</span> <strong>{w.key ?? w.title}</strong>
						{w.key && <span className="wp-muted"> {w.title}</span>}
					</span>
					<span className="wp-muted">
						{w.hereDays || w.days} working day{(w.hereDays || w.days) === 1 ? '' : 's'}
						{w.minutes ? ` · ${fmtMinutes(w.minutes)} in it` : ''}
					</span>
				</div>
			))}

			{!compact && !!stale.length && (
				<>
					<span className="wp-eyebrow" style={{ marginTop: 6 }}>Started and stopped</span>
					{stale.slice(0, 5).map((t) => (
						<div key={t.id} className="wp-between wp-small">
							<a className="wp-link wp-grow" href={`#/links/${t.id}`} style={{ minWidth: 0 }}>
								{t.name}
								<span className="wp-muted">
									{' '}
									· {t.links} link{t.links === 1 ? '' : 's'}
									{t.notes ? `, ${t.notes} note${t.notes === 1 ? '' : 's'}` : ''}
									{t.minutes ? `, ${fmtMinutes(t.minutes)} logged` : ', never started'}
								</span>
							</a>
							<span className="wp-row">
								<span className="wp-muted">{t.quietDays} days quiet</span>
								<button
									className="wp-icon-btn"
									disabled={busy}
									title="Put it away — everything in it is kept"
									aria-label={`Archive ${t.name}`}
									onClick={() => run(async () => void (await call('archiveTicket', t.id, true), await reload()))}
								>
									<Icon name="archive" size={13} />
								</button>
							</span>
						</div>
					))}
				</>
			)}

			{/* The no-API half of "that PR has been open nine days": the link you
			    saved, and your own silence since. */}
			{!compact && !!quiet.length && (
				<>
					<span className="wp-eyebrow" style={{ marginTop: 6 }}>Open, and quiet</span>
					{quiet.slice(0, 5).map((q) => (
						<div key={q.url} className="wp-between wp-small">
							<a className="wp-link wp-grow" href={q.url} target="_blank" rel="noreferrer" style={{ minWidth: 0 }}>
								{q.title} <span className="wp-muted">· {q.ticket}</span>
							</a>
							<span className="wp-muted">
								saved {q.days}d ago · nothing logged for {q.quietDays}d
							</span>
						</div>
					))}
				</>
			)}
		</section>
	)
}
