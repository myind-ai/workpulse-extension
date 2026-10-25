// A break, with the countdown that makes it a break rather than a message you
// dismiss. Nothing is forced: every one of these can be skipped, and skipping is
// not recorded anywhere that judges you.

import { useEffect, useState } from 'react'

import type { Pending } from '@/core/types'
import { call } from '@/lib/rpc'
import { Art } from '@/ui/Art'
import { Brand } from '@/ui/Brand'
import { useAction } from '@/ui/hooks'

export function HealthView({ pending }: { pending: Pending }) {
	const total = pending.seconds ?? 0
	const [left, setLeft] = useState(total)
	const [note, setNote] = useState('')
	const [kept, setKept] = useState('')
	const { busy, run } = useAction()

	const keep = (showNext: boolean) =>
		run(async () => {
			await call('saveHealthNote', note, { kind: pending.nudge, showNext })
			setNote('')
			setKept(showNext ? 'Saved — you will see it at the next break.' : 'Saved to your health notes.')
		})

	useEffect(() => {
		if (!total) return
		const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000)
		return () => clearInterval(t)
	}, [total])

	const done = () => run(() => call('dismiss'))

	return (
		<div className="wp-stack" style={{ textAlign: 'center' }}>
			<div className="wp-between" style={{ textAlign: 'left' }}>
				<Brand />
				<span className="wp-eyebrow">Break</span>
			</div>

			{/* The picture is the point of a break card: a wall of text is read,
			    and reading is the thing you were asked to stop doing. */}
			<Art name={pending.nudge ?? 'eyes'} size={132} />

			<div>
				<h1 className="wp-title">{pending.title}</h1>
				<div className="wp-muted">{pending.body}</div>
			</div>

			{/* Everything else that came due this minute. One trip away from the
			    desk, one card — rather than three cards queued behind each other. */}
			{!!pending.alsoNudges?.length && (
				<div className="wp-row-wrap" style={{ justifyContent: 'center' }}>
					{pending.alsoNudges.map((a) => (
						<span key={a.kind} className="wp-chip">
							{a.text}
						</span>
					))}
				</div>
			)}

			{/* What you asked to be reminded of last time, said once. */}
			{pending.note && (
				<div className="wp-card-flat wp-small" style={{ textAlign: 'left' }}>
					<span className="wp-eyebrow">You left yourself a note</span>
					<div>{pending.note}</div>
				</div>
			)}

			{/* The countdown is the whole point of an eye break: twenty seconds is
			    only twenty seconds if something is counting them. */}
			{!!total && (
				<div className="wp-stack-sm">
					<div className="wp-big" style={{ fontSize: 44, fontVariantNumeric: 'tabular-nums' }}>
						{left}
					</div>
					<div className="wp-progress" aria-hidden>
						<span style={{ width: `${((total - left) / total) * 100}%` }} />
					</div>
				</div>
			)}

			{/* A break is when you notice these things — tired eyes, a tablet to
			    take, a chair that is wrong. Somewhere to put it, right here. */}
			<div className="wp-stack-sm" style={{ textAlign: 'left' }}>
				<input
					className="wp-input"
					placeholder="Note to self — tired eyes, tablet at 3, raise the screen…"
					value={note}
					onChange={(e) => {
						setNote(e.target.value)
						setKept('')
					}}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && note.trim()) void keep(true)
					}}
					aria-label="A note about this break"
				/>
				{!!note.trim() && (
					<div className="wp-row wp-small">
						<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => keep(true)}>
							Remind me next break
						</button>
						<button className="wp-btn wp-btn-sm wp-btn-ghost" disabled={busy} onClick={() => keep(false)}>
							Just keep it
						</button>
					</div>
				)}
				{kept && <span className="wp-ok-text wp-small">{kept}</span>}
			</div>

			<div className="wp-row" style={{ justifyContent: 'center' }}>
				{pending.nudge === 'water' ? (
					<>
						<button className="wp-btn wp-btn-primary wp-btn-lg" disabled={busy} onClick={() => run(() => call('logWater', 1))}>
							Had a glass
						</button>
						<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={done}>
							Not now
						</button>
					</>
				) : (
					<>
						<button className="wp-btn wp-btn-primary wp-btn-lg" disabled={busy || (!!total && left > 0)} autoFocus onClick={done}>
							{total && left > 0 ? `Back in ${left}s` : 'Back to it'}
						</button>
						<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={done}>
							Skip
						</button>
					</>
				)}
			</div>
		</div>
	)
}
