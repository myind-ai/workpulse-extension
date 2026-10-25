// What WorkPulse has seen of Zoho, area by area.
//
// Zoho People keeps attendance and time logs on different tabs with different
// calls behind them, so "set up Zoho" is not one thing. Recording once sets up
// whichever tab happened to be open; this says which of the four are done, what
// each one gives you, and what stops working without it.

import { ZOHO_AREAS, type AreaId } from '@/core/setup'
import { call } from '@/lib/rpc'
import { Busy } from '@/ui/Busy'
import { useAction, useLive } from '@/ui/hooks'
import { Art } from '@/ui/Art'

export function ZohoAreas() {
	const { data: wiring, reload } = useLive(() => call('wiring'))
	const { data: recording } = useLive(() => call('pageState'))
	const { busy, error, run } = useAction()

	const got: Record<AreaId, boolean> = {
		attendance: !!wiring?.attendance,
		jobs: !!wiring?.tasks,
		save: !!wiring?.save,
		report: !!wiring?.logged,
	}
	const left = ZOHO_AREAS.filter((a) => !got[a.id])

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<div>
					<span className="wp-eyebrow">What WorkPulse has seen of Zoho</span>
					<div className={left.length ? 'wp-muted' : 'wp-ok-text'} style={{ fontWeight: 600 }}>
						{left.length === 0 ? 'All four areas, done.' : `${ZOHO_AREAS.length - left.length} of ${ZOHO_AREAS.length} — ${left.length} left`}
					</div>
				</div>
				<span className="wp-row">
					{recording?.recording ? (
						<button className="wp-btn wp-btn-sm wp-btn-soft" disabled={busy} onClick={() => run(async () => void (await call('stopRecording'), await reload()))}>
							<span className="wp-dot" /> Stop watching
						</button>
					) : (
						<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy} onClick={() => run(() => call('startAutoSetup'))}>
							<Busy busy={busy} doing="Opening Zoho…">Watch Zoho while I click</Busy>
						</button>
					)}
					{busy && <Art name="reading" size={48} delay={400} />}
				</span>
			</div>

			<p className="wp-muted wp-small" style={{ margin: 0 }}>
				Press <strong>Watch Zoho while I click</strong>, then visit the tabs below in Zoho. WorkPulse keeps the calls the page makes so it can read the same things later on its own.
				Nothing is sent anywhere, and the only one it will ever repeat back to Zoho is the timesheet save — from your click.
			</p>

			<div className="wp-stack-sm wp-small">
				{ZOHO_AREAS.map((a) => (
					<div key={a.id} className="wp-area">
						<span aria-hidden className={got[a.id] ? 'wp-ok-text' : 'wp-muted'}>
							{got[a.id] ? '✓' : '○'}
						</span>
						<div style={{ minWidth: 0 }}>
							<div>
								<strong>{a.where}</strong>
								{!a.readOnly && (
									<span className="wp-chip" style={{ marginLeft: 8 }}>
										the one it replays
									</span>
								)}
							</div>
							<div className="wp-muted">{a.gives}</div>
							{!got[a.id] && (
								<div className="wp-muted" style={{ marginTop: 3 }}>
									{a.how} <em>Without it: {a.without.charAt(0).toLowerCase() + a.without.slice(1)}</em>
								</div>
							)}
						</div>
					</div>
				))}
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
		</section>
	)
}
