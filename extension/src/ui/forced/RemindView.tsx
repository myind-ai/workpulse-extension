// A reminder you set for yourself: water, a tablet, a call back, a link to
// return to. Its own card, because "What did you work on?" is the wrong
// question for "drink some water".

import { call } from '@/lib/rpc'
import { Art } from '@/ui/Art'
import { Brand } from '@/ui/Brand'
import { useAction } from '@/ui/hooks'

export interface RemindCtx {
	uid: string
	title: string
	url?: string
	/** Minutes between repeats, when it is a recurring one. */
	repeatMinutes?: number
	/** What else is open, so the alarm is a moment to act rather than dismiss. */
	tasks: { uid: string; title: string; key?: string }[]
}

export function RemindView({ ctx }: { ctx: RemindCtx }) {
	const { busy, error, run } = useAction()

	return (
		<div className="wp-stack">
			<div className="wp-between">
				<Brand />
				<span className="wp-eyebrow">Reminder</span>
			</div>
			<Art name="remind" size={88} />

			<h1 className="wp-title" style={{ lineHeight: 1.25 }}>
				{ctx.title}
			</h1>
			{ctx.repeatMinutes ? <div className="wp-muted">Comes back every {ctx.repeatMinutes} minutes.</div> : null}

			{ctx.url && (
				<a className="wp-btn wp-btn-block" href={ctx.url} target="_blank" rel="noreferrer">
					Open what you saved ↗
				</a>
			)}

			<div className="wp-row-wrap">
				<button className="wp-btn wp-btn-primary wp-btn-lg" disabled={busy} onClick={() => run(() => call('answerReminder', ctx.uid, 'done'))}>
					Done
				</button>
				{[5, 10, 30].map((m) => (
					<button key={m} className="wp-btn" disabled={busy} onClick={() => run(() => call('answerReminder', ctx.uid, 'snooze', m))}>
						{m} min
					</button>
				))}
				<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('answerReminder', ctx.uid, 'stop'))}>
					{ctx.repeatMinutes ? 'Stop repeating' : 'Stop reminding me'}
				</button>
			</div>

			{/* While you are here: the rest of what is open. */}
			{ctx.tasks.length > 0 && (
				<div className="wp-card-flat wp-stack-sm wp-small wp-scroll-sm">
					<span className="wp-eyebrow">Still open</span>
					{ctx.tasks.slice(0, 5).map((t) => (
						<div key={t.uid} className="wp-between">
							<span className="wp-grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								{t.key && <span className="wp-muted">{t.key} · </span>}
								{t.title}
							</span>
							<button className="wp-btn wp-btn-sm wp-btn-soft" disabled={busy} onClick={() => run(() => call('answerTask', t.uid, 'done'))}>
								Done
							</button>
						</div>
					))}
				</div>
			)}
			{error && <div className="wp-error">{error}</div>}
		</div>
	)
}
