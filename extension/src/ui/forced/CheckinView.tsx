import { call } from '@/lib/rpc'
import { Art } from '@/ui/Art'
import { Brand } from '@/ui/Brand'
import { useAction } from '@/ui/hooks'

export interface CheckinCtx {
	awaiting?: 'in' | 'out'
	hasZoho: boolean
	mode: string
	shiftStart: string
	lastError?: string
}

export function CheckinView({ ctx, blocking }: { ctx: CheckinCtx; blocking: boolean }) {
	const { busy, error, run } = useAction()
	const viaApi = ctx.mode === 'full'

	return (
		<div className="wp-stack">
			<div className="wp-between">
				<Brand />
				<span className="wp-eyebrow">{blocking ? 'Check-in overdue' : 'Good morning'}</span>
			</div>
			<Art name="checkin" size={88} />
			<div>
				<h1 className="wp-title">{blocking ? 'Check in to Zoho People' : 'Ready to start?'}</h1>
				<div className="wp-muted">
					{blocking ? `Your shift started at ${ctx.shiftStart} and Zoho has no check-in yet.` : `Your shift starts at ${ctx.shiftStart}. Check in when you begin.`}
				</div>
			</div>

			{ctx.awaiting === 'in' ? (
				<>
					<div className="wp-banner">Zoho People is open in a tab — click Check in there.</div>
					<div className="wp-muted wp-small">
						{ctx.hasZoho ? 'WorkPulse watches Zoho and closes this once it sees your check-in.' : 'Confirm here once you have checked in.'}
					</div>
					<div className="wp-row-wrap">
						<button className="wp-btn wp-btn-primary" disabled={busy} onClick={() => run(() => call('confirmAttendance', 'in'))}>
							I've checked in
						</button>
						<button className="wp-btn" disabled={busy} onClick={() => run(() => call('openZoho'))}>
							Open Zoho again
						</button>
						{ctx.hasZoho && (
							<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('refreshAttendance'))}>
								Check now
							</button>
						)}
					</div>
				</>
			) : (
				<div className="wp-row-wrap">
					<button className="wp-btn wp-btn-primary wp-btn-lg" disabled={busy} onClick={() => run(() => call('checkIn'))}>
						{viaApi ? 'Check in now' : 'Check in on Zoho'}
					</button>
					<button className="wp-btn wp-btn-lg" disabled={busy} onClick={() => run(() => call('markOff'))}>
						Not working today
					</button>
					{blocking ? (
						<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('snooze'))}>
							Snooze 10 min
						</button>
					) : (
						<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('dismiss'))}>
							Later
						</button>
					)}
				</div>
			)}

			{(error || ctx.lastError) && <div className="wp-error">{error ?? ctx.lastError}</div>}
			{!viaApi && !ctx.awaiting && <div className="wp-muted wp-small">Reminder mode: WorkPulse opens Zoho and you click Check in there. It never checks in for you.</div>}
		</div>
	)
}
