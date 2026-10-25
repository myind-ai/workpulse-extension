// What the week cost, and who spent it.
//
// Two numbers nobody has: which meeting specifically, and what broke the
// blocks. "Nine hours of meetings" changes nothing — everybody already
// suspects that. "Sprint review is 46 hours a year" is a thing you can take to
// the person who runs it on Thursday.

import { call } from '@/lib/rpc'
import { useLive } from '@/ui/hooks'

export function WeekCost() {
	const { data } = useLive(() => call('weekCost'))
	if (!data) return null
	const { meetingLine: mline, interrupted: broke, recovery, meetings } = data
	// Nothing worth saying is not a panel.
	if (!mline && !broke.line) return null

	return (
		<section className="wp-card wp-stack-sm">
			<span className="wp-eyebrow">What the week cost</span>

			{mline && (
				<div className="wp-stack-sm">
					<p className="wp-small" style={{ margin: 0 }}>
						{mline}
					</p>
					{meetings.length > 1 && (
						<div className="wp-row-wrap wp-small">
							{meetings.slice(1, 4).map((m) => (
								<span key={m.id} className="wp-chip">
									{m.name} <span className="wp-muted wp-num">· {m.perYear}h/yr</span>
								</span>
							))}
						</div>
					)}
				</div>
			)}

			{broke.line && (
				<div className="wp-stack-sm">
					<p className="wp-small" style={{ margin: 0 }}>
						{broke.line}
					</p>
					<div className="wp-row-wrap wp-small">
						{broke.by.map((b) => (
							<span key={b.what} className={b.what === 'Myself' ? 'wp-chip wp-chip-accent' : 'wp-chip'}>
								{b.what} <span className="wp-muted wp-num">· {b.times}</span>
							</span>
						))}
					</div>
					{recovery.line && (
						<p className="wp-faint wp-small" style={{ margin: 0 }}>
							{recovery.line}
						</p>
					)}
				</div>
			)}
		</section>
	)
}
