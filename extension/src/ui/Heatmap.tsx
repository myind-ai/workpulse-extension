// A year of days, the way GitHub draws them: one column per week, Monday at
// the top. Shade follows the hours logged, so a thin week is visible at a
// glance — and clicking a day opens its review, which doubles as the filter
// for looking back at yesterday or any other day.

import { fmtMinutes, istWeekday, prettyDate } from '@/core/time'

export interface Day {
	date: string
	minutes: number
	status: string
	isOff: boolean
}

/** Five steps against the day's target, so the scale means the same for everyone. */
function shade(minutes: number, targetMinutes: number): string {
	if (minutes <= 0) return 'var(--wp-border)'
	const part = minutes / Math.max(1, targetMinutes)
	if (part < 0.25) return 'color-mix(in srgb, var(--wp-accent) 25%, var(--wp-border))'
	if (part < 0.5) return 'color-mix(in srgb, var(--wp-accent) 45%, var(--wp-border))'
	if (part < 0.9) return 'color-mix(in srgb, var(--wp-accent) 70%, var(--wp-border))'
	return 'var(--wp-accent)'
}

export function Heatmap({ days, targetMinutes, onPick }: { days: Day[]; targetMinutes: number; onPick?: (date: string) => void }) {
	if (!days.length) return null
	// Pad the first week so every column starts on a Monday.
	const lead = (istWeekday(new Date(`${days[0].date}T12:00:00Z`).getTime()) + 6) % 7
	const cells: (Day | null)[] = [...Array<null>(lead).fill(null), ...days]
	const weeks: (Day | null)[][] = []
	for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

	const total = days.reduce((a, d) => a + d.minutes, 0)
	const worked = days.filter((d) => d.minutes > 0).length

	return (
		<div className="wp-stack-sm">
			<div className="wp-between wp-small">
				<span className="wp-muted">
					{fmtMinutes(total)} over {worked} day{worked === 1 ? '' : 's'}
				</span>
				<span className="wp-row wp-muted" style={{ gap: 4 }}>
					less
					{[0, 0.2, 0.4, 0.7, 1].map((p) => (
						<span key={p} style={{ width: 10, height: 10, borderRadius: 2, background: shade(p * targetMinutes, targetMinutes) }} />
					))}
					more
				</span>
			</div>
			<div style={{ display: 'flex', gap: 3, overflowX: 'auto', paddingBottom: 4 }}>
				{weeks.map((week, w) => (
					<div key={w} style={{ display: 'grid', gap: 3 }}>
						{Array.from({ length: 7 }, (_, d) => {
							const day = week[d]
							if (!day) return <span key={d} style={{ width: 11, height: 11 }} />
							const title = `${prettyDate(day.date)} · ${day.isOff ? 'day off' : fmtMinutes(day.minutes)}${day.status === 'pushed' ? ' · in Zoho' : ''}`
							return (
								<button
									key={d}
									title={title}
									aria-label={title}
									onClick={() => onPick?.(day.date)}
									style={{
										width: 11,
										height: 11,
										borderRadius: 2,
										padding: 0,
										cursor: onPick ? 'pointer' : 'default',
										border: day.status === 'pushed' ? '1px solid var(--wp-ok)' : '1px solid transparent',
										background: day.isOff ? 'transparent' : shade(day.minutes, targetMinutes),
										outline: day.isOff ? '1px dashed var(--wp-border)' : undefined,
										outlineOffset: -1,
									}}
								/>
							)
						})}
					</div>
				))}
			</div>
		</div>
	)
}
