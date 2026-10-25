// The day, as one bar.
//
// This is the reward half of the habit. The cue is the card and the routine is
// one sentence, but until now nothing showed the thing you were doing it for:
// a day that fills up. The same bar is drawn on the dashboard, in the widget
// and on the card itself, so logging an hour moves something you recognise
// wherever you happen to be looking.
//
// Amber while there is a gap, green when there is not. Nothing animates, and
// nothing congratulates you.

import { fmtMinutes } from '@/core/time'

export function DayBar({
	logged,
	target,
	elapsed,
	compact,
}: {
	logged: number
	/** The hours the day is meant to be. */
	target: number
	/** Minutes since check-in, which is what the gap is measured against. */
	elapsed?: number
	compact?: boolean
}) {
	const against = Math.max(target, elapsed ?? 0, 1)
	const gap = Math.max(0, Math.min(elapsed ?? target, target) - logged)
	const done = Math.min(1, logged / against)
	const mark = Math.min(1, target / against)

	return (
		<div className="wp-stack-sm">
			<div className="wp-bar" role="img" aria-label={`${fmtMinutes(logged)} logged of ${fmtMinutes(target)}`}>
				<span className={gap >= 30 ? 'wp-bar-fill wp-bar-gap' : 'wp-bar-fill'} style={{ width: `${done * 100}%` }} />
				{/* Where the day is meant to reach, when you have gone past it. */}
				{mark < 1 && <i className="wp-bar-mark" style={{ left: `${mark * 100}%` }} />}
			</div>
			{!compact && (
				<div className="wp-between wp-small">
					<span className="wp-muted">{fmtMinutes(logged)} logged</span>
					{gap >= 1 ? <span className="wp-warn-text">{fmtMinutes(gap)} not logged</span> : <span className="wp-ok-text">nothing missing</span>}
				</div>
			)}
		</div>
	)
}

/**
 * The fortnight behind today: one mark a day, so a run is something you can
 * see rather than a number you are told.
 */
export function DayStrip({ days, today }: { days: { date: string; done: boolean; off: boolean }[]; today: string }) {
	return (
		<div className="wp-strip" role="img" aria-label="The last two weeks">
			{days.map((d) => (
				<span
					key={d.date}
					className={`wp-pip${d.off ? ' wp-pip-off' : d.done ? ' wp-pip-done' : ' wp-pip-gap'}${d.date === today ? ' wp-pip-today' : ''}`}
					title={`${d.date}${d.off ? ' · not a working day' : d.done ? ' · complete' : ' · something missing'}`}
				/>
			))}
		</div>
	)
}
