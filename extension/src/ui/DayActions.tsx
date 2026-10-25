// Check in, check out, and "remind me now" — one component so the popup and
// the dashboard always offer the same thing. Which buttons appear follows the
// day: you are never shown a check-out before you have checked in, and the
// confirm buttons replace them while Zoho is open and waiting for your punch.

import type { TodayState } from '@/background/commands'
import { fmtMinutes, istTime, MIN } from '@/core/time'
import { useState } from 'react'

import { call } from '@/lib/rpc'
import { useAction, useNow } from '@/ui/hooks'

/** Where the day stands, in the words you actually care about. */
export function DayClock({ s }: { s: TodayState }) {
	const now = useNow(30_000)
	const { day } = s
	if (day.isOff || day.checkedInAt == null) return null
	const until = day.checkedOutAt ?? now
	const elapsed = Math.max(0, Math.round((until - day.checkedInAt) / MIN))
	const target = s.settings.minHours * 60
	const left = target - elapsed
	return (
		<div className="wp-row-wrap wp-small">
			<span>
				In at <strong>{istTime(day.checkedInAt)}</strong>
				{day.checkedOutAt != null && <> · out at <strong>{istTime(day.checkedOutAt)}</strong></>}
			</span>
			<span className="wp-muted">·</span>
			<span>
				<strong className="wp-num">{fmtMinutes(elapsed)}</strong> {day.checkedOutAt != null ? 'on the clock' : 'so far'}
			</span>
			{left > 0 ? (
				<span className="wp-chip wp-chip-warn">
					{fmtMinutes(left)} {day.checkedOutAt != null ? `short of ${s.settings.minHours}h` : `to ${s.settings.minHours}h`}
				</span>
			) : (
				<span className="wp-chip wp-chip-ok">
					<span className="wp-dot" /> {s.settings.minHours}h complete
				</span>
			)}
		</div>
	)
}

export function DayActions({ s, compact, onAct }: { s: TodayState; compact?: boolean; onAct?: () => void }) {
	const { busy, error, run } = useAction()
	const [matched, setMatched] = useState<string | null>(null)
	const { day } = s
	const act = <T,>(fn: () => Promise<T>) => run(async () => {
		const out = await fn()
		onAct?.()
		return out
	})

	const checkedIn = day.checkedInAt != null
	const checkedOut = day.checkedOutAt != null
	const size = compact ? '' : ' wp-btn-lg'
	const full = s.settings.zohoMode === 'full'
	const viaApi = full && s.hasZoho && !s.roleBlocked
	/** Full mode can punch from here, through the API or through Zoho's own page call. */
	const punchHere = full

	if (day.isOff) {
		return (
			<div className="wp-row-wrap">
				<span className="wp-chip">Day off — no reminders</span>
				<button className="wp-action wp-small" disabled={busy} onClick={() => act(() => call('refreshAttendance'))}>
					Check Zoho again
				</button>
			</div>
		)
	}

	return (
		<div className="wp-stack-sm">
			<DayClock s={s} />
			<div className="wp-row-wrap">
				{s.awaiting ? (
					<>
						<button className={`wp-btn wp-btn-primary${size}`} disabled={busy} onClick={() => act(() => call('confirmAttendance', s.awaiting!))}>
							I&rsquo;ve checked {s.awaiting === 'in' ? 'in' : 'out'}
						</button>
						<button className={`wp-btn${size}`} disabled={busy} onClick={() => act(() => call('openZoho'))}>
							Open Zoho again
						</button>
					</>
				) : !checkedIn ? (
					<button className={`wp-btn wp-btn-primary${size}`} disabled={busy} onClick={() => act(() => call('checkIn'))}>
						{viaApi ? 'Check in now' : 'Check in on Zoho'}
					</button>
				) : !checkedOut ? (
					<button className={`wp-btn wp-btn-primary${size}`} disabled={busy} onClick={() => act(() => call('checkOut'))}>
						{viaApi ? 'Check out now' : 'Check out on Zoho'}
					</button>
				) : (
					// Zoho allows another punch after a check-out, so the way back in is here.
					<>
						<span className="wp-chip wp-chip-ok">
							<span className="wp-dot" /> Checked out
						</span>
						<button className={`wp-btn${size}`} disabled={busy} onClick={() => act(() => call('checkIn'))}>
							{punchHere ? 'Check in again' : 'Check in again on Zoho'}
						</button>
					</>
				)}

				<button className={`wp-btn${size}`} disabled={busy} onClick={() => act(() => call('logNow'))}>
					Log an hour
				</button>
				{day.timelogStatus === 'pending' && (
					<button className={`wp-btn${size}`} disabled={busy} onClick={() => act(() => call('openDashboard', 'review'))}>
						Timesheet
					</button>
				)}
			</div>

			{/* The point of the whole app: when you know you will forget, make it unmissable. */}
			<div className="wp-row-wrap wp-small">
				<span className="wp-muted">Force the reminder:</span>
				{!checkedIn && (
					<button className="wp-action" disabled={busy} onClick={() => act(() => call('forceReminder', 'checkin'))}>
						check-in
					</button>
				)}
				<button className="wp-action" disabled={busy} onClick={() => act(() => call('forceReminder', 'prompt'))}>
					log this hour
				</button>
				{day.timelogStatus === 'pending' && (
					<button className="wp-action" disabled={busy} onClick={() => act(() => call('forceReminder', 'wrapup'))}>
						timesheet
					</button>
				)}
				{s.snoozeUntil != null && s.snoozeUntil > s.now && <span className="wp-chip wp-chip-warn">snoozed — forcing clears it</span>}
			</div>

			{/* A role Zoho refuses the API to is not a fault to report: say what is happening instead. */}
			{s.roleBlocked && (
				<div className="wp-muted wp-small">
					Reading your own Zoho People tab, since your role has no API access yet.{' '}
					<button
						className="wp-action"
						disabled={busy}
						title="Read your Zoho tab and make today agree with it"
						onClick={() =>
							run(async () => {
								const r = await call('matchZoho')
								// Say what it read. "It cleared everything" was all anyone
								// could tell before, which is the least useful half of it.
								setMatched(
									r.read.firstIn
										? `Zoho says in ${r.read.firstIn}${r.read.lastOut ? `, out ${r.read.lastOut}` : ' (still in)'} — matched, read from ${r.read.source === 'endpoint' ? "Zoho's own call" : 'the page'}.`
										: `Could not find a punch on your Zoho tab${r.read.missing.length ? ` — ${r.read.missing.join(' and ')} not on the page` : ''}. Nothing was changed.`,
								)
							})
						}
					>
						Match Zoho now
					</button>
					{!punchHere && <> · punching from here needs Full mode in Settings.</>}
					{matched && <div className={matched.startsWith('Zoho says') ? 'wp-ok-text wp-small' : 'wp-warn-text wp-small'}>{matched}</div>}
				</div>
			)}
			{error && <div className="wp-error">{error}</div>}
		</div>
	)
}
