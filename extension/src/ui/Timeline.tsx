// The day end to end, gaps included.
//
// A list of entries hides a gap, because a gap is an absence of rows and an
// absence of rows looks like the end of the list. Drawn as a bar, the two
// missing hours on Tuesday afternoon are the first thing you see — which is
// the point, since they are the only part of the day anybody needs to act on.

import { gapLabel, type Segment } from '@/core/timeline'
import { fmtMinutes, istTime } from '@/core/time'
import { call } from '@/lib/rpc'
import { useLive } from '@/ui/hooks'

const TONE: Record<Segment['kind'], string> = {
	work: 'wp-tl-work',
	break: 'wp-tl-break',
	away: 'wp-tl-away',
	gap: 'wp-tl-gap',
}

export function Timeline({ date }: { date: string }) {
	const { data } = useLive(() => call('dayTimeline', date), [date])
	if (!data || !data.segments.length) return null
	const total = data.logged + data.gap || 1

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<div>
					<span className="wp-eyebrow">The day, end to end</span>
					<h2 className="wp-h2">
						{data.share}% accounted for
						{data.gap > 0 && <span className="wp-muted"> · {fmtMinutes(data.gap)} with nothing against it</span>}
					</h2>
				</div>
			</div>

			{/* One bar, to scale. A gap you can see is a gap you will fill in. */}
			<div className="wp-tl" role="img" aria-label={`${data.share}% of the day has something logged against it`}>
				{data.segments.map((s) => (
					<span key={`${s.from}-${s.kind}`} className={`wp-tl-seg ${TONE[s.kind]}`} style={{ flexGrow: s.minutes / total }} title={`${istTime(s.from)}–${istTime(s.to)} · ${s.text ?? s.kind}`} />
				))}
			</div>

			<div className="wp-stack-sm wp-small">
				{data.segments
					.filter((s) => s.kind === 'gap' || s.kind === 'away')
					.map((s) => (
						<div key={`${s.from}-row`} className="wp-row">
							<span className="wp-num wp-muted" style={{ minWidth: 92 }}>
								{istTime(s.from)}–{istTime(s.to)}
							</span>
							<span className={s.kind === 'gap' ? 'wp-warn-text' : 'wp-muted'}>
								{s.kind === 'gap' ? gapLabel(s.minutes) : 'Away from the machine'}
							</span>
							<span className="wp-muted wp-grow" style={{ textAlign: 'right' }}>
								{fmtMinutes(s.minutes)}
							</span>
						</div>
					))}
				{data.gap === 0 && <span className="wp-ok-text">Every hour of this day has something written against it.</span>}
			</div>
		</section>
	)
}
